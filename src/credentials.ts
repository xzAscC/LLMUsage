import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type AuthFile,
  type OAuthCredential,
  getApiKey,
  getOAuth,
  jwtExpiryMs,
  loadAuthIfExists,
} from "./auth.ts";
import {
  isOAuthExpired,
  lockPathFor,
  persistOAuthProvider,
  refreshFileCredential,
  type OAuthRefresher,
} from "./oauth-refresh.ts";
import {
  claudeCredentialsPath,
  codexAuthPath,
  grokAuthPath,
  opencodeAuthPath,
  piAuthPath,
} from "./paths.ts";
import { isAnyRunning, runningExes } from "./procs.ts";

/**
 * Credentials are read from the agents you already log into — Claude Code,
 * Codex, pi — with OpenCode as a legacy fallback. Each store has an owner
 * process; we only refresh (and rotate) a token while its owner is NOT
 * running, so we never race the agent for a single-use refresh token.
 */
export type Owner = "claude-code" | "codex" | "pi" | "opencode" | "grok-cli";

const OWNER_PROCESSES: Record<Owner, string[]> = {
  "claude-code": ["claude"],
  codex: ["codex"],
  pi: ["pi"],
  opencode: ["opencode"],
  "grok-cli": ["grok"],
};

export const OWNER_LABEL: Record<Owner, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  pi: "pi",
  opencode: "OpenCode",
  "grok-cli": "Grok CLI",
};

export function ownerRunning(owner: Owner): boolean {
  return isAnyRunning(OWNER_PROCESSES[owner]);
}

export interface OAuthSource {
  owner: Owner;
  label: string;
  path: string;
  cred: OAuthCredential;
  plan?: string;
  /** OIDC client id stored next to the token (Grok CLI). */
  clientId?: string;
  /**
   * Safe to refresh while the owner runs: we take the owner's own refresh
   * lock, and the owner re-reads the file under that lock (Claude Code).
   */
  refreshWhileRunning?: () => boolean;
  /** Refresh under a lock and write the rotated token back to the owner's file. */
  refresh(refresher: OAuthRefresher, force: boolean): Promise<OAuthCredential | null>;
}

export interface ApiKeySource {
  label: string;
  key: string;
}

function atomicWriteJson(path: string, data: unknown): void {
  const tmp = join(dirname(path), `.llm-usage.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function readJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

// --- Claude Code: ~/.claude/.credentials.json ---------------------------

function readClaudeCode(path: string): { cred: OAuthCredential; plan?: string } | null {
  const o = readJson(path)?.claudeAiOauth;
  if (!o?.accessToken) return null;
  return {
    cred: {
      type: "oauth",
      access: o.accessToken,
      refresh: o.refreshToken || undefined,
      expires: typeof o.expiresAt === "number" ? o.expiresAt : undefined,
      scopes: Array.isArray(o.scopes) ? o.scopes : undefined,
      refreshExpires: typeof o.refreshTokenExpiresAt === "number" ? o.refreshTokenExpiresAt : undefined,
    },
    plan: o.subscriptionType || undefined,
  };
}

function writeClaudeCode(path: string, next: OAuthCredential): void {
  const data = readJson(path) || {};
  const prev = data.claudeAiOauth || {};
  data.claudeAiOauth = {
    ...prev,
    accessToken: next.access,
    refreshToken: next.refresh || prev.refreshToken || "",
    expiresAt: next.expires,
    ...(next.scopes?.length && { scopes: next.scopes }),
    ...(next.refreshExpires && { refreshTokenExpiresAt: next.refreshExpires }),
  };
  atomicWriteJson(path, data);
}

/**
 * Claude Code's own refresh locks (2.1.x): `<config dir>/.oauth_refresh.lock`,
 * then the legacy `<config dir>.lock`, both mkdir-style. Every Claude Code
 * session takes them before refreshing and re-reads the credentials file
 * inside, so holding them makes us one more session, not a rival.
 */
export function claudeCodeLockPaths(credPath: string): string[] {
  const dir = dirname(credPath);
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // directory missing: nothing to refresh anyway
  }
  return [join(dir, ".oauth_refresh.lock"), `${real}.lock`];
}

/**
 * Oldest Claude Code seen to take both locks and re-read the file inside them
 * (the strings are in the 2.1.328–2.1.330 binaries; strace on 2.1.330).
 */
const CLAUDE_SHARED_LOCK_SINCE = [2, 1, 328] as const;

/**
 * Every running `claude` is a native Claude Code build (…/versions/X.Y.Z)
 * at least CLAUDE_SHARED_LOCK_SINCE. Anything else (an older build, an npm
 * install, an unreadable process) and we wait for it to refresh, as before.
 */
export function claudeSharesLock(exes = runningExes("claude")): boolean {
  return exes.every((exe) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(basename(exe));
    if (!m) return false;
    const v = m.slice(1).map(Number);
    const floor = CLAUDE_SHARED_LOCK_SINCE;
    return v[0] !== floor[0] ? v[0]! > floor[0] : v[1] !== floor[1] ? v[1]! > floor[1] : v[2]! >= floor[2];
  });
}

export function claudeCodeSource(path = claudeCredentialsPath()): OAuthSource | null {
  const found = readClaudeCode(path);
  if (!found) return null;
  return {
    owner: "claude-code",
    label: OWNER_LABEL["claude-code"],
    path,
    cred: found.cred,
    plan: found.plan,
    refreshWhileRunning: () => claudeSharesLock(),
    refresh: (refresher, force) =>
      refreshFileCredential({
        requested: found.cred,
        read: () => readClaudeCode(path)?.cred ?? null,
        write: (c) => writeClaudeCode(path, c),
        lockPath: claudeCodeLockPaths(path),
        path,
        label: "Claude Code",
        refresh: refresher,
        force,
      }),
  };
}

// --- Codex: ~/.codex/auth.json  { tokens: { access_token, refresh_token, account_id } }

function readCodex(path: string): OAuthCredential | null {
  const t = readJson(path)?.tokens;
  if (!t?.access_token) return null;
  return {
    type: "oauth",
    access: t.access_token,
    refresh: t.refresh_token || undefined,
    expires: jwtExpiryMs(t.access_token),
    accountId: t.account_id || undefined,
  };
}

function writeCodex(path: string, next: OAuthCredential): void {
  const data = readJson(path) || {};
  data.tokens = {
    ...(data.tokens || {}),
    access_token: next.access,
    refresh_token: next.refresh || data.tokens?.refresh_token,
  };
  data.last_refresh = new Date().toISOString();
  atomicWriteJson(path, data);
}

export function codexSource(path = codexAuthPath()): OAuthSource | null {
  const cred = readCodex(path);
  if (!cred) return null;
  return {
    owner: "codex",
    label: OWNER_LABEL.codex,
    path,
    cred,
    refresh: (refresher, force) =>
      refreshFileCredential({
        requested: cred,
        read: () => readCodex(path),
        write: (c) => writeCodex(path, c),
        lockPath: lockPathFor(path, "codex"),
        path,
        label: "Codex",
        refresh: refresher,
        force,
      }),
  };
}

// --- pi / OpenCode: { "<provider>": { type: "oauth", access, refresh, expires } }

export function authFileSource(
  owner: "pi" | "opencode",
  path: string,
  auth: AuthFile,
  keys: string[],
): OAuthSource | null {
  const key = keys.find((k) => getOAuth(auth, [k]));
  if (!key) return null;
  const cred = getOAuth(auth, [key])!;
  return {
    owner,
    label: OWNER_LABEL[owner],
    path,
    cred,
    refresh: (refresher, force) =>
      refreshFileCredential({
        requested: cred,
        read: () => getOAuth(loadAuthIfExists(path), [key]),
        write: (c) => {
          persistOAuthProvider(key, c, path);
          auth[key] = c;
        },
        lockPath: lockPathFor(path, key),
        path,
        label: `${OWNER_LABEL[owner]} ${key}`,
        refresh: refresher,
        force,
      }),
  };
}

// --- Grok CLI: ~/.grok/auth.json  { "https://auth.x.ai::<cid>": { key, refresh_token, expires_at, oidc_client_id } }

function readGrokCli(path: string): { dictKey: string; cred: OAuthCredential; clientId?: string } | null {
  const data = readJson(path);
  if (!data) return null;
  for (const [dictKey, e] of Object.entries(data)) {
    if (e && typeof e === "object" && typeof (e as any).key === "string" && (e as any).key) {
      const entry = e as Record<string, any>;
      const exp = entry.expires_at ? Date.parse(entry.expires_at) : NaN;
      return {
        dictKey,
        cred: {
          type: "oauth",
          access: entry.key,
          refresh: entry.refresh_token || undefined,
          expires: Number.isFinite(exp) ? exp : undefined,
        },
        clientId: entry.oidc_client_id || dictKey.split("::")[1],
      };
    }
  }
  return null;
}

export function grokCliSource(path = grokAuthPath()): OAuthSource | null {
  const found = readGrokCli(path);
  if (!found) return null;
  return {
    owner: "grok-cli",
    label: OWNER_LABEL["grok-cli"],
    path,
    cred: found.cred,
    clientId: found.clientId,
    refresh: (refresher, force) =>
      refreshFileCredential({
        requested: found.cred,
        read: () => readGrokCli(path)?.cred ?? null,
        write: (c) => {
          const data = readJson(path) || {};
          const entry = data[found.dictKey] || {};
          entry.key = c.access;
          if (c.refresh) entry.refresh_token = c.refresh;
          if (c.expires) entry.expires_at = new Date(c.expires).toISOString();
          data[found.dictKey] = entry;
          atomicWriteJson(path, data);
        },
        lockPath: lockPathFor(path, "grok"),
        path,
        label: "Grok CLI",
        refresh: refresher,
        force,
      }),
  };
}

// --- per-provider source chains ------------------------------------------

/** pi + OpenCode stores, loaded once per run. `opencode` is injectable for tests. */
export interface Stores {
  opencode: AuthFile;
  opencodePath: string;
  pi: AuthFile;
  piPath: string;
}

export function loadStores(opencode?: AuthFile, opencodePath = opencodeAuthPath()): Stores {
  return {
    opencode: opencode ?? loadAuthIfExists(opencodePath),
    opencodePath,
    pi: loadAuthIfExists(piAuthPath()),
    piPath: piAuthPath(),
  };
}

function compact<T>(xs: (T | null)[]): T[] {
  return xs.filter((x): x is T => x != null);
}

/**
 * One card = one login: the first store that holds a login is used and the
 * rest are ignored, so a failing login never turns into another account's
 * numbers (e.g. an old personal ChatGPT login left in pi or OpenCode).
 */
function firstLogin(xs: (OAuthSource | null)[]): OAuthSource[] {
  return compact(xs).slice(0, 1);
}

export function anthropicSources(s: Stores): OAuthSource[] {
  return firstLogin([
    claudeCodeSource(),
    authFileSource("pi", s.piPath, s.pi, ["anthropic"]),
    authFileSource("opencode", s.opencodePath, s.opencode, ["anthropic", "claude"]),
  ]);
}

export function openaiSources(s: Stores): OAuthSource[] {
  return firstLogin([
    codexSource(),
    authFileSource("pi", s.piPath, s.pi, ["openai-codex", "openai"]),
    authFileSource("opencode", s.opencodePath, s.opencode, ["openai", "codex", "chatgpt"]),
  ]);
}

export function xaiSources(s: Stores): OAuthSource[] {
  return firstLogin([
    grokCliSource(),
    authFileSource("pi", s.piPath, s.pi, ["xai", "grok"]),
    authFileSource("opencode", s.opencodePath, s.opencode, ["xai", "grok"]),
  ]);
}

/** Google Antigravity via the pi-antigravity extension (`/login antigravity`). */
export function antigravitySources(s: Stores): OAuthSource[] {
  return firstLogin([authFileSource("pi", s.piPath, s.pi, ["antigravity", "google-antigravity"])]);
}

function envKeys(names: string[]): ApiKeySource[] {
  return names
    .filter((n) => process.env[n])
    .map((n) => ({ label: `$${n}`, key: process.env[n]! }));
}

function fileKey(path: string): ApiKeySource[] {
  try {
    const key = readFileSync(path, "utf8").trim();
    return key ? [{ label: path, key }] : [];
  } catch {
    return [];
  }
}

function storeKey(label: string, auth: AuthFile, keys: string[]): ApiKeySource[] {
  const key = getApiKey(auth, keys);
  return key ? [{ label, key }] : [];
}

function dedupe(keys: ApiKeySource[]): ApiKeySource[] {
  const seen = new Set<string>();
  return keys.filter((k) => !seen.has(k.key) && seen.add(k.key));
}

export function zaiKeys(s: Stores, home = process.env.HOME || ""): ApiKeySource[] {
  return dedupe([
    ...envKeys(["ZAI_API_KEY", "Z_AI_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"]),
    ...fileKey(join(home, ".z-ai-api-key")),
    ...storeKey("pi", s.pi, ["zai", "zai-coding-plan"]),
    ...storeKey("OpenCode", s.opencode, ["zai-coding-plan", "zai", "zhipuai", "glm"]),
  ]);
}

export function minimaxKeys(s: Stores, home = process.env.HOME || ""): ApiKeySource[] {
  return dedupe([
    ...envKeys(["MINIMAX_API_KEY"]),
    ...fileKey(join(home, ".minimax-api-key")),
    ...storeKey("pi", s.pi, ["minimax"]),
    ...storeKey("OpenCode", s.opencode, ["minimax"]),
  ]);
}

/** Kimi's usage RPC wants the kimi.com session JWT (localStorage.access_token), not an API key. */
export function kimiTokens(configDir: string): ApiKeySource[] {
  return dedupe([
    ...envKeys(["KIMI_TOKEN", "KIMI_ACCESS_TOKEN"]),
    ...fileKey(join(configDir, "kimi-token")),
  ]);
}

// --- calling with a chain of OAuth sources --------------------------------

export function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /HTTP 401|token_expired|authentication_error|invalid_token/i.test(msg);
}

export class CredentialError extends Error {}

/**
 * Try each source in order (unexpired first). An expired token is refreshed
 * only when its owner process is idle; otherwise it is tried as-is and the
 * owner is expected to rotate it the next time it runs.
 */
export async function callWithOAuth<T>(
  sources: OAuthSource[],
  refresherFor: (source: OAuthSource) => OAuthRefresher | null,
  call: (cred: OAuthCredential, source: OAuthSource) => Promise<T>,
): Promise<{ result: T; source: OAuthSource; cred: OAuthCredential }> {
  if (sources.length === 0) throw new CredentialError("no credentials");
  const ordered = [
    ...sources.filter((s) => !isOAuthExpired(s.cred)),
    ...sources.filter((s) => isOAuthExpired(s.cred)),
  ];
  const problems: string[] = [];

  for (const source of ordered) {
    // A login past its end cannot be refreshed; its access token may still work a while.
    const ended = loginEnded(source.cred);
    if (ended && isOAuthExpired(source.cred)) {
      problems.push(`${source.label}: login expired — run /login`);
      continue;
    }
    const refresher = refresherFor(source);
    const canRefresh = !!(
      !ended &&
      refresher &&
      source.cred.refresh &&
      (!ownerRunning(source.owner) || !!source.refreshWhileRunning?.())
    );
    let cred = source.cred;

    if (isOAuthExpired(cred) && canRefresh) {
      try {
        cred = (await source.refresh(refresher!, false)) ?? cred;
      } catch (err) {
        problems.push(refreshProblem(source, err));
        continue;
      }
    }

    try {
      return { result: await call(cred, source), source, cred };
    } catch (err) {
      if (!isAuthError(err)) throw err;
      if (canRefresh) {
        try {
          // While the owner runs, only adopt what it wrote: forcing a new token
          // on any 401 would pull the login from under the running session.
          const next = await source.refresh(refresher!, !ownerRunning(source.owner));
          if (next && next.access !== cred.access) return { result: await call(next, source), source, cred: next };
        } catch (retryErr) {
          if (!isAuthError(retryErr)) {
            problems.push(refreshProblem(source, retryErr));
            continue;
          }
        }
      }
      problems.push(
        ownerRunning(source.owner) && !source.refreshWhileRunning?.()
          ? `${source.label}: token rejected (${source.label} is running and will refresh it on next use)`
          : `${source.label}: token rejected — log in again`,
      );
    }
  }
  throw new CredentialError(problems.join("; "));
}

/** The login itself is over (Claude's refresh token expiry): only signing in again helps. */
export function loginEnded(cred: OAuthCredential, now = Date.now()): boolean {
  return cred.refreshExpires != null && cred.refreshExpires <= now;
}

function refreshProblem(source: OAuthSource, err: unknown): string {
  if (/invalid_grant|revoked|unknown refresh token/i.test(String(err))) {
    return `${source.label}: login expired (refresh token revoked) — sign in again`;
  }
  return `${source.label}: refresh failed (${shortMessage(err)})`;
}

export function shortMessage(err: unknown, max = 120): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > max ? msg.slice(0, max) + "…" : msg;
}
