import {
  chatgptAccountId,
  type AuthFile,
  type OAuthCredential,
} from "../auth.ts";
import { refreshOpenAIOAuth } from "../oauth-refresh.ts";
import {
  callWithOAuth,
  CredentialError,
  loadStores,
  openaiSources,
  type OAuthSource,
} from "../credentials.ts";
import { finalizeProvider } from "../severity.ts";
import type { ProviderStatus, UsageWindow } from "../types.ts";
import {
  clampPercent,
  fetchJson,
  isoFromEpochSec,
  secondsUntil,
} from "../util.ts";
import { loadConfig, type ResetCreditsDisplay } from "../config.ts";

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
  rate_limit_reset_credits?: {
    available_count?: number;
  };
}

interface ResetCreditItem {
  status?: string;
  expires_at?: string;
  title?: string;
}

interface ResetCreditsResponse {
  available_count?: number;
  total_earned_count?: number;
  credits?: ResetCreditItem[];
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
    windowSeconds: w.limit_window_seconds,
  };
}

function authHeaders(oauth: OAuthCredential): Record<string, string> {
  const accountId = chatgptAccountId(oauth);
  if (!accountId) {
    throw new Error("Missing ChatGPT account id on OAuth token");
  }
  return {
    Authorization: `Bearer ${oauth.access}`,
    "ChatGPT-Account-Id": accountId,
    "User-Agent": "llm-usage/0.1 (Hyprland)",
    Accept: "application/json",
  };
}

async function fetchWham(oauth: OAuthCredential): Promise<WhamResponse> {
  return fetchJson<WhamResponse>("https://chatgpt.com/backend-api/wham/usage", {
    headers: authHeaders(oauth),
  });
}

async function fetchResetCredits(
  oauth: OAuthCredential,
): Promise<ResetCreditsResponse | null> {
  try {
    return await fetchJson<ResetCreditsResponse>(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
      { headers: authHeaders(oauth) },
    );
  } catch {
    return null;
  }
}

function formatUtcMd(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function mapResetCredits(
  wham: WhamResponse,
  detail: ResetCreditsResponse | null,
  display: ResetCreditsDisplay,
): UsageWindow[] {
  const count =
    detail?.available_count ??
    wham.rate_limit_reset_credits?.available_count ??
    0;

  const available = (detail?.credits || []).filter(
    (c) => (c.status || "").toLowerCase() === "available" && c.expires_at,
  );
  available.sort(
    (a, b) => Date.parse(a.expires_at!) - Date.parse(b.expires_at!),
  );
  const soonest = available[0]?.expires_at;

  if (count <= 0 && available.length === 0) {
    return [{ id: "rate-resets", label: "Resets", note: "0 available" }];
  }

  if (display === "summary") {
    const parts: string[] = [`${count} available`];
    if (soonest) parts.push(`next exp ${formatUtcMd(soonest)}`);
    return [
      {
        id: "rate-resets",
        label: "Resets",
        note: parts.join(" · "),
        resetsAt: soonest,
        resetAfterSeconds: secondsUntil(soonest),
      },
    ];
  }

  // default "all": list every available reset expiry
  const out: UsageWindow[] = [
    {
      id: "rate-resets",
      label: "Resets",
      note: `${count} available`,
    },
  ];
  available.forEach((c, i) => {
    const exp = c.expires_at!;
    out.push({
      id: `rate-reset-${i}`,
      label: `  #${i + 1}`,
      note: `exp ${formatUtcMd(exp)}`,
      resetsAt: exp,
      resetAfterSeconds: secondsUntil(exp),
    });
  });
  return out;
}

export async function fetchOpenAI(
  auth?: AuthFile,
  sources: OAuthSource[] = openaiSources(loadStores(auth)),
): Promise<ProviderStatus> {
  const now = new Date().toISOString();
  const base = { id: "openai" as const, name: "OpenAI", fetchedAt: now };

  try {
    const {
      result: [body, resets],
      source,
    } = await callWithOAuth(
      sources,
      () => refreshOpenAIOAuth,
      (cred) => Promise.all([fetchWham(cred), fetchResetCredits(cred)]),
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

    const cfg = loadConfig();
    windows.push(
      ...mapResetCredits(body, resets, cfg.openai.resetCreditsDisplay),
    );

    return finalizeProvider({
      ...base,
      plan: body.plan_type,
      source: source.label,
      ok: true,
      windows,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return finalizeProvider({
      ...base,
      ok: false,
      error:
        err instanceof CredentialError && msg === "no credentials"
          ? "No ChatGPT OAuth — log in with codex (or pi /login)"
          : msg,
      windows: [],
    });
  }
}
