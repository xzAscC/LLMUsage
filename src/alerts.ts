import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { NotifyConfig } from "./config.ts";
import { paceFor } from "./pace.ts";
import { alertStatePath, stateDir } from "./paths.ts";
import type { UsageSnapshot } from "./types.ts";

/**
 * Alert transitions between refreshes, as pure logic over a snapshot plus
 * carried state, so each crossing fires once instead of on every poll.
 */
export type Alert =
  | { kind: "crossed"; provider: string; meter: string; percent: number; resetsAt?: string }
  | { kind: "exhausted"; provider: string; meter: string; resetsAt?: string }
  | { kind: "restored"; provider: string; meter: string }
  | { kind: "refilled"; provider: string; meter: string }
  | { kind: "pace"; provider: string; meter: string; deficit: number; runsOutAt?: string };

export interface AlertState {
  /** meter key → highest threshold already alerted */
  firedAt: Record<string, number>;
  /** meters currently at 100% */
  depleted: string[];
  /** meters inside a pace-deficit episode */
  pacing: string[];
}

export const EMPTY_STATE: AlertState = { firedAt: {}, depleted: [], pacing: [] };

export function evaluateAlerts(
  snapshot: UsageSnapshot,
  cfg: NotifyConfig,
  state: AlertState,
  now = Date.now(),
): { alerts: Alert[]; state: AlertState } {
  const firedAt = { ...state.firedAt };
  const depleted = new Set(cfg.exhausted ? state.depleted : []);
  const pacing = new Set(cfg.pace ? state.pacing : []);
  const levels = [...cfg.thresholds].sort((a, b) => a - b);
  const alerts: Alert[] = [];

  for (const p of snapshot.providers) {
    // stale readings are old news; don't alert on them
    if (!p.ok || p.stale) continue;
    for (const w of p.windows) {
      if (w.usedPercent == null) continue;
      const key = `${p.id}|${w.id}`;
      const pct = w.usedPercent;
      const exhausted = pct >= 100;
      const wasDepleted = depleted.has(key);
      const meta = { provider: p.name, meter: w.label.trim() };

      if (cfg.exhausted) {
        if (exhausted && !wasDepleted) {
          alerts.push({ kind: "exhausted", ...meta, resetsAt: w.resetsAt });
          depleted.add(key);
        } else if (!exhausted && wasDepleted) {
          alerts.push({ kind: "restored", ...meta });
          depleted.delete(key);
        }
      }

      if (cfg.pace) {
        const pace = paceFor(w, now);
        if (pace?.kind === "deficit" && !pacing.has(key)) {
          alerts.push({ kind: "pace", ...meta, deficit: pace.marginPercent, runsOutAt: pace.runsOutAt });
          pacing.add(key);
        } else if (pacing.has(key) && (pace?.kind === "reserve" || pct <= 5)) {
          pacing.delete(key);
        }
      }

      const crossed = levels.filter((t) => t <= pct).pop();
      const prior = firedAt[key];
      if (crossed != null) {
        if (prior == null || crossed > prior) {
          if (!(exhausted && cfg.exhausted)) {
            alerts.push({ kind: "crossed", ...meta, percent: Math.round(pct), resetsAt: w.resetsAt });
          }
          firedAt[key] = crossed;
        }
      } else if (prior != null) {
        if (cfg.refilled && !wasDepleted) alerts.push({ kind: "refilled", ...meta });
        delete firedAt[key];
      }
    }
  }
  return { alerts, state: { firedAt, depleted: [...depleted], pacing: [...pacing] } };
}

export function alertText(a: Alert): { title: string; body: string; urgency: "low" | "normal" | "critical" } {
  const until = (iso?: string) =>
    iso ? ` until ${new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "";
  switch (a.kind) {
    case "crossed":
      return { title: `${a.provider} ${a.meter} at ${a.percent}%`, body: `Resets${until(a.resetsAt) || " soon"}`, urgency: a.percent >= 90 ? "critical" : "normal" };
    case "exhausted":
      return { title: `${a.provider} ${a.meter} exhausted`, body: `Locked out${until(a.resetsAt)}`, urgency: "critical" };
    case "restored":
      return { title: `${a.provider} ${a.meter} reset`, body: "Usable again", urgency: "low" };
    case "refilled":
      return { title: `${a.provider} ${a.meter} refilled`, body: "Back under every threshold", urgency: "low" };
    case "pace":
      return {
        title: `${a.provider} ${a.meter}: ${a.deficit}% over pace`,
        body: a.runsOutAt ? `At this rate it runs out ~${new Date(a.runsOutAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "On track to run out before reset",
        urgency: "normal",
      };
  }
}

export function loadAlertState(path = alertStatePath()): AlertState {
  if (!existsSync(path)) return structuredClone(EMPTY_STATE);
  try {
    return { ...EMPTY_STATE, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return structuredClone(EMPTY_STATE);
  }
}

export function saveAlertState(state: AlertState, path = alertStatePath()): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}
