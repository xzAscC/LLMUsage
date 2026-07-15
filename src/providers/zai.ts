import { getApiKey, type AuthFile } from "../auth.ts";
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
  data?: { limits?: ZaiLimit[] };
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

function mapLimit(limit: ZaiLimit, index: number): UsageWindow | null {
  const type = limit.type || "UNKNOWN";
  if (type === "TOKENS_LIMIT") {
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
    };
  }

  if (type === "TIME_LIMIT") {
    const usedPercent =
      limit.percentage != null
        ? clampPercent(limit.percentage)
        : limit.usage && limit.currentValue != null
          ? clampPercent((limit.currentValue / limit.usage) * 100)
          : undefined;
    const resetsAt = isoFromEpochMs(limit.nextResetTime);
    return {
      id: `tools-${limit.unit ?? index}`,
      label: "Tools/Search",
      usedPercent,
      remainingPercent:
        usedPercent != null ? clampPercent(100 - usedPercent) : undefined,
      used: limit.currentValue,
      limit: limit.usage,
      remaining: limit.remaining,
      resetsAt,
      resetAfterSeconds: secondsUntil(resetsAt),
      note:
        limit.usage != null && limit.currentValue != null
          ? `${limit.currentValue}/${limit.usage} calls`
          : undefined,
    };
  }

  return null;
}

export async function fetchZai(auth: AuthFile): Promise<ProviderStatus> {
  const now = new Date().toISOString();
  const key = getApiKey(auth, [
    "zai-coding-plan",
    "zai",
    "zhipuai",
    "glm",
  ]);
  if (!key) {
    return finalizeProvider({
      id: "zai",
      name: "GLM / Z.AI",
      ok: false,
      error: "No zai-coding-plan API key in OpenCode auth.json",
      windows: [],
      fetchedAt: now,
    });
  }

  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };

  try {
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
      throw new Error(quota.msg || quota.message || `Z.AI code ${quota.code}`);
    }

    const windows = (quota.data?.limits || [])
      .map((l, i) => mapLimit(l, i))
      .filter((w): w is UsageWindow => w != null);

    const active = (subs?.data || []).find(
      (s) => s.status === "VALID" || s.status === "valid",
    ) || subs?.data?.[0];

    return finalizeProvider({
      id: "zai",
      name: "GLM / Z.AI",
      plan: active?.productName,
      ok: true,
      windows,
      fetchedAt: now,
    });
  } catch (err) {
    return finalizeProvider({
      id: "zai",
      name: "GLM / Z.AI",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      windows: [],
      fetchedAt: now,
    });
  }
}
