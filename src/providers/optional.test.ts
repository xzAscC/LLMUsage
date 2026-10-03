import { describe, expect, test } from "bun:test";
import { fetchKimi, mapKimiUsages } from "./kimi.ts";
import { fetchMinimax, mapMinimaxRemains } from "./minimax.ts";

describe("optional providers", () => {
  test("are omitted when not configured", async () => {
    expect(await fetchKimi([])).toBeNull();
    expect(await fetchMinimax({}, [])).toBeNull();
  });

  test("Kimi maps the 5h window and plan period", () => {
    const w = mapKimiUsages({
      usages: [
        {
          scope: "FEATURE_CODING",
          detail: { limit: "100", used: "22", resetTime: "2026-10-04T00:00:00.000000Z" },
          limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "58" } }],
        },
      ],
    });
    expect(w.map((x) => [x.label, x.usedPercent, x.windowSeconds])).toEqual([
      ["Session 5h", 58, 18000],
      ["Plan period", 22, undefined],
    ]);
  });

  test("MiniMax inverts remaining % and marks uncapped windows", () => {
    const w = mapMinimaxRemains({
      model_remains: [
        {
          model_name: "general",
          start_time: 0,
          end_time: 18_000_000,
          current_interval_remaining_percent: 89,
          current_interval_status: 1,
          current_weekly_remaining_percent: 100,
          current_weekly_status: 3,
        },
      ],
    });
    expect(w[0]).toMatchObject({ usedPercent: 11, windowSeconds: 18000 });
    expect(w[1]).toMatchObject({ note: "unlimited" });
    expect(w[1]!.usedPercent).toBeUndefined();
  });
});
