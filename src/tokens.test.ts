import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelLabel, scanTokens, tokenSeries, type ModelDays } from "./tokens.ts";

const roots = [process.env.CLAUDE_PROJECTS_DIR!, join(process.env.CODEX_HOME!, "sessions"), join(process.env.PI_CODING_AGENT_DIR!, "sessions")];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function jsonl(path: string, rows: object[]) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const ts = new Date(Date.now() - 3600_000).toISOString();
const cc = (id: string, model: string, n: number) => ({
  type: "assistant",
  timestamp: ts,
  requestId: `req-${id}`,
  message: { id, model, usage: { input_tokens: n, output_tokens: 0, cache_read_input_tokens: 0 } },
});

describe("modelLabel", () => {
  test("Claude ids read as their product names; others stay", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-fable-5-2")).toBe("Fable 5.2");
    expect(modelLabel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelLabel("claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("gpt-6-astra")).toBe("gpt-6-astra");
    expect(modelLabel("<synthetic>")).toBe("unknown");
    expect(modelLabel(undefined)).toBe("unknown");
  });
});

describe("tokens per model", () => {
  test("Claude Code, Codex (model from turn_context) and pi, biggest first", () => {
    jsonl(join(roots[0]!, "proj", "a.jsonl"), [cc("m1", "claude-opus-5-5", 100), cc("m1", "claude-opus-5-5", 100), cc("m2", "claude-fable-5-2", 30)]);
    jsonl(join(roots[1]!, "2026", "11", "22", "rollout-x.jsonl"), [
      { timestamp: ts, type: "turn_context", payload: { model: "gpt-6-astra" } },
      { timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 50 } } } },
      { timestamp: ts, type: "turn_context", payload: { model: "gpt-6.2-sol" } },
      { timestamp: ts, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 20 } } } },
    ]);
    jsonl(join(roots[2]!, "s", "b.jsonl"), [
      { type: "message", timestamp: ts, message: { role: "assistant", provider: "antigravity", model: "claude-opus-4-6", usage: { totalTokens: 7 } } },
      { type: "message", timestamp: ts, message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: { totalTokens: 60 } } },
    ]);
    jsonl(join(roots[0]!, "proj", "b.jsonl"), [cc("m3", "claude-opus-4-6", 5)]);

    const models: ModelDays = {};
    const data = scanTokens(2, Date.now(), models);
    const series = tokenSeries(data, 2, Date.now(), models);
    const totals = series.models.map((m) => [m.label, m.source, m.days.reduce((a, b) => a + b, 0)]);
    expect(totals).toEqual([
      ["Opus 5.5", "Claude Code", 100], // duplicate message id counted once
      ["glm-5.3", "pi", 60],
      ["gpt-6-astra", "Codex", 50],
      ["Fable 5.2", "Claude Code", 30],
      ["gpt-6.2-sol", "Codex", 20],
      ["Opus 4.6 (pi)", "pi", 7], // same name from two agents: say which
      ["Opus 4.6 (Claude Code)", "Claude Code", 5],
    ]);
    // per-agent totals unchanged
    expect(series.sources["Claude Code"].reduce((a, b) => a + b, 0)).toBe(135);
  });
});
