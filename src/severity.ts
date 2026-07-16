import {
  DEFAULT_THRESHOLDS,
  type ProviderStatus,
  type Severity,
  type Thresholds,
  type UsageSnapshot,
} from "./types.ts";

export function severityFromPercent(
  usedPercent: number | undefined,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Severity {
  if (usedPercent == null || Number.isNaN(usedPercent)) return "unknown";
  if (usedPercent >= thresholds.crit) return "crit";
  if (usedPercent >= thresholds.warn) return "warn";
  return "ok";
}

export function worseSeverity(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = {
    ok: 0,
    unknown: 1,
    warn: 2,
    crit: 3,
    error: 4,
  };
  return rank[a] >= rank[b] ? a : b;
}

export function finalizeProvider(
  partial: Omit<ProviderStatus, "severity" | "usedPercent"> & {
    usedPercent?: number;
  },
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): ProviderStatus {
  let used = partial.usedPercent;
  if (used == null && partial.windows.length) {
    const nums = partial.windows
      .map((w) => w.usedPercent)
      .filter((n): n is number => typeof n === "number");
    if (nums.length) used = Math.max(...nums);
  }
  const severity = partial.ok
    ? severityFromPercent(used, thresholds)
    : "error";
  return {
    ...partial,
    usedPercent: used,
    severity,
  };
}

export function finalizeSnapshot(
  providers: ProviderStatus[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): UsageSnapshot {
  const nums = providers
    .filter((p) => p.ok)
    .map((p) => p.usedPercent)
    .filter((n): n is number => typeof n === "number");
  const worst = nums.length ? Math.max(...nums) : undefined;
  let severity: Severity = severityFromPercent(worst, thresholds);
  if (providers.length > 0 && providers.every((p) => !p.ok)) {
    severity = "error";
  } else {
    for (const p of providers) {
      if (p.ok) severity = worseSeverity(severity, p.severity);
    }
  }
  return {
    fetchedAt: new Date().toISOString(),
    providers,
    worstUsedPercent: worst,
    severity,
  };
}
