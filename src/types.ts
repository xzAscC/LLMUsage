export type ProviderId = "openai" | "zai" | "xai" | "anthropic";

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
  /** free-form note e.g. credits balance */
  note?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  plan?: string;
  ok: boolean;
  error?: string;
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
