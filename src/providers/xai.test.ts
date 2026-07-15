import { afterEach, describe, expect, test } from "bun:test";
import { fetchXai } from "./xai.ts";
import type { AuthFile } from "../auth.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchXai", () => {
  test("missing oauth", async () => {
    const r = await fetchXai({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No xAI OAuth/i);
  });

  test("maps monthly allowance", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/billing") && !url.includes("format=")) {
        return new Response(
          JSON.stringify({
            config: {
              monthlyLimit: { val: 20000 },
              used: { val: 2000 },
              onDemandCap: { val: 0 },
              billingPeriodEnd: new Date(Date.now() + 86400_000).toISOString(),
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/settings")) {
        return new Response(
          JSON.stringify({ subscription_tier_display: "X Premium+" }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    const auth: AuthFile = {
      xai: { type: "oauth", access: "SECRET_XAI_TOKEN" },
    };
    const r = await fetchXai(auth);
    expect(r.ok).toBe(true);
    expect(r.plan).toBe("X Premium+");
    expect(r.usedPercent).toBe(10);
    expect(r.windows.some((w) => w.label === "Monthly")).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/SECRET_XAI_TOKEN/);
  });
});
