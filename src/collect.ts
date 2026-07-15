import { loadAuth } from "./auth.ts";
import { finalizeSnapshot } from "./severity.ts";
import type { UsageSnapshot } from "./types.ts";
import { fetchOpenAI } from "./providers/openai.ts";
import { fetchZai } from "./providers/zai.ts";
import { fetchXai } from "./providers/xai.ts";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { cacheDir, cacheSnapshotPath } from "./paths.ts";

export async function collectUsage(): Promise<UsageSnapshot> {
  const auth = loadAuth();
  const providers = await Promise.all([
    fetchOpenAI(auth),
    fetchZai(auth),
    fetchXai(auth),
  ]);
  const snapshot = finalizeSnapshot(providers);
  saveSnapshot(snapshot);
  return snapshot;
}

export function saveSnapshot(snapshot: UsageSnapshot): void {
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(cacheSnapshotPath(), JSON.stringify(snapshot, null, 2));
}

export function loadCachedSnapshot(): UsageSnapshot | null {
  const path = cacheSnapshotPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UsageSnapshot;
  } catch {
    return null;
  }
}

export async function collectOrCache(opts: {
  maxAgeSec?: number;
  force?: boolean;
}): Promise<UsageSnapshot> {
  const maxAge = opts.maxAgeSec ?? 60;
  if (!opts.force) {
    const cached = loadCachedSnapshot();
    if (cached?.fetchedAt) {
      const age = (Date.now() - Date.parse(cached.fetchedAt)) / 1000;
      if (Number.isFinite(age) && age >= 0 && age < maxAge) {
        return cached;
      }
    }
  }
  return collectUsage();
}
