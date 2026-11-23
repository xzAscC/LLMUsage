import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";
import {
  type AuthFile,
  type OAuthCredential,
  getOAuth,
  loadAuth,
} from "./auth.ts";
import { opencodeAuthPath, piAgentDir } from "./paths.ts";
import { fetchJson } from "./util.ts";

const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
/** OpenCode's xAI OAuth client; the Grok CLI stores its own id in ~/.grok/auth.json. */
export const XAI_OPENCODE_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const SKEW_MS = 120_000;
const REFRESH_LOCK_POLL_MS = 25;
const REFRESH_LOCK_TIMEOUT_MS = 20_000;
const REFRESH_LOCK_STALE_MS = 120_000;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export function isOAuthExpired(
  oauth: OAuthCredential,
  skewMs = SKEW_MS,
): boolean {
  if (oauth.expires == null) return false;
  return oauth.expires <= Date.now() + skewMs;
}

async function postRefresh(
  tokenUrl: string,
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) body.set("client_secret", clientSecret);
  return fetchJson<TokenResponse>(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
}

function applyTokenResponse(
  prev: OAuthCredential,
  resp: TokenResponse,
): OAuthCredential {
  if (!resp.access_token) {
    throw new Error("OAuth refresh returned no access_token");
  }
  const expiresInSec = resp.expires_in ?? 3600;
  return {
    type: "oauth",
    access: resp.access_token,
    refresh: resp.refresh_token || prev.refresh,
    expires: Date.now() + expiresInSec * 1000,
    accountId: prev.accountId,
  };
}

export async function refreshOpenAIOAuth(
  oauth: OAuthCredential,
): Promise<OAuthCredential> {
  if (!oauth.refresh) throw new Error("OpenAI OAuth missing refresh token");
  const resp = await postRefresh(
    OPENAI_TOKEN_URL,
    OPENAI_CLIENT_ID,
    oauth.refresh,
  );
  return applyTokenResponse(oauth, resp);
}

export function xaiRefresher(clientId = XAI_OPENCODE_CLIENT_ID) {
  return async (oauth: OAuthCredential): Promise<OAuthCredential> => {
    if (!oauth.refresh) throw new Error("xAI OAuth missing refresh token");
    const resp = await postRefresh(XAI_TOKEN_URL, clientId, oauth.refresh);
    return applyTokenResponse(oauth, resp);
  };
}

/**
 * Google's Antigravity desktop OAuth client, which made pi's login. It is a
 * public installed-app client, but it is not stored in this repo: it comes
 * from $ANTIGRAVITY_CLIENT_ID/$ANTIGRAVITY_CLIENT_SECRET, else from the
 * pi-antigravity extension installed in pi.
 */
export async function antigravityClient(): Promise<{ id: string; secret: string }> {
  const id = process.env.ANTIGRAVITY_CLIENT_ID;
  const secret = process.env.ANTIGRAVITY_CLIENT_SECRET;
  if (id && secret) return { id, secret };
  const path = join(piAgentDir(), "npm", "node_modules", "pi-antigravity", "src", "auth", "oauth.ts");
  try {
    const m = await import(path);
    if (typeof m.CLIENT_ID === "string" && m.CLIENT_ID && typeof m.CLIENT_SECRET === "string" && m.CLIENT_SECRET) {
      return { id: m.CLIENT_ID, secret: m.CLIENT_SECRET };
    }
  } catch {
    // pi-antigravity not installed here
  }
  throw new Error(
    "Antigravity OAuth client not found: install pi-antigravity in pi, or set ANTIGRAVITY_CLIENT_ID and ANTIGRAVITY_CLIENT_SECRET",
  );
}

export async function googleRefresher(
  oauth: OAuthCredential,
): Promise<OAuthCredential> {
  if (!oauth.refresh) throw new Error("Antigravity OAuth missing refresh token");
  const client = await antigravityClient();
  const resp = await postRefresh(GOOGLE_TOKEN_URL, client.id, oauth.refresh, client.secret);
  return applyTokenResponse(oauth, resp);
}

export function persistOAuthProvider(
  providerKey: string,
  oauth: OAuthCredential,
  authPath = opencodeAuthPath(),
): void {
  const raw = readFileSync(authPath, "utf8");
  const data = JSON.parse(raw) as AuthFile;
  const prev = data[providerKey];
  if (!prev || prev.type !== "oauth") {
    throw new Error(`Cannot persist OAuth for missing provider ${providerKey}`);
  }
  data[providerKey] = {
    ...(prev as OAuthCredential),
    access: oauth.access,
    refresh: oauth.refresh,
    expires: oauth.expires,
    accountId: oauth.accountId ?? (prev as OAuthCredential).accountId,
    type: "oauth",
  };
  const tmp = join(dirname(authPath), `.auth.json.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, authPath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export type OAuthRefresher = (
  oauth: OAuthCredential,
) => Promise<OAuthCredential>;

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function credentialsChanged(
  previous: OAuthCredential,
  current: OAuthCredential,
): boolean {
  return (
    previous.access !== current.access ||
    previous.refresh !== current.refresh ||
    previous.expires !== current.expires
  );
}

function isRefreshReuseError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes("invalid_grant") ||
    message.includes("revoked") ||
    message.includes("refresh_token_reused") ||
    message.includes("already been used")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lock directories this process holds, removed on SIGTERM/SIGINT/SIGHUP too. */
const heldLocks = new Set<string>();
let cleanupInstalled = false;

function installLockCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  // A killed collector must not leave Claude Code's refresh locks behind:
  // its sessions could not refresh until the lock goes stale (60 s).
  const codes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
  for (const [sig, code] of Object.entries(codes)) {
    process.on(sig, () => {
      for (const p of heldLocks) rmSync(p, { recursive: true, force: true });
      process.exit(code);
    });
  }
}

/** mkdir the lock once; break it only when nobody has touched it for REFRESH_LOCK_STALE_MS. */
function tryLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      heldLocks.add(lockPath);
      return true;
    } catch (err) {
      if (errorCode(err) !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs <= REFRESH_LOCK_STALE_MS) return false;
        rmSync(lockPath, { recursive: true, force: true });
      } catch (statError) {
        if (errorCode(statError) !== "ENOENT") throw statError;
      }
    }
  }
  return false;
}

function unlock(lockPath: string): void {
  rmSync(lockPath, { recursive: true, force: true });
  heldLocks.delete(lockPath);
}

/**
 * Take every lock in order (the order Claude Code uses, so nobody deadlocks)
 * or none: when a later one is busy, release the earlier ones and retry, as
 * Claude Code does, so we never sit on its first lock while waiting.
 */
export async function withFileLocks<T>(
  lockPaths: string[],
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  installLockCleanup();
  const deadline = Date.now() + REFRESH_LOCK_TIMEOUT_MS;
  while (true) {
    const held: string[] = [];
    try {
      for (const p of lockPaths) {
        if (!tryLock(p)) break;
        held.push(p);
      }
      if (held.length === lockPaths.length) return await action();
    } finally {
      for (const p of held.reverse()) unlock(p);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label} OAuth refresh lock`);
    }
    await delay(REFRESH_LOCK_POLL_MS);
  }
}

export async function withFileLock<T>(
  lockPath: string,
  label: string,
  action: () => Promise<T>,
): Promise<T> {
  return withFileLocks([lockPath], label, action);
}

export function lockPathFor(credPath: string, key: string): string {
  return join(dirname(credPath), `.${basename(credPath)}.${key}.llm-usage.lock`);
}

async function recoverRotated(
  read: () => OAuthCredential | null,
  stale: OAuthCredential,
): Promise<OAuthCredential | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await delay(100);
    const current = read();
    if (current && credentialsChanged(stale, current)) return current;
  }
  return null;
}

/**
 * Refresh a file-backed OAuth credential under a cross-process lock.
 * Re-reads the file inside the lock so a token another process already
 * rotated is adopted instead of burning a (possibly single-use) refresh token.
 */
export async function refreshFileCredential(opts: {
  requested: OAuthCredential;
  read: () => OAuthCredential | null;
  write: (next: OAuthCredential) => void;
  /** one lock, or several taken in order (Claude Code uses two) */
  lockPath: string | string[];
  label: string;
  refresh: OAuthRefresher;
  force?: boolean;
}): Promise<OAuthCredential | null> {
  const { requested, read, write, refresh, force = false } = opts;
  const lockPaths = Array.isArray(opts.lockPath) ? opts.lockPath : [opts.lockPath];
  return withFileLocks(lockPaths, opts.label, async () => {
    const latest = read();
    if (!latest) return null;
    if (credentialsChanged(requested, latest)) return latest;
    if (!force && !isOAuthExpired(latest)) return latest;
    if (!latest.refresh) {
      throw new Error(`${opts.label} access token expired and no refresh token`);
    }

    let next: OAuthCredential;
    try {
      next = await refresh(latest);
    } catch (err) {
      if (isRefreshReuseError(err)) {
        const recovered = await recoverRotated(read, latest);
        if (recovered) return recovered;
      }
      throw err;
    }
    // A /login or /logout while we waited on the server wins: never write the
    // old login's tokens over it.
    const now = read();
    if (!now || credentialsChanged(latest, now)) return now;
    write(next);
    return next;
  });
}

export async function ensureFreshOAuth(
  auth: AuthFile,
  providerKeys: string[],
  refresh: OAuthRefresher,
  persistKey: string,
  force = false,
  authPath = opencodeAuthPath(),
): Promise<OAuthCredential | null> {
  const requested = getOAuth(auth, providerKeys);
  if (!requested) return null;
  if (!force && !isOAuthExpired(requested)) return requested;

  const next = await refreshFileCredential({
    requested,
    read: () => getOAuth(loadAuth(authPath), providerKeys),
    write: (cred) => persistOAuthProvider(persistKey, cred, authPath),
    lockPath: lockPathFor(authPath, persistKey),
    label: persistKey,
    refresh,
    force,
  });
  if (next) auth[persistKey] = next;
  return next;
}
