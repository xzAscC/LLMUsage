import type { Pace, UsageWindow } from "./types.ts";

/** Dead zone around the even-burn line so the label doesn't flap. */
export const EVEN_BAND = 0.02;
/** Under this much of the window elapsed, pace is noise. */
export const MIN_ELAPSED = 0.03;

/**
 * Where a rolling window stands against even burn (used% vs elapsed%).
 * used > elapsed ⟺ at the average rate you run out before the reset.
 * Null when it can't be read honestly: no window length/reset, too early,
 * or already exhausted (the reset countdown owns that state).
 */
export function paceFor(w: UsageWindow, now = Date.now()): Pace | undefined {
  if (w.usedPercent == null || !w.windowSeconds || w.windowSeconds <= 0) return undefined;
  const resetMs = w.resetsAt
    ? Date.parse(w.resetsAt)
    : w.resetAfterSeconds != null
      ? now + w.resetAfterSeconds * 1000
      : NaN;
  if (!Number.isFinite(resetMs)) return undefined;
  const used = w.usedPercent / 100;
  if (used >= 1) return undefined;

  const durMs = w.windowSeconds * 1000;
  const startMs = resetMs - durMs;
  const elapsed = Math.min(Math.max((now - startMs) / durMs, 0), 1);
  if (elapsed < MIN_ELAPSED) return undefined;

  const margin = used - elapsed;
  const kind: Pace["kind"] =
    Math.abs(margin) < EVEN_BAND ? "even" : margin > 0 ? "deficit" : "reserve";
  return {
    kind,
    marginPercent: Math.round(Math.abs(margin) * 100),
    projectedPercent: Math.round((used / elapsed) * 100),
    elapsedPercent: Math.round(elapsed * 100),
    runsOutAt:
      kind === "deficit" && used > 0
        ? new Date(startMs + (elapsed / used) * durMs).toISOString()
        : undefined,
  };
}

export function paceSummary(p: Pace, now = Date.now()): string {
  switch (p.kind) {
    case "reserve":
      return `${p.marginPercent}% in reserve`;
    case "even":
      return `on pace · lands ~${p.projectedPercent}%`;
    case "deficit": {
      const out = p.runsOutAt ? Date.parse(p.runsOutAt) : NaN;
      if (Number.isFinite(out) && out - now < 16 * 3600_000) {
        const t = new Date(out).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        return `${p.marginPercent}% in deficit · runs out ~${t}`;
      }
      return `${p.marginPercent}% in deficit · lands ~${p.projectedPercent}%`;
    }
  }
}
