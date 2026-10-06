import { describe, expect, test } from "bun:test";
import { claudeAccountId, DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

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

  test("reads extra Claude accounts and expands ~", () => {
    const root = join(tmpdir(), `cfg-${Date.now()}-acc`);
    mkdirSync(root, { recursive: true });
    const path = join(root, "config.json");
    writeFileSync(
      path,
      JSON.stringify({ claude: { accounts: [{ name: "OSU", dir: "~/.claude-alt" }, { name: "" }] } }),
    );
    const accounts = loadConfig(path).claude.accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.dir).toBe(join(homedir(), ".claude-alt"));
    expect(claudeAccountId(accounts[0]!)).toBe("anthropic-osu");
    rmSync(root, { recursive: true, force: true });
  });
});
