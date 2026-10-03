import type { AuthFile } from "../auth.ts";
import { loadStores, zaiKeys, type ApiKeySource } from "../credentials.ts";
import { finalizeProvider } from "../severity.ts";
import type { ProviderStatus, UsageWindow } from "../types.ts";
import {
  clampPercent,
  fetchJson,
  isoFromEpochMs,
  secondsUntil,
} from "../util.ts";

interface ZaiLimit {
  type?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
}

interface ZaiQuotaResponse {
  code?: number;
  success?: boolean;
  data?: { limits?: ZaiLimit[]; level?: string };
  msg?: string;
  message?: string;
}

interface ZaiSubItem {
  productName?: string;
  status?: string;
  nextRenewTime?: string;
  valid?: string;
}

interface ZaiSubResponse {
  code?: number;
  success?: boolean;
  data?: ZaiSubItem[];
}

function tokenWindowLabel(unit?: number, number?: number): string {
  // Observed: unit=3 number=5 → 5h session; unit=6 number=1 → weekly-ish
  if (unit === 3) return number && number !== 1 ? `Session ${number}h` : "Session";
  if (unit === 6) {
    if (number === 1) return "Weekly";
    if (number === 7) return "Weekly";
    return `Tokens ${number ?? ""}d`.trim();
  }
  return "Tokens";
}

// z.ai encodes a window as number × unit: 2 = minute, 3 = hour, 4 = day, 5 = month, 6 = week
const UNIT_SECONDS: Record<number, number> = {
  2: 60,
  3: 3600,
  4: 86400,
  5: 30 * 86400,
  6: 7 * 86400,
};

function windowSeconds(unit?: number, number?: number): number | undefined {
  const per = unit != null ? UNIT_SECONDS[unit] : undefined;
  return per && number ? per * number : undefined;
}

function mapLimit(limit: ZaiLimit, index: number): UsageWindow | null {
  const type = limit.type || "UNKNOWN";
  if (type !== "TOKENS_LIMIT") return null;

  const usedPercent =
    limit.percentage != null
      ? clampPercent(limit.percentage)
      : limit.usage && limit.currentValue != null
        ? clampPercent((limit.currentValue / limit.usage) * 100)
        : undefined;
  const resetsAt = isoFromEpochMs(limit.nextResetTime);
  return {
    id: `tokens-${limit.unit ?? index}-${limit.number ?? 0}`,
    label: tokenWindowLabel(limit.unit, limit.number),
    usedPercent,
    remainingPercent:
      usedPercent != null ? clampPercent(100 - usedPercent) : undefined,
    used: limit.currentValue,
    limit: limit.usage,
    remaining: limit.remaining,
    resetsAt,
    resetAfterSeconds: secondsUntil(resetsAt),
    windowSeconds: windowSeconds(limit.unit, limit.number),
  };
}

class KeyRejected extends Error {}

async function fetchWithKey(key: string) {
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };
  const [quota, subs] = await Promise.all([
    fetchJson<ZaiQuotaResponse>(
      "https://api.z.ai/api/monitor/usage/quota/limit",
      { headers },
    ),
    fetchJson<ZaiSubResponse>(
      "https://api.z.ai/api/biz/subscription/list",
      { headers },
    ).catch(() => null),
  ]);
  if (quota.success === false || (quota.code && quota.code !== 200)) {
    const msg = quota.msg || quota.message || `Z.AI code ${quota.code}`;
    // 1000 = "Authentication Failed": revoked key or lapsed plan
    if (quota.code === 1000 || /auth/i.test(msg)) throw new KeyRejected(msg);
    throw new Error(msg);
  }
  return { quota, subs };
}

export async function fetchZai(
  auth?: AuthFile,
  keys: ApiKeySource[] = zaiKeys(loadStores(auth)),
): Promise<ProviderStatus> {
  const now = new Date().toISOString();
  const base = { id: "zai" as const, name: "GLM / Z.AI", fetchedAt: now };
  if (keys.length === 0) {
    return finalizeProvider({
      ...base,
      ok: false,
      error: "No zai-coding-plan API key ($ZAI_API_KEY, pi or OpenCode)",
      windows: [],
    });
  }

  const rejected: string[] = [];
  for (const source of keys) {
    try {
      const { quota, subs } = await fetchWithKey(source.key);
      const windows = (quota.data?.limits || [])
        .map((l, i) => mapLimit(l, i))
        .filter((w): w is UsageWindow => w != null);
      const active =
        (subs?.data || []).find(
          (s) => s.status === "VALID" || s.status === "valid",
        ) || subs?.data?.[0];
      return finalizeProvider({
        ...base,
        plan: active?.productName || quota.data?.level,
        source: source.label,
        ok: true,
        windows,
      });
    } catch (err) {
      if (err instanceof KeyRejected || /HTTP 401/.test(String(err))) {
        rejected.push(source.label);
        continue;
      }
      return finalizeProvider({
        ...base,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        windows: [],
      });
    }
  }
  return finalizeProvider({
    ...base,
    ok: false,
    error: `Key rejected (${rejected.join(", ")}) — plan lapsed or key revoked`,
    windows: [],
  });
}
