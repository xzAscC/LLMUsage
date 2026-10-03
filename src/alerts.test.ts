import { describe, expect, test } from "bun:test";
import { EMPTY_STATE, evaluateAlerts } from "./alerts.ts";
import type { UsageSnapshot } from "./types.ts";

const cfg = { thresholds: [75, 90, 95], exhausted: true, pace: false, refilled: true };

function snap(used: number, extra: Partial<UsageSnapshot["providers"][0]> = {}): UsageSnapshot {
  return {
    fetchedAt: "",
    severity: "ok",
    providers: [
      {
        id: "anthropic",
        name: "Claude",
        ok: true,
        severity: "ok",
        fetchedAt: "",
        windows: [{ id: "weekly", label: "Weekly", usedPercent: used }],
        ...extra,
      },
    ],
  };
}

describe("evaluateAlerts", () => {
  test("fires once per crossing, at the highest level passed", () => {
    let r = evaluateAlerts(snap(92), cfg, EMPTY_STATE);
    expect(r.alerts).toEqual([expect.objectContaining({ kind: "crossed", percent: 92 })]);
    r = evaluateAlerts(snap(93), cfg, r.state);
    expect(r.alerts).toEqual([]);
    r = evaluateAlerts(snap(96), cfg, r.state);
    expect(r.alerts.map((a) => a.kind)).toEqual(["crossed"]);
  });

  test("exhausted then restored, without a duplicate refilled", () => {
    let r = evaluateAlerts(snap(100), cfg, EMPTY_STATE);
    expect(r.alerts.map((a) => a.kind)).toEqual(["exhausted"]);
    r = evaluateAlerts(snap(3), cfg, r.state);
    expect(r.alerts.map((a) => a.kind)).toEqual(["restored"]);
  });

  test("refilled after a plain crossing resets", () => {
    let r = evaluateAlerts(snap(80), cfg, EMPTY_STATE);
    r = evaluateAlerts(snap(2), cfg, r.state);
    expect(r.alerts.map((a) => a.kind)).toEqual(["refilled"]);
  });

  test("ignores stale readings", () => {
    expect(evaluateAlerts(snap(99, { stale: true }), cfg, EMPTY_STATE).alerts).toEqual([]);
  });
});
