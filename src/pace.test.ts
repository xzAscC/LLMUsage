import { describe, expect, test } from "bun:test";
import { paceFor } from "./pace.ts";

const now = Date.parse("2026-10-01T12:00:00Z");
const hour = 3600;

function win(used: number, elapsedFrac: number, dur = 5 * hour) {
  const reset = now + (1 - elapsedFrac) * dur * 1000;
  return { id: "w", label: "w", usedPercent: used, windowSeconds: dur, resetsAt: new Date(reset).toISOString() };
}

describe("paceFor", () => {
  test("reserve when under even burn", () => {
    expect(paceFor(win(20, 0.5), now)).toMatchObject({ kind: "reserve", marginPercent: 30 });
  });
  test("deficit projects the run-out time", () => {
    const p = paceFor(win(80, 0.4), now)!;
    expect(p.kind).toBe("deficit");
    expect(p.projectedPercent).toBe(200);
    // start = now - 2h; runs out at 0.5 of 5h = start + 2.5h
    expect(Date.parse(p.runsOutAt!)).toBe(now + 0.5 * hour * 1000);
  });
  test("even inside the dead band", () => {
    expect(paceFor(win(51, 0.5), now)?.kind).toBe("even");
  });
  test("hidden when too early, exhausted or windowless", () => {
    expect(paceFor(win(1, 0.01), now)).toBeUndefined();
    expect(paceFor(win(100, 0.5), now)).toBeUndefined();
    expect(paceFor({ id: "w", label: "w", usedPercent: 10 }, now)).toBeUndefined();
  });
});
