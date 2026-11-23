// Preloaded by `bun test` (bunfig.toml): point every credential store at an
// empty sandbox so tests never read or rotate the real ~/.claude, ~/.codex, ~/.pi.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRunningProcesses } from "./procs.ts";

const sandbox = mkdtempSync(join(tmpdir(), "llm-usage-test-home-"));
process.env.HOME = sandbox;
process.env.CLAUDE_CREDENTIALS_PATH = join(sandbox, "claude", ".credentials.json");
process.env.CLAUDE_PROJECTS_DIR = join(sandbox, "claude", "projects");
process.env.CODEX_HOME = join(sandbox, "codex");
process.env.PI_CODING_AGENT_DIR = join(sandbox, "pi");
process.env.GROK_AUTH_PATH = join(sandbox, "grok", "auth.json");
process.env.OPENCODE_AUTH_PATH = join(sandbox, "opencode", "auth.json");
process.env.XDG_STATE_HOME = join(sandbox, "state");
process.env.XDG_CACHE_HOME = join(sandbox, "cache");
process.env.XDG_CONFIG_HOME = join(sandbox, "config");
for (const k of [
  "ZAI_API_KEY", "Z_AI_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY",
  "MINIMAX_API_KEY", "KIMI_TOKEN", "KIMI_ACCESS_TOKEN",
  "ANTIGRAVITY_CLIENT_ID", "ANTIGRAVITY_CLIENT_SECRET", "NOAGY_CLIENT_ID", "NOAGY_CLIENT_SECRET",
]) {
  delete process.env[k];
}
setRunningProcesses([]);
