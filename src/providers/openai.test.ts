import { afterEach, describe, expect, test } from "bun:test";
import { fetchOpenAI } from "./openai.ts";
import type { AuthFile } from "../auth.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchOpenAI", () => {
  test("missing oauth", async () => {
    const r = await fetchOpenAI({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No OpenAI OAuth/i);
  });

  test("maps wham windows, credits, and rate resets", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("rate-limit-reset-credits")) {
        return new Response(
          JSON.stringify({
            available_count: 4,
            credits: [
              {
                status: "available",
                expires_at: "2026-07-18T00:13:27.502577Z",
              },
              {
                status: "available",
                expires_at: "2026-08-12T17:31:01.503674Z",
              },
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

    const auth: AuthFile = {
      openai: { type: "oauth", access: "SECRET_TOKEN", accountId: "acc" },
    };
    const r = await fetchOpenAI(auth);
    expect(r.ok).toBe(true);
    expect(r.plan).toBe("plus");
    expect(r.usedPercent).toBe(15);
    expect(r.windows.some((w) => w.label === "Weekly")).toBe(true);
    expect(r.windows.some((w) => w.note?.includes("12.5"))).toBe(true);
    const resets = r.windows.find((w) => w.id === "rate-resets");
    expect(resets?.label).toBe("Resets");
    expect(resets?.note).toContain("4 available");
    expect(resets?.note).toContain("next exp");
    expect(JSON.stringify(r)).not.toMatch(/SECRET_TOKEN/);
  });
});
