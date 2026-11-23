import { afterEach, describe, expect, test } from "bun:test";
import { claudeAccountSources, fetchAnthropic, refreshClaudeToken } from "./anthropic.ts";
import type { AuthFile } from "../auth.ts";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const originalFetch = globalThis.fetch;
const originalCred = process.env.CLAUDE_CREDENTIALS_PATH;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCred === undefined) delete process.env.CLAUDE_CREDENTIALS_PATH;
  else process.env.CLAUDE_CREDENTIALS_PATH = originalCred;
});

function writeClaudeCreds(oauth: Record<string, unknown>) {
  const dir = join(tmpdir(), `claude-cred-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, ".credentials.json");
  writeFileSync(path, JSON.stringify({ claudeAiOauth: oauth }));
  process.env.CLAUDE_CREDENTIALS_PATH = path;
  return dir;
}

describe("fetchAnthropic", () => {
  test("missing credentials", async () => {
    process.env.CLAUDE_CREDENTIALS_PATH = "/no/such/credentials.json";
    const r = await fetchAnthropic({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No Claude credentials|auth login/i);
  });

  test("maps legacy five_hour and seven_day", async () => {
    const dir = writeClaudeCreds({
      accessToken: "SECRET_CLAUDE_TOKEN",
      refreshToken: "",
      expiresAt: Date.now() + 3600_000,
      subscriptionType: "pro",
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          five_hour: {
            utilization: 12,
            resets_at: "2026-07-16T20:00:00Z",
          },
          seven_day: {
            utilization: 40,
            resets_at: "2026-07-20T12:00:00Z",
          },
          seven_day_opus: null,
        }),
        { status: 200 },
      )) as typeof fetch;

    const r = await fetchAnthropic({});
    expect(r.ok).toBe(true);
    expect(r.plan).toBe("pro");
    expect(r.usedPercent).toBe(40);
    expect(r.windows.some((w) => w.label === "Session 5h")).toBe(true);
    expect(r.windows.some((w) => w.label === "Weekly")).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/SECRET_CLAUDE_TOKEN/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("maps limits array shape", async () => {
    const dir = writeClaudeCreds({
      accessToken: "SECRET_CLAUDE_TOKEN",
      expiresAt: Date.now() + 3600_000,
      subscriptionType: "max",
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          limits: [
            {
              kind: "session",
              percent: 5,
              resets_at: "2026-07-16T18:00:00Z",
            },
            {
              kind: "weekly_all",
              percent: 22,
              resets_at: "2026-07-20T18:00:00Z",
            },
            {
              kind: "weekly_scoped",
              percent: 10,
              resets_at: "2026-07-20T18:00:00Z",
              scope: { model: { display_name: "Opus" } },
            },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;

    const r = await fetchAnthropic({});
    expect(r.ok).toBe(true);
    expect(r.windows.some((w) => w.label === "Session 5h")).toBe(true);
    expect(r.windows.some((w) => w.label === "Weekly")).toBe(true);
    expect(r.windows.some((w) => w.label === "Opus")).toBe(true);
    expect(r.usedPercent).toBe(22);
    rmSync(dir, { recursive: true, force: true });
  });

  test("surfaces rate limit cleanly", async () => {
    const dir = writeClaudeCreds({
      accessToken: "SECRET_CLAUDE_TOKEN",
      expiresAt: Date.now() + 3600_000,
    });
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { type: "rate_limit_error", message: "Rate limited" },
        }),
        { status: 429 },
      )) as typeof fetch;

    const r = await fetchAnthropic({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rate-limited/i);
    rmSync(dir, { recursive: true, force: true });
  });

  test("extra account reads its own config dir as a separate provider", async () => {
    const dir = writeClaudeCreds({
      accessToken: "SECRET_TEAM_TOKEN",
      expiresAt: Date.now() + 3600_000,
      subscriptionType: "team",
    });
    process.env.CLAUDE_CREDENTIALS_PATH = "/no/such/credentials.json";
    let seen = "";
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = (init.headers as Record<string, string>).Authorization!;
      return new Response(JSON.stringify({ five_hour: { utilization: 3 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const account = { name: "OSU", dir };
    const r = await fetchAnthropic({}, claudeAccountSources(account), account);
    expect(r.ok).toBe(true);
    expect(r.id).toBe("anthropic-osu");
    expect(r.name).toBe("Claude OSU");
    expect(r.plan).toBe("team");
    expect(seen).toBe("Bearer SECRET_TEAM_TOKEN");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Claude login lifetime", () => {
  test("refresh asks for the login's scopes and records when the login ends", async () => {
    let body: any = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ access_token: "NEW", refresh_token: "R2", expires_in: 28800, refresh_token_expires_in: 86400, scope: "user:inference user:profile" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const before = Date.now();
    const next = await refreshClaudeToken({ type: "oauth", access: "OLD", refresh: "R1", scopes: ["user:inference", "user:profile", "user:mcp_servers"] });
    expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "R1", scope: "user:inference user:profile user:mcp_servers" });
    expect(next.refresh).toBe("R2");
    expect(next.scopes).toEqual(["user:inference", "user:profile"]);
    expect(next.refreshExpires! - before).toBeGreaterThanOrEqual(86400_000);
    expect(next.refreshExpires! - before).toBeLessThan(86400_000 + 5000);
  });

  test("refresh without the new fields keeps the old login end and scopes", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ access_token: "NEW", expires_in: 100 }), { status: 200 })) as unknown as typeof fetch;
    const next = await refreshClaudeToken({ type: "oauth", access: "OLD", refresh: "R1", scopes: ["a"], refreshExpires: 123 });
    expect(next).toMatchObject({ refresh: "R1", scopes: ["a"], refreshExpires: 123 });
  });

  test("the card carries when the login ends", async () => {
    const ends = Date.now() + 2 * 86400_000;
    writeClaudeCreds({ accessToken: "T", refreshToken: "R", expiresAt: Date.now() + 3600_000, refreshTokenExpiresAt: ends });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ five_hour: { utilization: 1, resets_at: "2099-01-01T00:00:00Z" } }), { status: 200 })) as unknown as typeof fetch;
    const r = await fetchAnthropic({});
    expect(r.ok).toBe(true);
    expect(r.loginExpiresAt).toBe(new Date(ends).toISOString());
  });
});
