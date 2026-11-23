import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

/**
 * Names of every running process: `comm` plus the basename of argv[0]
 * (node/bun CLIs like pi keep their own comm, daemons like codex's app-server
 * show up via argv[0]). Read once per CLI run.
 */
let cached: Set<string> | null = null;

export function runningProcessNames(procRoot = "/proc"): Set<string> {
  if (cached && procRoot === "/proc") return cached;
  const names = new Set<string>();
  let entries: string[] = [];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return names;
  }
  for (const pid of entries) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      names.add(readFileSync(`${procRoot}/${pid}/comm`, "utf8").trim());
    } catch {
      continue;
    }
    try {
      const argv0 = readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").split("\0")[0];
      if (argv0) names.add(basename(argv0));
    } catch {
      // process exited between reads
    }
  }
  if (procRoot === "/proc") cached = names;
  return names;
}

/** Tests pin the process table; pass null to go back to /proc. */
export function setRunningProcesses(names: Iterable<string> | null): void {
  cached = names ? new Set(names) : null;
}

export function isAnyRunning(names: string[]): boolean {
  const running = runningProcessNames();
  return names.some((n) => running.has(n));
}
