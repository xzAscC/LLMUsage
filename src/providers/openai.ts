import {
  chatgptAccountId,
  getOAuth,
  type AuthFile,
} from "../auth.ts";
import { finalizeProvider } from "../severity.ts";
import type { ProviderStatus, UsageWindow } from "../types.ts";
import {
  clampPercent,
  fetchJson,
  isoFromEpochSec,
} from "../util.ts";

interface WhamWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

interface WhamResponse {
  plan_type?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: WhamWindow | null;
    secondary_window?: WhamWindow | null;
  };
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string;
    overage_limit_reached?: boolean;
  };
}

function windowLabel(seconds: number | undefined, fallback: string): string {
  if (seconds == null) return fallback;
  if (seconds <= 6 * 3600) return "Session";
  if (seconds <= 2 * 86400) return "Daily";
  if (seconds <= 8 * 86400) return "Weekly";
  return "Monthly";
}

function mapWindow(
  id: string,
  fallbackLabel: string,
  w: WhamWindow | null | undefined,
): UsageWindow | null {
  if (!w || w.used_percent == null) return null;
  const usedPercent = clampPercent(w.used_percent);
  return {
    id,
    label: windowLabel(w.limit_window_seconds, fallbackLabel),
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetAfterSeconds: w.reset_after_seconds,
    resetsAt: isoFromEpochSec(w.reset_at),
  };
}

export async function fetchOpenAI(auth: AuthFile): Promise<ProviderStatus> {
  const now = new Date().toISOString();
  const oauth = getOAuth(auth, ["openai", "codex", "chatgpt"]);
  if (!oauth) {
    return finalizeProvider({
      id: "openai",
      name: "OpenAI",
      ok: false,
      error: "No OpenAI OAuth in OpenCode auth.json (need ChatGPT Plus/Pro login)",
      windows: [],
      fetchedAt: now,
    });
  }

  const accountId = chatgptAccountId(oauth);
  if (!accountId) {
    return finalizeProvider({
      id: "openai",
      name: "OpenAI",
      ok: false,
      error: "Missing ChatGPT account id on OAuth token",
      windows: [],
      fetchedAt: now,
    });
  }

  try {
    const body = await fetchJson<WhamResponse>(
      "https://chatgpt.com/backend-api/wham/usage",
      {
        headers: {
          Authorization: `Bearer ${oauth.access}`,
          "ChatGPT-Account-Id": accountId,
          "User-Agent": "llm-usage/0.1 (Hyprland)",
          Accept: "application/json",
        },
      },
    );

    const windows: UsageWindow[] = [];
    const primary = mapWindow(
      "primary",
      "Primary",
      body.rate_limit?.primary_window,
    );
    const secondary = mapWindow(
      "secondary",
      "Secondary",
      body.rate_limit?.secondary_window,
    );
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);

    if (body.credits?.has_credits && body.credits.balance) {
      const bal = Number.parseFloat(body.credits.balance);
      windows.push({
        id: "credits",
        label: "Credits",
        note: Number.isFinite(bal)
          ? `balance ${bal.toFixed(1)}`
          : `balance ${body.credits.balance}`,
      });
    }

    return finalizeProvider({
      id: "openai",
      name: "OpenAI",
      plan: body.plan_type,
      ok: true,
      windows,
      fetchedAt: now,
    });
  } catch (err) {
    return finalizeProvider({
      id: "openai",
      name: "OpenAI",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      windows: [],
      fetchedAt: now,
    });
  }
}
