import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { historyPath, stateDir } from "./paths.ts";
import type { UsageSnapshot } from "./types.ts";

/**
 * Self-recorded utilization history: per local day, per provider window, the
 * peak and a running mean of every fresh reading. Small and uniform across
 * providers; accrues from whenever the bar/timer is running.
 */
export interface DayStat {
  label: string;
  provider: string;
  peak: number;
  sum: number;
  n: number;
}

/** day "YYYY-MM-DD" → "provider/window" → stat */
export type HistoryStore = Record<string, Record<string, DayStat>>;

export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function loadHistory(path = historyPath()): HistoryStore {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HistoryStore;
  } catch {
    return {};
  }
}

export function recordSnapshot(
  store: HistoryStore,
  snapshot: UsageSnapshot,
  keepDays: number,
  now = new Date(),
): HistoryStore {
  const key = dayKey(now);
  const today = (store[key] ??= {});
  for (const p of snapshot.providers) {
    if (!p.ok || p.stale) continue;
    for (const w of p.windows) {
      if (w.usedPercent == null) continue;
      const id = `${p.id}/${w.id}`;
      const s = (today[id] ??= { label: `${p.name} ${w.label}`, provider: p.id, peak: 0, sum: 0, n: 0 });
      s.peak = Math.max(s.peak, w.usedPercent);
      s.sum += w.usedPercent;
      s.n += 1;
    }
  }
  const cutoff = dayKey(new Date(now.getTime() - keepDays * 86400_000));
  for (const d of Object.keys(store)) if (d < cutoff) delete store[d];
  return store;
}

export function appendHistory(snapshot: UsageSnapshot, keepDays: number): void {
  try {
    const store = recordSnapshot(loadHistory(), snapshot, keepDays);
    mkdirSync(stateDir(), { recursive: true });
    const tmp = historyPath() + ".tmp";
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, historyPath());
  } catch {
    // history is best-effort; never break a refresh over it
  }
}

export interface Series {
  id: string;
  label: string;
  days: string[];
  /** daily peak, null where nothing was recorded */
  peaks: (number | null)[];
  means: (number | null)[];
}

export function seriesFor(store: HistoryStore, days: number, now = new Date()): Series[] {
  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    dayList.push(dayKey(new Date(now.getTime() - i * 86400_000)));
  }
  const ids = new Map<string, string>();
  for (const d of dayList) {
    for (const [id, s] of Object.entries(store[d] || {})) ids.set(id, s.label);
  }
  return [...ids.entries()].sort().map(([id, label]) => ({
    id,
    label,
    days: dayList,
    peaks: dayList.map((d) => store[d]?.[id]?.peak ?? null),
    means: dayList.map((d) => {
      const s = store[d]?.[id];
      return s && s.n ? s.sum / s.n : null;
    }),
  }));
}

const BLOCKS = "▁▂▃▄▅▆▇█";

export function sparkline(values: (number | null)[], max = 100): string {
  return values
    .map((v) => {
      if (v == null) return " ";
      const i = Math.min(BLOCKS.length - 1, Math.floor((Math.max(0, v) / max) * BLOCKS.length));
      return BLOCKS[i];
    })
    .join("");
}

function mean(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export function formatHistory(series: Series[], days: number): string {
  if (series.length === 0) {
    return "No history yet — it accrues each time the bar or timer refreshes.\n";
  }
  const lines = [`Usage history · last ${days} days (daily peak; avg = mean of daily averages)`, ""];
  const w = Math.max(...series.map((s) => s.label.length));
  for (const s of series) {
    const avg = mean(s.means);
    const peak = Math.max(...s.peaks.filter((x): x is number => x != null));
    const avgText = avg == null ? "—" : `${Math.round(avg)}%`;
    lines.push(
      `${s.label.padEnd(w)}  ${sparkline(s.peaks)}  avg ${avgText.padStart(4)}  peak ${`${Math.round(peak)}%`.padStart(4)}`,
    );
  }
  return lines.join("\n") + "\n";
}

export function historyCsv(series: Series[]): string {
  const rows = ["day,window,peak,mean"];
  for (const s of series) {
    s.days.forEach((d, i) => {
      if (s.peaks[i] == null) return;
      rows.push(`${d},"${s.label}",${s.peaks[i]!.toFixed(1)},${s.means[i]!.toFixed(1)}`);
    });
  }
  return rows.join("\n") + "\n";
}
