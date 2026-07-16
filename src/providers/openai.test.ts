import { afterEach, describe, expect, test } from "bun:test";
import { fetchOpenAI } from "./openai.ts";
import type { AuthFile } from "../auth.ts";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const originalFetch = globalThis.fetch;
const originalConfig = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfig;
});

function mockOpenAiApis() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("rate-limit-reset-credits")) {
      return new Response(
        JSON.stringify({
          available_count: 4,
          credits: [
            { status: "available", expires_at: "2026-07-18T00:13:27.502577Z" },
            { status: "available", expires_at: "2026-07-26T23:44:31.765551Z" },
            { status: "available", expires_at: "2026-07-31T19:05:05.622290Z" },
            { status: "available", expires_at: "2026-08-12T17:31:01.503674Z" },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 15,
            limit_window_seconds: 604800,
            reset_after_seconds: 1000,
            reset_at: 1700000000,
          },
          secondary_window: null,
        },
        credits: { has_credits: true, balance: "12.5" },
        rate_limit_reset_credits: { available_count: 4 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

function writeConfig(display: "all" | "summary") {
  const root = join(tmpdir(), `llm-usage-cfg-${Date.now()}-${Math.random()}`);
  const dir = join(root, "llm-usage");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ openai: { resetCreditsDisplay: display } }),
  );
  process.env.XDG_CONFIG_HOME = root;
  return root;
}

describe("fetchOpenAI", () => {
  test("missing oauth", async () => {
    const r = await fetchOpenAI({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No OpenAI OAuth/i);
  });

  test("default all mode lists every reset expiry", async () => {
    const root = writeConfig("all");
    mockOpenAiApis();
    const auth: AuthFile = {
      openai: { type: "oauth", access: "SECRET_TOKEN", accountId: "acc" },
    };
    const r = await fetchOpenAI(auth);
    expect(r.ok).toBe(true);
    const resets = r.windows.filter((w) => w.id.startsWith("rate-reset"));
    expect(resets.some((w) => w.id === "rate-resets")).toBe(true);
    expect(r.windows.find((w) => w.id === "rate-resets")?.note).toBe(
      "4 available",
    );
    expect(resets.filter((w) => w.id.startsWith("rate-reset-")).length).toBe(4);
    expect(r.windows.some((w) => w.note?.includes("exp 7/18"))).toBe(true);
    expect(r.windows.some((w) => w.note?.includes("exp 8/12"))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/SECRET_TOKEN/);
    rmSync(root, { recursive: true, force: true });
  });

  test("summary mode shows count + next expiry only", async () => {
    const root = writeConfig("summary");
    mockOpenAiApis();
    const auth: AuthFile = {
      openai: { type: "oauth", access: "SECRET_TOKEN", accountId: "acc" },
    };
    const r = await fetchOpenAI(auth);
    const reset = r.windows.find((w) => w.id === "rate-resets");
    expect(reset?.note).toContain("4 available");
    expect(reset?.note).toContain("next exp 7/18");
    expect(r.windows.filter((w) => w.id.startsWith("rate-reset-")).length).toBe(
      0,
    );
    rmSync(root, { recursive: true, force: true });
  });
});
