import { describe, expect, test } from "bun:test";
import { formatHuman, formatWaybar } from "./format.ts";
import type { UsageSnapshot } from "./types.ts";

const sample: UsageSnapshot = {
  fetchedAt: "2026-07-15T00:00:00.000Z",
  severity: "ok",
  worstUsedPercent: 12,
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      plan: "plus",
      ok: true,
      usedPercent: 12,
      severity: "ok",
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          usedPercent: 12,
          resetAfterSeconds: 3600,
        },
      ],
      fetchedAt: "2026-07-15T00:00:00.000Z",
    },
    {
      id: "zai",
      name: "GLM / Z.AI",
      ok: false,
      error: "HTTP 401",
      severity: "error",
      windows: [],
      fetchedAt: "2026-07-15T00:00:00.000Z",
    },
    {
      id: "xai",
      name: "Grok / xAI",
      ok: true,
      usedPercent: 5,
      severity: "ok",
      windows: [
        { id: "monthly", label: "Monthly", usedPercent: 5, note: "1/20" },
      ],
      fetchedAt: "2026-07-15T00:00:00.000Z",
    },
  ],
};

describe("formatHuman", () => {
  test("includes providers and errors", () => {
    const text = formatHuman(sample);
    expect(text).toContain("OpenAI");
    expect(text).toContain("GLM / Z.AI");
    expect(text).toContain("Grok / xAI");
    expect(text).toContain("error: HTTP 401");
    expect(text).toContain("12%");
  });
});

describe("formatWaybar", () => {
  test("returns valid waybar JSON", () => {
    const raw = formatWaybar(sample);
    const obj = JSON.parse(raw) as {
      text: string;
      tooltip: string;
      class: string;
      percentage: number;
      alt: string;
    };
    expect(obj.text).toContain("OAI");
    expect(obj.text).toContain("GLM");
    expect(obj.text).toContain("GRK");
    expect(obj.class).toBe("ok");
    expect(obj.percentage).toBe(12);
    expect(obj.alt).toBe("ok");
    expect(obj.tooltip).toContain("OpenAI");
  });

  test("escapes HTML special chars in tooltip", () => {
    const dirty: UsageSnapshot = {
      ...sample,
      providers: [
        {
          ...sample.providers[0]!,
          error: undefined,
          plan: "a & b <c>",
          ok: true,
          windows: sample.providers[0]!.windows,
        },
      ],
    };
    const obj = JSON.parse(formatWaybar(dirty)) as { tooltip: string };
    expect(obj.tooltip).toContain("&amp;");
    expect(obj.tooltip).toContain("&lt;");
    expect(obj.tooltip).toContain("&gt;");
    expect(obj.tooltip).not.toMatch(/(?<!\\n)<(?!\\n)/);
  });
});
