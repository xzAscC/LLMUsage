import { describe, expect, test } from "bun:test";
import {
  finalizeProvider,
  finalizeSnapshot,
  severityFromPercent,
  worseSeverity,
} from "./severity.ts";

describe("severityFromPercent", () => {
  test("thresholds", () => {
    expect(severityFromPercent(undefined)).toBe("unknown");
    expect(severityFromPercent(0)).toBe("ok");
    expect(severityFromPercent(69)).toBe("ok");
    expect(severityFromPercent(70)).toBe("warn");
    expect(severityFromPercent(89)).toBe("warn");
    expect(severityFromPercent(90)).toBe("crit");
  });
});

describe("worseSeverity", () => {
  test("picks worse", () => {
    expect(worseSeverity("ok", "warn")).toBe("warn");
    expect(worseSeverity("crit", "error")).toBe("error");
    expect(worseSeverity("error", "ok")).toBe("error");
  });
});

describe("finalizeProvider", () => {
  test("derives usedPercent from windows", () => {
    const p = finalizeProvider({
      id: "openai",
      name: "OpenAI",
      ok: true,
      windows: [
        { id: "a", label: "A", usedPercent: 10 },
        { id: "b", label: "B", usedPercent: 40 },
      ],
      fetchedAt: new Date().toISOString(),
    });
    expect(p.usedPercent).toBe(40);
    expect(p.severity).toBe("ok");
  });

  test("error when not ok", () => {
    const p = finalizeProvider({
      id: "zai",
      name: "GLM",
      ok: false,
      error: "no key",
      windows: [],
      fetchedAt: new Date().toISOString(),
    });
    expect(p.severity).toBe("error");
  });
});

describe("finalizeSnapshot", () => {
  test("worst across providers", () => {
    const a = finalizeProvider({
      id: "openai",
      name: "OpenAI",
      ok: true,
      windows: [{ id: "w", label: "W", usedPercent: 20 }],
      fetchedAt: new Date().toISOString(),
    });
    const b = finalizeProvider({
      id: "xai",
      name: "Grok",
      ok: true,
      windows: [{ id: "w", label: "W", usedPercent: 75 }],
      fetchedAt: new Date().toISOString(),
    });
    const snap = finalizeSnapshot([a, b]);
    expect(snap.worstUsedPercent).toBe(75);
    expect(snap.severity).toBe("warn");
  });
});
