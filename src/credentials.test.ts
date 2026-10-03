import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential } from "./auth.ts";
import {
  authFileSource,
  callWithOAuth,
  codexSource,
  CredentialError,
  loadStores,
  zaiKeys,
} from "./credentials.ts";
import { setRunningProcesses } from "./procs.ts";

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
