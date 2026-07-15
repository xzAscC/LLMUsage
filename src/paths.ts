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

export function cacheDir(): string {
  return join(xdgCacheHome(), "llm-usage");
}

export function cacheSnapshotPath(): string {
  return join(cacheDir(), "snapshot.json");
}

export function configPath(): string {
  return join(xdgConfigHome(), "llm-usage", "config.json");
}
