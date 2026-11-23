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

/** day → "<source>\t<model>" → tokens */
export type ModelDays = Record<string, Record<string, number>>;

/** "claude-opus-5-5" → "Opus 5.5"; other ids (gpt-6-astra, glm-5.3, …) stay as they are. */
export function modelLabel(id: unknown): string {
  if (typeof id !== "string" || !id || id.startsWith("<")) return "unknown";
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id;
  return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

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

function eachLine(path: string, needle: string | string[], fn: (row: any) => void): void {
  const needles = Array.isArray(needle) ? needle : [needle];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (!needles.some((n) => line.includes(n))) continue;
    try {
      fn(JSON.parse(line));
    } catch {
      continue;
    }
  }
}

function add(
  days: TokenDays,
  ts: string | number | undefined,
  src: TokenSource,
  n: number,
  sinceMs: number,
  models?: ModelDays,
  model?: unknown,
): void {
  if (!ts || !Number.isFinite(n) || n <= 0) return;
  const d = new Date(ts);
  if (!(d.getTime() >= sinceMs)) return;
  const key = dayKey(d);
  const day = (days[key] ??= {});
  day[src] = (day[src] ?? 0) + n;
  if (models) {
    const m = (models[key] ??= {});
    const k = `${src}\t${modelLabel(model)}`;
    m[k] = (m[k] ?? 0) + n;
  }
}

/** Pass `models` to also collect tokens per model. */
export function scanTokens(days: number, now = Date.now(), models?: ModelDays): TokenDays {
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
      add(out, row.timestamp, "Claude Code", n, sinceMs, models, m.model);
    });
  }

  for (const sub of ["sessions", "archived_sessions"]) {
    for (const f of jsonlFiles(join(codexHome(), sub), sinceMs, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))) {
      // token_count rows carry no model; the turn_context before them does
      let model: unknown;
      eachLine(f, ['"turn_context"', '"token_count"'], (row) => {
        if (row.type === "turn_context") model = row.payload?.model ?? model;
        const n = row.payload?.info?.last_token_usage?.total_tokens;
        if (row.payload?.type === "token_count") add(out, row.timestamp, "Codex", n, sinceMs, models, model);
      });
    }
  }

  for (const f of jsonlFiles(join(piAgentDir(), "sessions"), sinceMs, (n) => n.endsWith(".jsonl"))) {
    eachLine(f, '"totalTokens"', (row) => {
      const m = row.message;
      if (row.type === "message" && m?.role === "assistant") {
        add(out, row.timestamp ?? m.timestamp, "pi", m.usage?.totalTokens, sinceMs, models, m.model);
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

export function formatTokens(data: TokenDays, days: number, now = Date.now(), models?: ModelDays): string {
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
  const byModel = models ? modelSeries(models, dayList) : [];
  if (byModel.length) {
    lines.push("", "By model");
    for (const m of byModel) {
      const total = m.days.reduce((a, b) => a + b, 0);
      lines.push(`${m.label.padEnd(24)} ${humanTokens(total).padStart(6)}  ${m.source}`);
    }
  }
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

export interface ModelSeries {
  /** "Opus 5.5"; "(pi)" etc. appended only when two agents report the same name */
  label: string;
  source: TokenSource;
  days: number[];
}

export interface TokenSeries {
  generatedAt: string;
  days: string[];
  sources: Record<TokenSource, number[]>;
  /** biggest total first */
  models: ModelSeries[];
}

function modelSeries(models: ModelDays, dayList: string[]): ModelSeries[] {
  const keys = new Set(dayList.flatMap((d) => Object.keys(models[d] ?? {})));
  const out = [...keys].map((k) => {
    const [source, label] = k.split("\t") as [TokenSource, string];
    return { label, source, days: dayList.map((d) => models[d]?.[k] ?? 0) };
  });
  const sum = (m: ModelSeries) => m.days.reduce((a, b) => a + b, 0);
  const count = new Map<string, number>();
  for (const m of out) count.set(m.label, (count.get(m.label) ?? 0) + 1);
  for (const m of out) if (count.get(m.label)! > 1) m.label = `${m.label} (${m.source})`;
  return out.sort((a, b) => sum(b) - sum(a));
}

export function tokenSeries(data: TokenDays, days: number, now = Date.now(), models: ModelDays = {}): TokenSeries {
  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(dayKey(new Date(now - i * 86400_000)));
  const sources = {} as Record<TokenSource, number[]>;
  for (const src of SOURCES) sources[src] = dayList.map((d) => data[d]?.[src] ?? 0);
  return { generatedAt: new Date(now).toISOString(), days: dayList, sources, models: modelSeries(models, dayList) };
}

/** Scanning months of logs takes a second or two; the bar popup reuses a recent result. */
export function cachedTokenSeries(days: number, maxAgeSec: number, force = false): TokenSeries {
  const path = join(cacheDir(), `tokens-${days}d.json`);
  if (!force) {
    try {
      const cached = JSON.parse(readFileSync(path, "utf8")) as TokenSeries;
      const age = (Date.now() - Date.parse(cached.generatedAt)) / 1000;
      if (age >= 0 && age < maxAgeSec && cached.days.at(-1) === dayKey() && Array.isArray(cached.models)) return cached;
    } catch {
      // no cache yet
    }
  }
  const models: ModelDays = {};
  const series = tokenSeries(scanTokens(days, Date.now(), models), days, Date.now(), models);
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(path + ".tmp", JSON.stringify(series));
    renameSync(path + ".tmp", path);
  } catch {
    // cache is best-effort
  }
  return series;
}
