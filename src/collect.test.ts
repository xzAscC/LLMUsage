import { describe, expect, test } from "bun:test";
import { withStaleFallback } from "./collect.ts";
import { recordSnapshot, seriesFor } from "./history.ts";
import type { ProviderStatus, UsageSnapshot } from "./types.ts";

const now = Date.parse("2026-10-01T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function good(): ProviderStatus {
  return {
    id: "zai",
    name: "GLM",
    ok: true,
    severity: "ok",
    fetchedAt: iso(now - 3600_000),
    usedPercent: 40,
    windows: [
      { id: "session", label: "Session", usedPercent: 40, resetsAt: iso(now - 60_000) },
      { id: "weekly", label: "Weekly", usedPercent: 30, resetsAt: iso(now + 86400_000) },
    ],
  };
}

const failed: ProviderStatus = { id: "zai", name: "GLM", ok: false, error: "boom", severity: "error", fetchedAt: iso(now), windows: [] };

describe("withStaleFallback", () => {
  test("keeps the last good reading, minus windows that already reset", () => {
    const prev: UsageSnapshot = { fetchedAt: "", severity: "ok", providers: [good()] };
    const p = withStaleFallback(failed, prev, now);
    expect(p.ok).toBe(true);
    expect(p.stale).toBe(true);
    expect(p.error).toBe("boom");
    expect(p.windows.map((w) => w.id)).toEqual(["weekly"]);
  });

  test("a stale reading says when the current login ends, never an older one's", () => {
    const prev: UsageSnapshot = { fetchedAt: "", severity: "ok", providers: [{ ...good(), loginExpiresAt: iso(now - 86400_000) }] };
    const p = withStaleFallback({ ...failed, loginExpiresAt: iso(now + 3600_000) }, prev, now);
    expect(p.stale).toBe(true);
    expect(p.loginExpiresAt).toBe(iso(now + 3600_000));
    expect(withStaleFallback(failed, prev, now).loginExpiresAt).toBeUndefined();
  });

  test("gives up on readings older than three days", () => {
    const old = { ...good(), fetchedAt: iso(now - 4 * 86400_000) };
    expect(withStaleFallback(failed, { fetchedAt: "", severity: "ok", providers: [old] }, now).ok).toBe(false);
  });
});

describe("history", () => {
  test("records daily peak and mean, skipping stale providers", () => {
    const at = new Date(now);
    const s = (used: number, stale = false): UsageSnapshot => ({
      fetchedAt: "",
      severity: "ok",
      providers: [{ ...good(), stale, windows: [{ id: "weekly", label: "Weekly", usedPercent: used }] }],
    });
    let store = recordSnapshot({}, s(10), 30, at);
    store = recordSnapshot(store, s(30), 30, at);
    store = recordSnapshot(store, s(90, true), 30, at);
    const [series] = seriesFor(store, 2, at);
    expect(series!.peaks.at(-1)).toBe(30);
    expect(series!.means.at(-1)).toBe(20);
  });
});
