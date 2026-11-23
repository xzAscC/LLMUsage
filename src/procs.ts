import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";

/**
 * Names of every running process: `comm` plus the basename of argv[0]
 * (node/bun CLIs like pi keep their own comm, daemons like codex's app-server
 * show up via argv[0]), and the executable behind each name. Read once per
 * CLI run.
 */
interface ProcTable {
  names: Set<string>;
  /** name → executable paths ("" when /proc/<pid>/exe is unreadable) */
  exes: Map<string, string[]>;
}

let cached: ProcTable | null = null;

function scan(procRoot: string): ProcTable {
  const table: ProcTable = { names: new Set(), exes: new Map() };
  let entries: string[] = [];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return table;
  }
  for (const pid of entries) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const names: string[] = [];
    try {
      names.push(readFileSync(`${procRoot}/${pid}/comm`, "utf8").trim());
    } catch {
      continue;
    }
    try {
      const argv0 = readFileSync(`${procRoot}/${pid}/cmdline`, "utf8").split("\0")[0];
      if (argv0) names.push(basename(argv0));
    } catch {
      // process exited between reads
    }
    let exe = "";
    try {
      exe = readlinkSync(`${procRoot}/${pid}/exe`);
    } catch {
      // another user's process, or gone
    }
    for (const n of new Set(names)) {
      table.names.add(n);
      table.exes.set(n, [...(table.exes.get(n) ?? []), exe]);
    }
  }
  return table;
}

function table(procRoot = "/proc"): ProcTable {
  if (procRoot !== "/proc") return scan(procRoot);
  return (cached ??= scan(procRoot));
}

export function runningProcessNames(procRoot = "/proc"): Set<string> {
  return table(procRoot).names;
}

/** Executables of the running processes called `name`. */
export function runningExes(name: string): string[] {
  return table().exes.get(name) ?? [];
}

/**
 * Tests pin the process table; pass null to go back to /proc. A name given
 * without an executable counts as one process whose executable is unknown.
 */
export function setRunningProcesses(names: Iterable<string> | null, exes: Record<string, string[]> = {}): void {
  if (!names) {
    cached = null;
    return;
  }
  const set = new Set(names);
  cached = { names: set, exes: new Map([...set].map((n) => [n, exes[n] ?? [""]])) };
}

export function isAnyRunning(names: string[]): boolean {
  const running = runningProcessNames();
  return names.some((n) => running.has(n));
}
