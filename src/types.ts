export type ProviderId =
  | "openai"
  | "zai"
  | "xai"
  | "anthropic"
  /** extra Claude account from config `claude.accounts` */
  | `anthropic-${string}`
  | "kimi"
  | "minimax";

export type Severity = "ok" | "warn" | "crit" | "error" | "unknown";

export interface UsageWindow {
  id: string;
  label: string;
  /** 0–100 used percentage when known */
  usedPercent?: number;
  /** remaining percentage when known */
  remainingPercent?: number;
  /** absolute used units (tokens/credits/calls) */
  used?: number;
  /** absolute limit units */
  limit?: number;
  remaining?: number;
  /** ISO timestamp when this window resets */
  resetsAt?: string;
  /** seconds until reset */
  resetAfterSeconds?: number;
  /** full length of a rolling window, enables the even-burn pace line */
  windowSeconds?: number;
  /** where usage stands against even burn (filled by finalizeProvider) */
  pace?: Pace;
  /** free-form note e.g. credits balance */
  note?: string;
}

export interface Pace {
  /** reserve = under even burn, deficit = on track to run out before reset */
  kind: "reserve" | "even" | "deficit";
  /** |used − elapsed| in whole percent */
  marginPercent: number;
  /** % usage lands at by reset if the average rate holds (can exceed 100) */
  projectedPercent: number;
  /** % of the window elapsed */
  elapsedPercent: number;
  /** ISO time usage hits 100% at the average rate (deficit only) */
  runsOutAt?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  plan?: string;
  ok: boolean;
  error?: string;
  /** which local store the credential came from (Claude Code, Codex, pi, …) */
  source?: string;
  /** last fetch failed; windows are the last good reading from `asOf` */
  stale?: boolean;
  asOf?: string;
  /** representative used % for compact bar (worst window) */
  usedPercent?: number;
  severity: Severity;
  windows: UsageWindow[];
  fetchedAt: string;
}

export interface UsageSnapshot {
  fetchedAt: string;
  providers: ProviderStatus[];
  /** worst used% across providers that have a number */
  worstUsedPercent?: number;
  /** number the bar shows: worst (default) or mean, per config `summary` */
  headlinePercent?: number;
  severity: Severity;
}

export interface Thresholds {
  warn: number;
  crit: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  warn: 70,
  crit: 90,
};
