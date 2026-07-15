import { getOAuth, type AuthFile } from "../auth.ts";
import { finalizeProvider } from "../severity.ts";
import type { ProviderStatus, UsageWindow } from "../types.ts";
import {
  clampPercent,
  fetchJson,
  secondsUntil,
} from "../util.ts";

interface MoneyVal {
  val?: number;
}

interface GrokBillingConfig {
  monthlyLimit?: MoneyVal;
  used?: MoneyVal;
  onDemandCap?: MoneyVal;
  onDemandUsed?: MoneyVal;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  currentPeriod?: {
    type?: string;
    start?: string;
    end?: string;
  };
  creditUsagePercent?: number;
  isUnifiedBillingUser?: boolean;
}

interface GrokBillingResponse {
  config?: GrokBillingConfig;
}

interface GrokSettingsResponse {
  subscription_tier_display?: string;
}

export async function fetchXai(auth: AuthFile): Promise<ProviderStatus> {
  const now = new Date().toISOString();
  const oauth = getOAuth(auth, ["xai", "grok"]);
  if (!oauth) {
    return finalizeProvider({
      id: "xai",
      name: "Grok / xAI",
      ok: false,
      error: "No xAI OAuth in OpenCode auth.json (opencode /connect xai)",
      windows: [],
      fetchedAt: now,
    });
  }

  const headers = {
    Authorization: `Bearer ${oauth.access}`,
    "X-XAI-Token-Auth": "xai-grok-cli",
    Accept: "application/json",
    "User-Agent": "llm-usage/0.1 (Hyprland)",
  };

  try {
    const [billing, settings] = await Promise.all([
      // Default (no format) returns monthly included allowance — best for monthly subs
      fetchJson<GrokBillingResponse>(
        "https://cli-chat-proxy.grok.com/v1/billing",
        { headers },
      ),
      fetchJson<GrokSettingsResponse>(
        "https://cli-chat-proxy.grok.com/v1/settings",
        { headers },
      ).catch(() => null),
    ]);

    const cfg = billing.config || {};
    const windows: UsageWindow[] = [];

    const limit = cfg.monthlyLimit?.val;
    const used = cfg.used?.val;
    if (limit != null && limit > 0 && used != null) {
      const usedPercent = clampPercent((used / limit) * 100);
      const end = cfg.billingPeriodEnd;
      windows.push({
        id: "monthly",
        label: "Monthly",
        usedPercent,
        remainingPercent: clampPercent(100 - usedPercent),
        used,
        limit,
        remaining: Math.max(0, limit - used),
        resetsAt: end,
        resetAfterSeconds: secondsUntil(end),
        note: `${used}/${limit} credits`,
      });
    } else if (cfg.creditUsagePercent != null) {
      const usedPercent = clampPercent(cfg.creditUsagePercent);
      const end = cfg.currentPeriod?.end || cfg.billingPeriodEnd;
      windows.push({
        id: "period",
        label: "Period",
        usedPercent,
        remainingPercent: clampPercent(100 - usedPercent),
        resetsAt: end,
        resetAfterSeconds: secondsUntil(end),
      });
    }

    const odCap = cfg.onDemandCap?.val ?? 0;
    const odUsed = cfg.onDemandUsed?.val ?? 0;
    if (odCap > 0) {
      const usedPercent = clampPercent((odUsed / odCap) * 100);
      windows.push({
        id: "ondemand",
        label: "On-demand",
        usedPercent,
        remainingPercent: clampPercent(100 - usedPercent),
        used: odUsed,
        limit: odCap,
        remaining: Math.max(0, odCap - odUsed),
      });
    } else {
      windows.push({
        id: "ondemand",
        label: "On-demand",
        note: "disabled",
      });
    }

    return finalizeProvider({
      id: "xai",
      name: "Grok / xAI",
      plan: settings?.subscription_tier_display,
      ok: windows.some((w) => w.usedPercent != null) || windows.length > 0,
      windows,
      fetchedAt: now,
    });
  } catch (err) {
    return finalizeProvider({
      id: "xai",
      name: "Grok / xAI",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      windows: [],
      fetchedAt: now,
    });
  }
}
