import { afterEach, describe, expect, test } from "bun:test";
import { fetchZai } from "./zai.ts";
import type { AuthFile } from "../auth.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchZai", () => {
  test("missing key", async () => {
    const r = await fetchZai({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No zai-coding-plan/i);
  });

  test("maps token and tool limits", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("quota/limit")) {
        return new Response(
          JSON.stringify({
            code: 200,
            success: true,
            data: {
              limits: [
                {
                  type: "TOKENS_LIMIT",
                  unit: 3,
                  number: 5,
                  percentage: 11,
                  nextResetTime: Date.now() + 3600_000,
                },
                {
                  type: "TIME_LIMIT",
                  unit: 5,
                  number: 1,
                  percentage: 0,
                  usage: 4000,
                  currentValue: 0,
                  remaining: 4000,
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          code: 200,
          success: true,
          data: [{ productName: "GLM Coding Max", status: "VALID" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const auth: AuthFile = {
      "zai-coding-plan": { type: "api", key: "SECRET_ZAI_KEY" },
    };
    const r = await fetchZai(auth);
    expect(r.ok).toBe(true);
    expect(r.plan).toBe("GLM Coding Max");
    expect(r.usedPercent).toBe(11);
    expect(r.windows.some((w) => w.label.includes("Session"))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/SECRET_ZAI_KEY/);
  });
});
