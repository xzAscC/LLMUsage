import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("loadConfig", () => {
  test("defaults to all for reset display", () => {
    expect(DEFAULT_CONFIG.openai.resetCreditsDisplay).toBe("all");
    expect(loadConfig("/no/such/config.json").openai.resetCreditsDisplay).toBe(
      "all",
    );
  });

  test("reads summary from file", () => {
    const root = join(tmpdir(), `cfg-${Date.now()}`);
    const dir = join(root, "llm-usage");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ openai: { resetCreditsDisplay: "summary" } }),
    );
    expect(loadConfig(path).openai.resetCreditsDisplay).toBe("summary");
    rmSync(root, { recursive: true, force: true });
  });
});
