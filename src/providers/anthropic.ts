import type { AuthFile, OAuthCredential } from "../auth.ts";
import { join } from "node:path";
import { claudeAccountId, type ClaudeAccount } from "../config.ts";
import {
  anthropicSources,
  claudeCodeSource,
  callWithOAuth,
  CredentialError,
  loadStores,
  type OAuthSource,
} from "../credentials.ts";
import { finalizeProvider } from "../severity.ts";
import type { ProviderStatus, UsageWindow } from "../types.ts";
import { clampPercent, fetchJson, secondsUntil } from "../util.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const BETA = "oauth-2025-04-20";
/**
 * Claude Code's own budget. Never cut a refresh short: once the server has
 * rotated the token, aborting would drop the only copy of the new one.
 */
const REFRESH_TIMEOUT_MS = 30_000;
const SESSION_SECONDS = 5 * 3600;
const WEEK_SECONDS = 7 * 86400;

interface LegacyBucket {
  utilization?: number;
  resets_at?: string;
}

interface LimitEntry {
  kind?: string;
  percent?: number;
  resets_at?: string;
  scope?: { model?: { display_name?: string } };
}

interface UsageResponse {
  five_hour?: LegacyBucket | null;
  seven_day?: LegacyBucket | null;
  seven_day_sonnet?: LegacyBucket | null;
  seven_day_opus?: LegacyBucket | null;
  limits?: LimitEntry[];
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number;
    used_credits?: number;
    utilization?: number | null;
  };
}

export async function refreshClaudeToken(
  oauth: OAuthCredential,
): Promise<OAuthCredential> {
  if (!oauth.refresh) throw new Error("Claude OAuth missing refresh token");
  const resp = await fetchJson<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    scope?: string;
  }>(REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "claude-cli/2.1.177",
    },
    // Ask for the scopes the login already has, as Claude Code does, so a
    // refresh by us never leaves Claude Code with a narrower token.
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refresh,
      client_id: CLIENT_ID,
      ...(oauth.scopes?.length && { scope: oauth.scopes.join(" ") }),
    }),
  }, REFRESH_TIMEOUT_MS);
  if (!resp.access_token) {
    throw new Error("Claude OAuth refresh returned no access_token");
  }
  const scopes = resp.scope?.split(" ").filter(Boolean);
  return {
    type: "oauth",
    access: resp.access_token,
    refresh: resp.refresh_token || oauth.refresh,
    expires: Date.now() + (resp.expires_in ?? 28800) * 1000,
    scopes: scopes?.length ? scopes : oauth.scopes,
    refreshExpires:
      typeof resp.refresh_token_expires_in === "number"
        ? Date.now() + resp.refresh_token_expires_in * 1000
        : oauth.refreshExpires,
  };
}

async function fetchUsage(access: string): Promise<UsageResponse> {
  return fetchJson<UsageResponse>(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${access}`,
      "anthropic-beta": BETA,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "claude-cli/2.1.177",
    },
  });
}

function legacyWindow(
  id: string,
  label: string,
  bucket: LegacyBucket | null | undefined,
  windowSeconds?: number,
): UsageWindow | null {
  if (!bucket || typeof bucket.utilization !== "number") return null;
  const usedPercent = clampPercent(bucket.utilization);
  return {
    id,
    label,
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: bucket.resets_at,
    resetAfterSeconds: secondsUntil(bucket.resets_at),
    windowSeconds,
  };
}

function mapLimits(limits: LimitEntry[]): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const lim of limits) {
    if (typeof lim.percent !== "number") continue;
    const usedPercent = clampPercent(lim.percent);
    let id = "limit";
    let label = "Limit";
    let windowSeconds: number | undefined;
    if (lim.kind === "session") {
      id = "session-5h";
      label = "Session 5h";
      windowSeconds = SESSION_SECONDS;
    } else if (lim.kind === "weekly_all") {
      id = "weekly";
      label = "Weekly";
      windowSeconds = WEEK_SECONDS;
    } else if (lim.kind === "weekly_scoped") {
      const name = lim.scope?.model?.display_name || "Scoped";
      id = `weekly-${name.toLowerCase().replace(/\s+/g, "-")}`;
      label = name;
      windowSeconds = WEEK_SECONDS;
    } else if (lim.kind) {
      id = lim.kind;
      label = lim.kind;
    }
    out.push({
      id,
      label,
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      resetsAt: lim.resets_at,
      resetAfterSeconds: secondsUntil(lim.resets_at),
      windowSeconds,
    });
  }
  return out;
}

function mapUsage(body: UsageResponse): UsageWindow[] {
  if (Array.isArray(body.limits) && body.limits.length > 0) {
    const fromLimits = mapLimits(body.limits);
    if (fromLimits.length) return fromLimits;
  }
  const windows: UsageWindow[] = [];
  const five = legacyWindow("session-5h", "Session 5h", body.five_hour, SESSION_SECONDS);
  const week = legacyWindow("weekly", "Weekly", body.seven_day, WEEK_SECONDS);
  const sonnet = legacyWindow("weekly-sonnet", "Sonnet", body.seven_day_sonnet, WEEK_SECONDS);
  const opus = legacyWindow("weekly-opus", "Opus", body.seven_day_opus, WEEK_SECONDS);
  for (const w of [five, week, sonnet, opus]) {
    if (w) windows.push(w);
  }
  const extra = body.extra_usage;
  if (extra?.is_enabled) {
    if (typeof extra.utilization === "number") {
      const usedPercent = clampPercent(extra.utilization);
      windows.push({
        id: "extra",
        label: "Extra",
        usedPercent,
        remainingPercent: clampPercent(100 - usedPercent),
      });
    } else if (
      typeof extra.monthly_limit === "number" &&
      typeof extra.used_credits === "number" &&
      extra.monthly_limit > 0
    ) {
      // monthly_limit / used_credits often in cents
      const usedPercent = clampPercent(
        (extra.used_credits / extra.monthly_limit) * 100,
      );
      windows.push({
        id: "extra",
        label: "Extra",
        usedPercent,
        used: extra.used_credits,
        limit: extra.monthly_limit,
        note: `${extra.used_credits}/${extra.monthly_limit}`,
      });
    }
  }
  return windows;
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof CredentialError) {
    return msg === "no credentials"
      ? "No Claude credentials — run: claude auth login"
      : msg;
  }
  if (msg.includes("429") || msg.includes("rate_limit")) {
    return "Claude usage API rate-limited — try later";
  }
  const m = msg.match(/HTTP\s+(\d+)/);
  if (m) return `HTTP ${m[1]} from Claude usage API`;
  return msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
}

/** Sources for an extra Claude Code login: only that config dir's own credentials. */
export function claudeAccountSources(account: ClaudeAccount): OAuthSource[] {
  const source = claudeCodeSource(join(account.dir, ".credentials.json"));
  return source ? [{ ...source, label: `Claude Code (${account.dir})` }] : [];
}

export async function fetchAnthropic(
  auth?: AuthFile,
  sources: OAuthSource[] = anthropicSources(loadStores(auth)),
  account?: ClaudeAccount,
): Promise<ProviderStatus> {
  const now = new Date().toISOString();
  const loginEnds = sources[0]?.cred.refreshExpires;
  const base = {
    ...(account
      ? { id: claudeAccountId(account), name: `Claude ${account.name}` }
      : { id: "anthropic" as const, name: "Claude" }),
    fetchedAt: now,
    ...(loginEnds && { loginExpiresAt: new Date(loginEnds).toISOString() }),
  };
  try {
    const { result: body, source, cred } = await callWithOAuth(
      sources,
      () => refreshClaudeToken,
      (cred) => fetchUsage(cred.access),
    );
    const windows = mapUsage(body);
    if (cred.refreshExpires) base.loginExpiresAt = new Date(cred.refreshExpires).toISOString();
    if (windows.length === 0) {
      return finalizeProvider({
        ...base,
        plan: source.plan,
        ok: false,
        error: "Claude usage API returned no windows",
        windows: [],
      });
    }
    return finalizeProvider({
      ...base,
      plan: source.plan,
      source: source.label,
      ok: true,
      windows,
    });
  } catch (err) {
    return finalizeProvider({
      ...base,
      ok: false,
      error: shortError(err),
      windows: [],
    });
  }
}
