export function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "?";
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatReset(
  resetsAt?: string,
  resetAfterSeconds?: number,
): string {
  if (resetAfterSeconds != null) return formatDuration(resetAfterSeconds);
  if (resetsAt) {
    const ms = Date.parse(resetsAt) - Date.now();
    if (Number.isFinite(ms)) return formatDuration(ms / 1000);
  }
  return "?";
}

export function isoFromEpochMs(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function isoFromEpochSec(sec: number | undefined): string | undefined {
  if (sec == null || !Number.isFinite(sec)) return undefined;
  return new Date(sec * 1000).toISOString();
}

export function secondsUntil(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, Math.floor(ms / 1000));
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function bar(usedPercent: number, width = 12): string {
  const p = clampPercent(usedPercent) / 100;
  const filled = Math.round(p * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
