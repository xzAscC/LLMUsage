import { afterEach, describe, expect, test } from "bun:test";
import { fetchOpenAI } from "./openai.ts";
import type { AuthFile } from "../auth.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockJson(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("fetchOpenAI", () => {
  test("missing oauth", async () => {
    const r = await fetchOpenAI({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No OpenAI OAuth/i);
  });

  test("maps wham windows and credits", async () => {
    mockJson({
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
    });
    const auth: AuthFile = {
      openai: { type: "oauth", access: "SECRET_TOKEN", accountId: "acc" },
    };
    const r = await fetchOpenAI(auth);
    expect(r.ok).toBe(true);
    expect(r.plan).toBe("plus");
    expect(r.usedPercent).toBe(15);
    expect(r.windows.some((w) => w.label === "Weekly")).toBe(true);
    expect(r.windows.some((w) => w.note?.includes("12.5"))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/SECRET_TOKEN/);
  });
});
