import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential } from "./auth.ts";
import {
  authFileSource,
  anthropicSources,
  callWithOAuth,
  claudeCodeLockPaths,
  claudeCodeSource,
  claudeSharesLock,
  codexSource,
  CredentialError,
  loadStores,
  openaiSources,
  zaiKeys,
} from "./credentials.ts";
import { setRunningProcesses } from "./procs.ts";
import { lockTiming, withFileLocks } from "./oauth-refresh.ts";
import { statSync, utimesSync } from "node:fs";

const dirs: string[] = [];
afterEach(() => {
  setRunningProcesses([]);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "llm-usage-cred-"));
  dirs.push(d);
  return d;
}

function jwt(expSec: number): string {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "none" })}.${b({ exp: expSec })}.sig`;
}

const fresh = (access: string): OAuthCredential => ({
  type: "oauth",
  access,
  refresh: `${access}-r`,
  expires: Date.now() + 3600_000,
});
const expired = (access: string): OAuthCredential => ({
  type: "oauth",
  access,
  refresh: `${access}-r`,
  expires: Date.now() - 1000,
});

function piSource(cred: OAuthCredential) {
  const path = join(tmp(), "auth.json");
  const auth = { anthropic: cred };
  writeFileSync(path, JSON.stringify(auth));
  return { path, src: authFileSource("pi", path, auth, ["anthropic"])! };
}

describe("callWithOAuth", () => {
  test("prefers an unexpired token over an earlier expired one", async () => {
    const a = piSource(expired("A")).src;
    const b = piSource(fresh("B")).src;
    setRunningProcesses(["pi"]);
    const { cred } = await callWithOAuth([a, b], () => null, async (c) => c.access);
    expect(cred.access).toBe("B");
  });

  test("refreshes and writes back only when the owner is idle", async () => {
    const { path, src } = piSource(expired("A"));
    const refresher = async (c: OAuthCredential) => fresh(`${c.access}2`);
    const { result } = await callWithOAuth([src], () => refresher, async (c) => c.access);
    expect(result).toBe("A2");
    expect(JSON.parse(readFileSync(path, "utf8")).anthropic.access).toBe("A2");
  });

  test("falls through to the next store on 401", async () => {
    const a = piSource(fresh("A")).src;
    const b = piSource(fresh("B")).src;
    setRunningProcesses(["pi"]);
    const { result } = await callWithOAuth([a, b], () => null, async (c) => {
      if (c.access === "A") throw new Error("HTTP 401: nope");
      return c.access;
    });
    expect(result).toBe("B");
  });

  test("explains why nothing worked", async () => {
    const a = piSource(fresh("A")).src;
    setRunningProcesses(["pi"]);
    const err = await callWithOAuth([a], () => null, async () => {
      throw new Error("HTTP 401");
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CredentialError);
    expect(String(err.message)).toMatch(/pi is running/);
  });
});

describe("stores", () => {
  test("reads Codex auth.json with expiry from the JWT and writes back tokens", async () => {
    const home = tmp();
    const path = join(home, "auth.json");
    writeFileSync(
      path,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: jwt(Math.floor(Date.now() / 1000) - 10), refresh_token: "R", account_id: "acct", id_token: "keep" },
      }),
    );
    const src = codexSource(path)!;
    expect(src.cred.accountId).toBe("acct");
    expect(src.cred.expires! < Date.now()).toBe(true);
    await src.refresh(async () => ({ type: "oauth", access: "NEW", refresh: "R2", expires: Date.now() + 1e6 }), false);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.tokens).toMatchObject({ access_token: "NEW", refresh_token: "R2", account_id: "acct", id_token: "keep" });
    expect(saved.auth_mode).toBe("chatgpt");
  });

  test("GLM keys: env, then pi api_key, then OpenCode; deduped", () => {
    const piDir = process.env.PI_CODING_AGENT_DIR!;
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "auth.json"), JSON.stringify({ zai: { type: "api_key", key: "PI_KEY" } }));
    process.env.ZAI_API_KEY = "ENV_KEY";
    try {
      const keys = zaiKeys(loadStores({ "zai-coding-plan": { type: "api", key: "PI_KEY" } }));
      expect(keys.map((k) => k.label)).toEqual(["$ZAI_API_KEY", "pi"]);
    } finally {
      delete process.env.ZAI_API_KEY;
      rmSync(join(piDir, "auth.json"));
    }
  });
});

// --- Claude Code: refresh while it runs, as one more Claude Code session ---

function claudeDir(oauth: Record<string, unknown>) {
  const dir = join(tmp(), ".claude");
  mkdirSync(dir);
  const path = join(dir, ".credentials.json");
  writeFileSync(path, JSON.stringify({ claudeAiOauth: oauth, mcpOAuth: { keep: true } }));
  return { dir, path, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

const ccExpired = (access: string) => ({
  accessToken: access,
  refreshToken: `${access}-r`,
  expiresAt: Date.now() - 1000,
  refreshTokenExpiresAt: Date.now() + 5 * 86400_000,
  scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
  subscriptionType: "pro",
  accountUuid: "acct",
});

/** a stand-in for the installer's versions/<X.Y.Z> binary; `locks` = it names the locks we take */
function claudeBuild(version: string, locks = true): string {
  const dir = join(tmp(), "versions");
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, version);
  writeFileSync(exe, locks ? "\0.oauth_refresh.lock\0.storage-write.lock\0" : "\0nothing here\0");
  return exe;
}

/** a native Claude Code build is running */
function claudeRunning(version = "2.1.330") {
  setRunningProcesses(["claude"], { claude: [claudeBuild(version)] });
}

describe("which Claude Code builds share the refresh lock", () => {
  test("native builds from 2.1.328 whose binary still names the locks", () => {
    const v = (x: string) => claudeBuild(x);
    expect(claudeSharesLock([v("2.1.330")])).toBe(true);
    expect(claudeSharesLock([v("2.1.328"), v("2.2.0"), v("3.0.0")])).toBe(true);
    expect(claudeSharesLock([v("2.1.327")])).toBe(false);
    expect(claudeSharesLock([v("2.1.330"), v("2.0.99")])).toBe(false);
    expect(claudeSharesLock([claudeBuild("2.2.1", false)])).toBe(false); // renamed its locks
    expect(claudeSharesLock(["/usr/bin/node"])).toBe(false);
    expect(claudeSharesLock([""])).toBe(false);
    expect(claudeSharesLock(["/no/such/versions/2.1.330"])).toBe(false);
  });

  for (const [what, exe] of [
    ["an older build", () => claudeBuild("2.1.200")],
    ["an npm install", () => "/usr/bin/node"],
  ] as const) {
    test(`while ${what} runs, we wait for it to refresh, as before`, async () => {
      const { path } = claudeDir(ccExpired("A"));
      setRunningProcesses(["claude"], { claude: [exe()] });
      let refreshed = false;
      await callWithOAuth(
        [claudeCodeSource(path)!],
        () => async () => {
          refreshed = true;
          return fresh("A2");
        },
        async (c) => c.access,
      );
      expect(refreshed).toBe(false);
    });
  }
});

describe("Claude Code credentials", () => {
  test("lock paths are Claude Code's own: <dir>/.oauth_refresh.lock, then <dir>.lock", () => {
    const { dir, path } = claudeDir(ccExpired("A"));
    expect(claudeCodeLockPaths(path)).toEqual([join(dir, ".oauth_refresh.lock"), `${dir}.lock`]);
  });

  test("refreshes while claude runs, keeps every other field, releases both locks", async () => {
    const { dir, path, read } = claudeDir(ccExpired("A"));
    claudeRunning();
    let seen: OAuthCredential | null = null;
    const refresher = async (c: OAuthCredential) => {
      seen = c;
      // both locks are held while we talk to the token endpoint
      expect(existsSync(join(dir, ".oauth_refresh.lock"))).toBe(true);
      expect(existsSync(`${dir}.lock`)).toBe(true);
      return { ...fresh("A2"), scopes: c.scopes, refreshExpires: 1_900_000_000_000 };
    };
    const { result } = await callWithOAuth([claudeCodeSource(path)!], () => refresher, async (c) => c.access);
    expect(result).toBe("A2");
    expect(seen!.scopes).toEqual(["user:inference", "user:profile", "user:sessions:claude_code"]);
    const saved = read();
    expect(saved.claudeAiOauth).toMatchObject({
      accessToken: "A2",
      refreshToken: "A2-r",
      refreshTokenExpiresAt: 1_900_000_000_000,
      scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
      subscriptionType: "pro",
      accountUuid: "acct",
    });
    expect(saved.mcpOAuth).toEqual({ keep: true });
    expect(existsSync(join(dir, ".oauth_refresh.lock"))).toBe(false);
    expect(existsSync(`${dir}.lock`)).toBe(false);
  });

  for (const which of ["new", "legacy"] as const) {
    test(`waits on Claude Code's ${which} lock and adopts the token it wrote`, async () => {
      const { dir, path } = claudeDir(ccExpired("A"));
      const lock = which === "new" ? join(dir, ".oauth_refresh.lock") : `${dir}.lock`;
      mkdirSync(lock); // a Claude Code session is refreshing right now
      claudeRunning();
      let refreshed = false;
      const pending = callWithOAuth(
        [claudeCodeSource(path)!],
        () => async () => {
          refreshed = true;
          return fresh("OURS");
        },
        async (c) => c.access,
      );
      await new Promise((r) => setTimeout(r, 150));
      writeFileSync(path, JSON.stringify({ claudeAiOauth: { ...ccExpired("CC"), expiresAt: Date.now() + 3600_000 } }));
      rmSync(lock, { recursive: true });
      const { result } = await pending;
      expect(result).toBe("CC");
      expect(refreshed).toBe(false);
    });
  }

  test("a login past its end is not refreshed; the card says to sign in again", async () => {
    const { path } = claudeDir({ ...ccExpired("A"), refreshTokenExpiresAt: Date.now() - 1000 });
    let refreshed = false;
    const err = await callWithOAuth(
      [claudeCodeSource(path)!],
      () => async () => {
        refreshed = true;
        return fresh("A2");
      },
      async (c) => c.access,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CredentialError);
    expect(String(err.message)).toMatch(/login expired — run \/login/);
    expect(refreshed).toBe(false);
  });

  test("an unexpired access token still works after the login's end", async () => {
    const { path } = claudeDir({ ...ccExpired("A"), expiresAt: Date.now() + 3600_000, refreshTokenExpiresAt: Date.now() - 1000 });
    const { result } = await callWithOAuth([claudeCodeSource(path)!], () => null, async (c) => c.access);
    expect(result).toBe("A");
  });

  test("never sits on Claude Code's first lock while its second is busy", async () => {
    const { dir, path } = claudeDir(ccExpired("A"));
    mkdirSync(`${dir}.lock`); // a legacy holder
    claudeRunning();
    const pending = callWithOAuth([claudeCodeSource(path)!], () => async () => fresh("A2"), async (c) => c.access);
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 30));
      expect(existsSync(join(dir, ".oauth_refresh.lock"))).toBe(false);
    }
    rmSync(`${dir}.lock`, { recursive: true });
    expect((await pending).result).toBe("A2");
  });

  test("a /login during our refresh wins over the tokens we got", async () => {
    const { path, read } = claudeDir(ccExpired("A"));
    claudeRunning();
    const refresher = async () => {
      // the user signs in to another account while the server answers us
      writeFileSync(path, JSON.stringify({ claudeAiOauth: { ...ccExpired("B"), expiresAt: Date.now() + 3600_000, subscriptionType: "max" } }));
      return fresh("A2");
    };
    const { result } = await callWithOAuth([claudeCodeSource(path)!], () => refresher, async (c) => c.access);
    expect(result).toBe("B");
    expect(read().claudeAiOauth).toMatchObject({ accessToken: "B", subscriptionType: "max" });
  });

  test("a file caught half-written is read again, then gets our rotated token", async () => {
    const { path, read } = claudeDir(ccExpired("A"));
    const whole = readFileSync(path, "utf8");
    claudeRunning();
    const refresher = async () => {
      writeFileSync(path, whole.slice(0, 20)); // another writer, mid-write
      setTimeout(() => writeFileSync(path, whole), 250); // … and done
      return fresh("A2");
    };
    const { result } = await callWithOAuth([claudeCodeSource(path)!], () => refresher, async (c) => c.access);
    expect(result).toBe("A2");
    expect(read().claudeAiOauth.accessToken).toBe("A2");
    expect(read().mcpOAuth).toEqual({ keep: true });
  });

  test("a file that never parses is not overwritten; the call still uses our token", async () => {
    const { path } = claudeDir(ccExpired("A"));
    claudeRunning();
    const refresher = async () => {
      writeFileSync(path, '{"claudeAiOauth": {');
      return fresh("A2");
    };
    const { result } = await callWithOAuth([claudeCodeSource(path)!], () => refresher, async (c) => c.access);
    expect(result).toBe("A2");
    expect(readFileSync(path, "utf8")).toBe('{"claudeAiOauth": {');
  });

  test("a /logout that keeps the file (other entries remain) stays a logout", async () => {
    const { path, read } = claudeDir(ccExpired("A"));
    claudeRunning();
    const refresher = async () => {
      writeFileSync(path, JSON.stringify({ mcpOAuth: { keep: true } }));
      return fresh("A2");
    };
    await callWithOAuth([claudeCodeSource(path)!], () => refresher, async (c) => c.access).catch(() => null);
    expect(read()).toEqual({ mcpOAuth: { keep: true } });
  });

  test("the final write happens under Claude Code's storage-write lock", async () => {
    const { dir, path, read } = claudeDir(ccExpired("A"));
    const storage = join(dir, ".storage-write.lock");
    mkdirSync(storage); // Claude Code is saving an MCP token right now
    claudeRunning();
    const pending = callWithOAuth([claudeCodeSource(path)!], () => async () => fresh("A2"), async (c) => c.access);
    await new Promise((r) => setTimeout(r, 150));
    expect(read().claudeAiOauth.accessToken).toBe("A"); // not written yet
    rmSync(storage, { recursive: true });
    expect((await pending).result).toBe("A2");
    expect(read().claudeAiOauth.accessToken).toBe("A2");
  });

  test("a logout during our refresh stays a logout", async () => {
    const { path } = claudeDir(ccExpired("A"));
    claudeRunning();
    const refresher = async () => {
      rmSync(path);
      return fresh("A2");
    };
    await callWithOAuth([claudeCodeSource(path)!], () => refresher, async (c) => c.access).catch(() => null);
    expect(existsSync(path)).toBe(false);
  });

  test("held locks are touched while we wait on the server", async () => {
    const lock = join(tmp(), ".oauth_refresh.lock");
    const saved = lockTiming.beatMs;
    lockTiming.beatMs = 50;
    try {
      await withFileLocks([lock], "test", async () => {
        const first = statSync(lock).mtimeMs;
        await new Promise((r) => setTimeout(r, 200));
        expect(statSync(lock).mtimeMs).toBeGreaterThan(first);
      });
    } finally {
      lockTiming.beatMs = saved;
    }
    expect(existsSync(lock)).toBe(false);
  });

  test("a 401 on an unexpired token does not rotate the login of a running session", async () => {
    const { path, read } = claudeDir({ ...ccExpired("A"), expiresAt: Date.now() + 3600_000 });
    claudeRunning();
    let refreshed = false;
    const err = await callWithOAuth(
      [claudeCodeSource(path)!],
      () => async () => {
        refreshed = true;
        return fresh("A2");
      },
      async () => {
        throw new Error("HTTP 401: scope");
      },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CredentialError);
    expect(refreshed).toBe(false);
    expect(read().claudeAiOauth.accessToken).toBe("A");
  });

  test("a collector killed mid-refresh first writes the rotated token, then leaves no lock", async () => {
    const { dir, path, read } = claudeDir(ccExpired("A"));
    dirs.push(`${dir}.lock`);
    const locks = claudeCodeLockPaths(path);
    // the server answers 400 ms in; SIGTERM arrives before that
    const script = `import { claudeCodeSource } from ${JSON.stringify(join(import.meta.dir, "credentials.ts"))};
const src = claudeCodeSource(${JSON.stringify(path)});
await src.refresh(async () => { await new Promise((r) => setTimeout(r, 400)); return { type: "oauth", access: "A2", refresh: "R2", expires: Date.now() + 3600000 }; }, true);
await new Promise(() => setInterval(() => {}, 1000));`;
    const child = Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100 && !locks.every((l) => existsSync(l)); i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(locks.every((l) => existsSync(l))).toBe(true);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(read().claudeAiOauth).toMatchObject({ accessToken: "A2", refreshToken: "R2" });
    expect([...locks, join(dir, ".storage-write.lock")].some((l) => existsSync(l))).toBe(false);
  });

  test("a stale lock path that is a file or a full directory is never deleted", async () => {
    const { dir, path } = claudeDir(ccExpired("A"));
    const legacy = `${dir}.lock`;
    dirs.push(legacy);
    writeFileSync(legacy, "not a lock");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(legacy, old, old);
    claudeRunning();
    const err = await withFileLocks(claudeCodeLockPaths(path), "test", async () => "got it", 300).catch((e) => e);
    expect(String(err)).toMatch(/Timed out/);
    expect(readFileSync(legacy, "utf8")).toBe("not a lock");
  });

  test("Codex still waits while codex runs", async () => {
    const path = join(tmp(), "auth.json");
    writeFileSync(path, JSON.stringify({ tokens: { access_token: jwt(Math.floor(Date.now() / 1000) - 10), refresh_token: "R" } }));
    setRunningProcesses(["codex"]);
    let refreshed = false;
    await callWithOAuth(
      [codexSource(path)!],
      () => async () => {
        refreshed = true;
        return fresh("N");
      },
      async (c) => c.access,
    );
    expect(refreshed).toBe(false);
  });
});

describe("one card = one login", () => {
  test("Claude Code and Codex logins hide old copies in pi and OpenCode", () => {
    const claude = process.env.CLAUDE_CREDENTIALS_PATH!;
    const codex = join(process.env.CODEX_HOME!, "auth.json");
    const pi = join(process.env.PI_CODING_AGENT_DIR!, "auth.json");
    for (const f of [claude, codex, pi]) mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(claude, JSON.stringify({ claudeAiOauth: ccExpired("CC") }));
    writeFileSync(codex, JSON.stringify({ tokens: { access_token: jwt(2e9), refresh_token: "R" } }));
    writeFileSync(pi, JSON.stringify({ anthropic: fresh("PI_A"), "openai-codex": fresh("PI_O") }));
    try {
      const stores = loadStores({ anthropic: fresh("OC_A"), openai: fresh("OC_O") });
      expect(anthropicSources(stores).map((s) => s.label)).toEqual(["Claude Code"]);
      expect(openaiSources(stores).map((s) => s.label)).toEqual(["Codex"]);
      rmSync(codex);
      // without a Codex login the next store is used, still only one
      expect(openaiSources(loadStores({})).map((s) => s.label)).toEqual(["pi"]);
    } finally {
      for (const f of [claude, codex, pi]) rmSync(f, { force: true });
    }
  });
});
