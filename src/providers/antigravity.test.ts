import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchAntigravity, windowsFromSummary } from "./antigravity.ts";
import type { AuthFile } from "../auth.ts";
import { antigravitySources, authFileSource } from "../credentials.ts";
import { setRunningProcesses } from "../procs.ts";
import { antigravityClient } from "../oauth-refresh.ts";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

// a stand-in for the pi-antigravity extension in the sandboxed pi dir
const piClient = join(process.env.PI_CODING_AGENT_DIR!, "npm", "node_modules", "pi-antigravity", "src", "auth", "oauth.ts");
function installPiClient() {
  mkdirSync(join(piClient, ".."), { recursive: true });
  writeFileSync(piClient, 'export const CLIENT_ID = "fake-id";\nexport const CLIENT_SECRET = "fake-secret";\n');
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(join(process.env.PI_CODING_AGENT_DIR!, "npm"), { recursive: true, force: true });
  delete process.env.ANTIGRAVITY_CLIENT_ID;
  delete process.env.ANTIGRAVITY_CLIENT_SECRET;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function piSource(auth: AuthFile) {
  const dir = mkdtempSync(join(tmpdir(), "llm-usage-agy-test-"));
  tempDirs.push(dir);
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(auth));
  return { path, sources: [authFileSource("pi", path, auth, ["antigravity"])!] };
}

const in5h = new Date(Date.now() + 5 * 3600_000).toISOString();
const in7d = new Date(Date.now() + 7 * 86400_000).toISOString();

const SUMMARY = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "604800s", resetTime: in7d, remainingFraction: 0.75 },
        { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "18000s", resetTime: in5h, remainingFraction: 0.4 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      // remainingFraction omitted: proto3 zero → used up
      buckets: [{ bucketId: "3p-5h", displayName: "Five Hour Limit Remaining", window: "18000s", resetTime: in5h }],
    },
  ],
};

describe("windowsFromSummary", () => {
  test("short labels, 5h before weekly, missing fraction = used up", () => {
    const ws = windowsFromSummary(SUMMARY);
    expect(ws.map((w) => [w.id, w.label, w.usedPercent, w.windowSeconds])).toEqual([
      ["gemini-5h", "Gemini 5h", 60, 18000],
      ["gemini-weekly", "Gemini Weekly", 25, 604800],
      ["3p-5h", "Claude and GPT 5h", 100, 18000],
    ]);
  });
});

describe("fetchAntigravity", () => {
  test("no Antigravity login: no card, as for Kimi and MiniMax", async () => {
    expect(await fetchAntigravity({}, [])).toBeNull();
  });

  test("a SUBSCRIPTION_REQUIRED from any endpoint is what the card says", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://daily-cloudcode-pa.googleapis.com")) {
        return new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED", details: [{ reason: "SUBSCRIPTION_REQUIRED" }] } }), { status: 403 });
      }
      if (url.includes("sandbox")) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify({ error: { status: "PERMISSION_DENIED" } }), { status: 403 });
    }) as unknown as typeof fetch;
    const { sources } = piSource({ antigravity: { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000 } });
    const r = await fetchAntigravity({}, sources);
    expect(r!.ok).toBe(false);
    expect(r!.error).toBe("Quota summary needs a paid Google AI plan");
  });

  test("while pi runs, an expired token is refreshed for our call only; pi's file is left alone", async () => {
    installPiClient();
    let refreshed = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        refreshed += 1;
        return new Response(JSON.stringify({ access_token: "ours", expires_in: 3600 }));
      }
      if (new Headers(init?.headers).get("authorization") !== "Bearer ours") return new Response("unauthorized", { status: 401 });
      if (url.endsWith(":retrieveUserQuotaSummary")) return new Response(JSON.stringify(SUMMARY));
      return new Response(JSON.stringify({}));
    }) as unknown as typeof fetch;
    const auth = { antigravity: { type: "oauth", access: "old", refresh: "r1", expires: Date.now() - 1000 } } as AuthFile;
    const { path } = piSource(auth);
    const before = readFileSync(path, "utf8");
    setRunningProcesses(["pi"]);
    try {
      const src = antigravitySources({ opencode: {}, opencodePath: "/nonexistent", pi: auth, piPath: path });
      const r = await fetchAntigravity({}, src);
      expect(r!.ok).toBe(true);
      expect(refreshed).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      setRunningProcesses([]);
    }
  });

  test("reads quota pools and the paid plan, falling through a 404 endpoint", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url.startsWith("https://daily-cloudcode-pa.googleapis.com")) return new Response("nope", { status: 404 });
      if (url.endsWith(":retrieveUserQuotaSummary")) return new Response(JSON.stringify(SUMMARY));
      return new Response(JSON.stringify({ currentTier: { name: "Free" }, paidTier: { name: "Google AI Pro" } }));
    }) as typeof fetch;

    const { sources } = piSource({
      antigravity: { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3600_000 },
    });
    const r = await fetchAntigravity({}, sources);
    expect(r!.ok).toBe(true);
    expect(r!.plan).toBe("Google AI Pro");
    expect(r!.source).toBe("pi");
    expect(r!.usedPercent).toBe(100);
    expect(seen.some((u) => u.startsWith("https://daily-cloudcode-pa.sandbox.googleapis.com"))).toBe(true);
  });

  test("expired token is refreshed with pi-antigravity's client and written back to pi", async () => {
    installPiClient();
    let refreshBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        refreshBody = String(init?.body);
        return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }));
      }
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== "Bearer fresh") return new Response("unauthorized", { status: 401 });
      if (url.endsWith(":retrieveUserQuotaSummary")) return new Response(JSON.stringify(SUMMARY));
      return new Response(JSON.stringify({}));
    }) as typeof fetch;

    const { path, sources } = piSource({
      antigravity: { type: "oauth", access: "old", refresh: "r1", expires: Date.now() - 1000, projectId: "p1" } as never,
    });
    const r = await fetchAntigravity({}, sources);
    expect(r!.ok).toBe(true);
    expect(refreshBody).toContain("client_id=fake-id");
    expect(refreshBody).toContain("client_secret=fake-secret");
    expect(refreshBody).toContain("refresh_token=r1");
    const saved = JSON.parse(readFileSync(path, "utf8")).antigravity;
    expect(saved.access).toBe("fresh");
    expect(saved.refresh).toBe("r1");
    expect(saved.projectId).toBe("p1");
  });
});

describe("antigravityClient", () => {
  test("the environment wins over pi-antigravity", async () => {
    installPiClient();
    process.env.ANTIGRAVITY_CLIENT_ID = "env-id";
    process.env.ANTIGRAVITY_CLIENT_SECRET = "env-secret";
    expect(await antigravityClient()).toEqual({ id: "env-id", secret: "env-secret" });
  });

  test("a pi-antigravity that fails to load says so, not 'install it'", async () => {
    const piDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "llm-usage-bad-pi-"));
    tempDirs.push(process.env.PI_CODING_AGENT_DIR);
    const bad = join(process.env.PI_CODING_AGENT_DIR, "npm", "node_modules", "pi-antigravity", "src", "auth", "oauth.ts");
    mkdirSync(join(bad, ".."), { recursive: true });
    writeFileSync(bad, 'import "./missing-module.js";\nexport const CLIENT_ID = "x";\n');
    try {
      await expect(antigravityClient()).rejects.toThrow(/failed to load/);
    } finally {
      process.env.PI_CODING_AGENT_DIR = piDir;
    }
  });

  test("without either, it says how to get one", async () => {
    // a pi dir never imported before (imports are cached per path)
    const piDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "llm-usage-no-pi-"));
    tempDirs.push(process.env.PI_CODING_AGENT_DIR);
    try {
      await expect(antigravityClient()).rejects.toThrow(/install pi-antigravity/);
    } finally {
      process.env.PI_CODING_AGENT_DIR = piDir;
    }
  });
});
