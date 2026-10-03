import { homedir } from "node:os";
import { join } from "node:path";

export function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
}

export function xdgCacheHome(): string {
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

export function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

export function opencodeAuthPath(): string {
  return (
    process.env.OPENCODE_AUTH_PATH ||
    join(xdgDataHome(), "opencode", "auth.json")
  );
}

export function xdgStateHome(): string {
  return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}

export function stateDir(): string {
  return join(xdgStateHome(), "llm-usage");
}

export function historyPath(): string {
  return join(stateDir(), "history.json");
}

export function alertStatePath(): string {
  return join(stateDir(), "alerts.json");
}

export function claudeCredentialsPath(): string {
  return (
    process.env.CLAUDE_CREDENTIALS_PATH ||
    join(homedir(), ".claude", ".credentials.json")
  );
}

export function claudeProjectsDir(): string {
  return process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
}

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function codexAuthPath(): string {
  return join(codexHome(), "auth.json");
}

export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function piAuthPath(): string {
  return join(piAgentDir(), "auth.json");
}

export function grokAuthPath(): string {
  return process.env.GROK_AUTH_PATH || join(homedir(), ".grok", "auth.json");
}

export function cacheDir(): string {
  return join(xdgCacheHome(), "llm-usage");
}

export function cacheSnapshotPath(): string {
  return join(cacheDir(), "snapshot.json");
}

export function configDir(): string {
  return join(xdgConfigHome(), "llm-usage");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}
