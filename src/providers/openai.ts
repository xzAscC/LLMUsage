import {
  chatgptAccountId,
  type AuthFile,
  type OAuthCredential,
} from "../auth.ts";
import {
  ensureFreshOAuth,
  refreshOpenAIOAuth,
} from "../oauth-refresh.ts";
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

async function fetchWham(oauth: OAuthCredential): Promise<WhamResponse> {
  const accountId = chatgptAccountId(oauth);
  if (!accountId) {
    throw new Error("Missing ChatGPT account id on OAuth token");
  }
  return fetchJson<WhamResponse>("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: `Bearer ${oauth.access}`,
      "ChatGPT-Account-Id": accountId,
      "User-Agent": "llm-usage/0.1 (Hyprland)",
      Accept: "application/json",
    },
  });
}

export async function fetchOpenAI(auth: AuthFile): Promise<ProviderStatus> {
  const now = new Date().toISOString();
  let oauth: OAuthCredential | null;
  try {
    oauth = await ensureFreshOAuth(
      auth,
      ["openai", "codex", "chatgpt"],
      refreshOpenAIOAuth,
      "openai",
    );
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

  if (!oauth) {
    return finalizeProvider({
      id: "openai",
      name: "OpenAI",
      ok: false,
      error:
        "No OpenAI OAuth in OpenCode auth.json (run: opencode auth login)",
      windows: [],
      fetchedAt: now,
    });
  }

  try {
    let body: WhamResponse;
    try {
      body = await fetchWham(oauth);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("401") && !msg.includes("token_expired")) throw err;
      oauth = await ensureFreshOAuth(
        auth,
        ["openai", "codex", "chatgpt"],
        refreshOpenAIOAuth,
        "openai",
        true,
      );
      if (!oauth) throw err;
      body = await fetchWham(oauth);
    }

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
    const msg = err instanceof Error ? err.message : String(err);
    return finalizeProvider({
      id: "openai",
      name: "OpenAI",
      ok: false,
      error: msg.includes("401") || msg.includes("token_expired")
        ? "OpenAI token expired — refresh failed. Run: opencode auth login"
        : msg,
      windows: [],
      fetchedAt: now,
    });
  }
}
