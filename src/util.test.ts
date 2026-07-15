import { describe, expect, test } from "bun:test";
import {
  bar,
  clampPercent,
  formatDuration,
  formatReset,
  isoFromEpochMs,
  isoFromEpochSec,
  secondsUntil,
} from "./util.ts";

describe("clampPercent", () => {
  test("clamps to 0–100", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(0)).toBe(0);
    expect(clampPercent(50)).toBe(50);
    expect(clampPercent(100)).toBe(100);
    expect(clampPercent(150)).toBe(100);
  });

  test("NaN becomes 0", () => {
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe("formatDuration", () => {
  test("formats days hours minutes", () => {
    expect(formatDuration(90)).toBe("1m");
    expect(formatDuration(3700)).toBe("1h 1m");
    expect(formatDuration(90000)).toBe("1d 1h");
  });

  test("unknown for invalid", () => {
    expect(formatDuration(undefined)).toBe("?");
    expect(formatDuration(-1)).toBe("?");
  });
});

describe("bar", () => {
  test("renders fixed width", () => {
    expect(bar(0, 10)).toBe("░░░░░░░░░░");
    expect(bar(100, 10)).toBe("██████████");
    expect(bar(50, 10).length).toBe(10);
  });
});

describe("iso helpers", () => {
  test("isoFromEpochMs", () => {
    expect(isoFromEpochMs(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(isoFromEpochMs(undefined)).toBeUndefined();
  });

  test("isoFromEpochSec", () => {
    expect(isoFromEpochSec(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  test("secondsUntil future", () => {
    const future = new Date(Date.now() + 5000).toISOString();
    const s = secondsUntil(future);
    expect(s).toBeGreaterThanOrEqual(3);
    expect(s).toBeLessThanOrEqual(6);
  });
});

describe("formatReset", () => {
  test("prefers seconds", () => {
    expect(formatReset(undefined, 120)).toBe("2m");
  });
});
