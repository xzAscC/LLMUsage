import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import {
  type AuthFile,
  type OAuthCredential,
  getOAuth,
} from "../auth.ts";
import {
  ensureFreshOAuth,
  isOAuthExpired,
} from "../oauth-refresh.ts";
import { finalizeProvider } from "../severity.ts";
import type { ProviderStatus, UsageWindow } from "../types.ts";
import { clampPercent, fetchJson, secondsUntil } from "../util.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const BETA = "oauth-2025-04-20";

interface ClaudeCodeOAuth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
  scopes?: string[];
}

interface ClaudeCredentialsFile {
  claudeAiOauth?: ClaudeCodeOAuth;
}

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

function claudeCredentialsPath(): string {
  return (
    process.env.CLAUDE_CREDENTIALS_PATH ||
    join(homedir(), ".claude", ".credentials.json")
  );
}

function readClaudeCodeOAuth(): ClaudeCodeOAuth | null {
  const path = claudeCredentialsPath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as ClaudeCredentialsFile;
    return data.claudeAiOauth || null;
  } catch {
    return null;
  }
}

function toOAuth(cc: ClaudeCodeOAuth): OAuthCredential | null {
  if (!cc.accessToken) return null;
  return {
    type: "oauth",
    access: cc.accessToken,
    refresh: cc.refreshToken || undefined,
    expires: cc.expiresAt,
  };
}

async function refreshClaudeCodeToken(
  oauth: OAuthCredential,
): Promise<OAuthCredential> {
  if (!oauth.refresh) {
    throw new Error(
      "Claude Code access expired and no refresh token — run: claude auth login",
    );
  }
  const resp = await fetchJson<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  }>(REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "claude-cli/2.1.177",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refresh,
      client_id: CLIENT_ID,
    }),
  });
  if (!resp.access_token) {
    throw new Error("Claude OAuth refresh returned no access_token");
  }
  const next: OAuthCredential = {
    type: "oauth",
    access: resp.access_token,
    refresh: resp.refresh_token || oauth.refresh,
    expires: Date.now() + (resp.expires_in ?? 28800) * 1000,
  };
  persistClaudeCodeOAuth(next);
  return next;
}

function persistClaudeCodeOAuth(oauth: OAuthCredential): void {
  const path = claudeCredentialsPath();
  if (!existsSync(path)) return;
  const data = JSON.parse(readFileSync(path, "utf8")) as ClaudeCredentialsFile;
  const prev = data.claudeAiOauth || {};
  data.claudeAiOauth = {
    ...prev,
    accessToken: oauth.access,
    refreshToken: oauth.refresh || prev.refreshToken || "",
    expiresAt: oauth.expires,
  };
  const tmp = join(dirname(path), `.credentials.json.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

async function resolveToken(auth: AuthFile): Promise<{
  oauth: OAuthCredential;
  plan?: string;
  source: "claude-code" | "opencode";
}> {
  const cc = readClaudeCodeOAuth();
  if (cc?.accessToken) {
    let oauth = toOAuth(cc)!;
    if (isOAuthExpired(oauth) && oauth.refresh) {
      oauth = await refreshClaudeCodeToken(oauth);
    } else if (isOAuthExpired(oauth) && !oauth.refresh) {
      // setup tokens (sk-ant-oat01) may still work past local expiresAt
      // try usage anyway; 401 will surface re-login
    }
    return {
      oauth,
      plan: cc.subscriptionType,
      source: "claude-code",
    };
  }

  const op = await ensureFreshOAuth(
    auth,
    ["anthropic", "claude"],
    async (o) => {
      // OpenCode anthropic uses same refresh endpoint/client as Claude Code
      return refreshClaudeCodeToken(o);
    },
    "anthropic",
  );
  if (!op) {
    throw new Error(
      "No Claude credentials — run: claude auth login (or opencode auth login)",
    );
  }
  return { oauth: op, source: "opencode" };
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
  };
}

function mapLimits(limits: LimitEntry[]): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const lim of limits) {
    if (typeof lim.percent !== "number") continue;
    const usedPercent = clampPercent(lim.percent);
    let id = "limit";
    let label = "Limit";
    if (lim.kind === "session") {
      id = "session-5h";
      label = "Session 5h";
    } else if (lim.kind === "weekly_all") {
      id = "weekly";
      label = "Weekly";
    } else if (lim.kind === "weekly_scoped") {
      const name = lim.scope?.model?.display_name || "Scoped";
      id = `weekly-${name.toLowerCase().replace(/\s+/g, "-")}`;
      label = name;
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
  const five = legacyWindow("session-5h", "Session 5h", body.five_hour);
  const week = legacyWindow("weekly", "Weekly", body.seven_day);
  const sonnet = legacyWindow("weekly-sonnet", "Sonnet", body.seven_day_sonnet);
  const opus = legacyWindow("weekly-opus", "Opus", body.seven_day_opus);
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
  if (msg.includes("401") || msg.includes("authentication_error")) {
    return "Claude auth invalid — run: claude auth login";
  }
  if (msg.includes("429") || msg.includes("rate_limit")) {
    return "Claude usage API rate-limited — try later";
  }
  const m = msg.match(/HTTP\s+(\d+)/);
  if (m) return `HTTP ${m[1]} from Claude usage API`;
  return msg.length > 120 ? msg.slice(0, 120) + "…" : msg;
}

export async function fetchAnthropic(auth: AuthFile): Promise<ProviderStatus> {
  const now = new Date().toISOString();
  let resolved: Awaited<ReturnType<typeof resolveToken>>;
  try {
    resolved = await resolveToken(auth);
  } catch (err) {
    return finalizeProvider({
      id: "anthropic",
      name: "Claude",
      ok: false,
      error: shortError(err),
      windows: [],
      fetchedAt: now,
    });
  }

  try {
    let body: UsageResponse;
    try {
      body = await fetchUsage(resolved.oauth.access);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        (msg.includes("401") || msg.includes("authentication")) &&
        resolved.oauth.refresh
      ) {
        const next =
          resolved.source === "claude-code"
            ? await refreshClaudeCodeToken(resolved.oauth)
            : await ensureFreshOAuth(
                auth,
                ["anthropic", "claude"],
                refreshClaudeCodeToken,
                "anthropic",
                true,
              );
        if (!next) throw err;
        resolved.oauth = next;
        body = await fetchUsage(next.access);
      } else {
        throw err;
      }
    }

    const windows = mapUsage(body);
    if (windows.length === 0) {
      return finalizeProvider({
        id: "anthropic",
        name: "Claude",
        plan: resolved.plan,
        ok: false,
        error: "Claude usage API returned no windows",
        windows: [],
        fetchedAt: now,
      });
    }

    return finalizeProvider({
      id: "anthropic",
      name: "Claude",
      plan: resolved.plan,
      ok: true,
      windows,
      fetchedAt: now,
    });
  } catch (err) {
    return finalizeProvider({
      id: "anthropic",
      name: "Claude",
      plan: resolved.plan,
      ok: false,
      error: shortError(err),
      windows: [],
      fetchedAt: now,
    });
  }
}
