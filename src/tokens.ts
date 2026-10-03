import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dayKey, sparkline } from "./history.ts";
import { cacheDir, claudeProjectsDir, codexHome, piAgentDir } from "./paths.ts";

/**
 * Daily token throughput from the agents' own local session logs — real
 * history that is already on disk, no API calls:
 *   Claude Code  ~/.claude/projects/**\/*.jsonl   assistant message.usage (deduped by message id)
 *   Codex        ~/.codex/sessions/**\/rollout-*.jsonl   token_count.last_token_usage (per-turn delta)
 *   pi           ~/.pi/agent/sessions/**\/*.jsonl   assistant message.usage.totalTokens
 */
export type TokenSource = "Claude Code" | "Codex" | "pi";

/** day → source → tokens */
export type TokenDays = Record<string, Partial<Record<TokenSource, number>>>;

function* jsonlFiles(dir: string, sinceMs: number, match: (name: string) => boolean): Generator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p, sinceMs, match);
    else if (e.isFile() && match(e.name)) {
      try {
        if (statSync(p).mtimeMs >= sinceMs) yield p;
      } catch {
        continue;
      }
    }
  }
}

function eachLine(path: string, needle: string, fn: (row: any) => void): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line.includes(needle)) continue;
    try {
      fn(JSON.parse(line));
    } catch {
      continue;
    }
  }
}

function add(days: TokenDays, ts: string | number | undefined, src: TokenSource, n: number, sinceMs: number): void {
  if (!ts || !Number.isFinite(n) || n <= 0) return;
  const d = new Date(ts);
  if (!(d.getTime() >= sinceMs)) return;
  const day = (days[dayKey(d)] ??= {});
  day[src] = (day[src] ?? 0) + n;
}

export function scanTokens(days: number, now = Date.now()): TokenDays {
  const start = new Date(now - (days - 1) * 86400_000);
  start.setHours(0, 0, 0, 0);
  const sinceMs = start.getTime();
  const out: TokenDays = {};

  const seen = new Set<string>();
  for (const f of jsonlFiles(claudeProjectsDir(), sinceMs, (n) => n.endsWith(".jsonl"))) {
    eachLine(f, '"usage"', (row) => {
      const m = row.message;
      const u = m?.usage;
      if (row.type !== "assistant" || !u) return;
      const id = `${m.id ?? ""}:${row.requestId ?? ""}`;
      if (m.id && seen.has(id)) return;
      seen.add(id);
      const n =
        (u.input_tokens ?? 0) +
        (u.output_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);
      add(out, row.timestamp, "Claude Code", n, sinceMs);
    });
  }

  for (const sub of ["sessions", "archived_sessions"]) {
    for (const f of jsonlFiles(join(codexHome(), sub), sinceMs, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))) {
      eachLine(f, '"token_count"', (row) => {
        const n = row.payload?.info?.last_token_usage?.total_tokens;
        if (row.payload?.type === "token_count") add(out, row.timestamp, "Codex", n, sinceMs);
      });
    }
  }

  for (const f of jsonlFiles(join(piAgentDir(), "sessions"), sinceMs, (n) => n.endsWith(".jsonl"))) {
    eachLine(f, '"totalTokens"', (row) => {
      const m = row.message;
      if (row.type === "message" && m?.role === "assistant") {
        add(out, row.timestamp ?? m.timestamp, "pi", m.usage?.totalTokens, sinceMs);
      }
    });
  }
  return out;
}

export function humanTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(Math.round(n));
}

const SOURCES: TokenSource[] = ["Claude Code", "Codex", "pi"];

export function formatTokens(data: TokenDays, days: number, now = Date.now()): string {
  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(dayKey(new Date(now - i * 86400_000)));
  const lines = [`Local tokens · last ${days} days (input + output + cache)`, ""];
  let grand = 0;
  for (const src of SOURCES) {
    const vals = dayList.map((d) => data[d]?.[src] ?? 0);
    const total = vals.reduce((a, b) => a + b, 0);
    if (total === 0) continue;
    grand += total;
    const max = Math.max(...vals);
    lines.push(
      `${src.padEnd(12)} ${sparkline(vals.map((v) => (v ? v : null)), max)}  total ${humanTokens(total).padStart(6)}  today ${humanTokens(vals[vals.length - 1]!)}`,
    );
  }
  if (grand === 0) lines.push("No session logs found in this range.");
  return lines.join("\n") + "\n";
}

export function tokensCsv(data: TokenDays): string {
  const rows = ["day,source,tokens"];
  for (const d of Object.keys(data).sort()) {
    for (const src of SOURCES) {
      const n = data[d]?.[src];
      if (n) rows.push(`${d},${src},${n}`);
    }
  }
  return rows.join("\n") + "\n";
}

export interface TokenSeries {
  generatedAt: string;
  days: string[];
  sources: Record<TokenSource, number[]>;
}

export function tokenSeries(data: TokenDays, days: number, now = Date.now()): TokenSeries {
  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(dayKey(new Date(now - i * 86400_000)));
  const sources = {} as Record<TokenSource, number[]>;
  for (const src of SOURCES) sources[src] = dayList.map((d) => data[d]?.[src] ?? 0);
  return { generatedAt: new Date(now).toISOString(), days: dayList, sources };
}

/** Scanning months of logs takes a second or two; the bar popup reuses a recent result. */
export function cachedTokenSeries(days: number, maxAgeSec: number, force = false): TokenSeries {
  const path = join(cacheDir(), `tokens-${days}d.json`);
  if (!force) {
    try {
      const cached = JSON.parse(readFileSync(path, "utf8")) as TokenSeries;
      const age = (Date.now() - Date.parse(cached.generatedAt)) / 1000;
      if (age >= 0 && age < maxAgeSec && cached.days.at(-1) === dayKey()) return cached;
    } catch {
      // no cache yet
    }
  }
  const series = tokenSeries(scanTokens(days), days);
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(path + ".tmp", JSON.stringify(series));
    renameSync(path + ".tmp", path);
  } catch {
    // cache is best-effort
  }
  return series;
}
