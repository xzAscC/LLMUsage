import { configDir } from "../paths.ts";
import { kimiTokens, type ApiKeySource } from "../credentials.ts";
import { finalizeProvider } from "../severity.ts";
import type { ProviderStatus, UsageWindow } from "../types.ts";
import { clampPercent, fetchJson, secondsUntil } from "../util.ts";

/**
 * Kimi coding plan. The usage RPC takes the kimi.com session JWT as a plain
 * Bearer (no cookie): at kimi.com, DevTools → copy(localStorage.access_token),
 * then save it to ~/.config/llm-usage/kimi-token or $KIMI_TOKEN. ~30-day TTL.
 */
const BASE = "https://www.kimi.com/apiv2";
const USAGES_URL = `${BASE}/kimi.gateway.billing.v1.BillingService/GetUsages`;
const SUBSCRIPTION_URL = `${BASE}/kimi.gateway.membership.v2.MembershipService/GetSubscription`;

interface Detail {
  limit?: string;
  used?: string;
  remaining?: string;
  resetTime?: string;
}

interface UsagesResponse {
  usages?: {
    scope?: string;
    detail?: Detail;
    limits?: { window?: { duration?: number; timeUnit?: string }; detail?: Detail }[];
  }[];
}

const UNIT_SECONDS: Record<string, number> = {
  TIME_UNIT_SECOND: 1,
  TIME_UNIT_MINUTE: 60,
  TIME_UNIT_HOUR: 3600,
  TIME_UNIT_DAY: 86400,
};

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "connect-protocol-version": "1",
  };
}

function window(id: string, label: string, d: Detail, windowSeconds?: number): UsageWindow | null {
  const used = Number(d.used);
  const limit = Number(d.limit || 100);
  if (!Number.isFinite(used) || !(limit > 0)) return null;
  const usedPercent = clampPercent(Math.round((used / limit) * 10000) / 100);
  return {
    id,
    label,
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: d.resetTime,
    resetAfterSeconds: secondsUntil(d.resetTime),
    windowSeconds,
  };
}

export function mapKimiUsages(body: UsagesResponse): UsageWindow[] {
  const feat =
    body.usages?.find((u) => u.scope === "FEATURE_CODING") ?? body.usages?.[0];
  if (!feat) return [];
  const out: UsageWindow[] = [];
  for (const [i, lim] of (feat.limits || []).entries()) {
    if (!lim.detail) continue;
    const dur = lim.window?.duration;
    const secs = dur != null ? dur * (UNIT_SECONDS[lim.window?.timeUnit || ""] ?? 60) : undefined;
    const label = secs ? `Session ${Math.round(secs / 3600)}h` : "Window";
    const w = window(`window-${i}`, label, lim.detail, secs);
    if (w) out.push(w);
  }
  if (feat.detail) {
    const w = window("plan", "Plan period", feat.detail);
    if (w) out.push(w);
  }
  return out;
}

export async function fetchKimi(
  tokens: ApiKeySource[] = kimiTokens(configDir()),
): Promise<ProviderStatus | null> {
  if (tokens.length === 0) return null; // not configured → not shown
  const now = new Date().toISOString();
  const base = { id: "kimi" as const, name: "Kimi", fetchedAt: now };
  const token = tokens[0]!;
  try {
    const [usages, sub] = await Promise.all([
      fetchJson<UsagesResponse>(USAGES_URL, {
        method: "POST",
        headers: headers(token.key),
        body: JSON.stringify({ scope: ["FEATURE_CODING"] }),
      }),
      fetchJson<{ subscription?: { goods?: { title?: string } } }>(SUBSCRIPTION_URL, {
        method: "POST",
        headers: headers(token.key),
        body: "{}",
      }).catch(() => null),
    ]);
    return finalizeProvider({
      ...base,
      plan: sub?.subscription?.goods?.title,
      source: token.label,
      ok: true,
      windows: mapKimiUsages(usages),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return finalizeProvider({
      ...base,
      ok: false,
      error: /HTTP 401/.test(msg)
        ? "Kimi session token expired — copy a fresh localStorage.access_token"
        : msg,
      windows: [],
    });
  }
}
