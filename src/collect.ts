import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import type { AuthFile } from "./auth.ts";
import { claudeAccountId, loadConfig } from "./config.ts";
import { loadStores } from "./credentials.ts";
import { appendHistory } from "./history.ts";
import { cacheDir, cacheSnapshotPath } from "./paths.ts";
import { finalizeProvider, finalizeSnapshot } from "./severity.ts";
import type { ProviderStatus, UsageSnapshot } from "./types.ts";
import { secondsUntil } from "./util.ts";
import { fetchOpenAI } from "./providers/openai.ts";
import { fetchZai } from "./providers/zai.ts";
import { fetchXai } from "./providers/xai.ts";
import { claudeAccountSources, fetchAnthropic } from "./providers/anthropic.ts";
import { fetchKimi } from "./providers/kimi.ts";
import { fetchMinimax } from "./providers/minimax.ts";
import { fetchAntigravity } from "./providers/antigravity.ts";

/** How long a last-good reading may stand in for a failing provider. */
const STALE_MAX_MS = 3 * 86400_000;

export async function collectUsage(opencode?: AuthFile): Promise<UsageSnapshot> {
  const cfg = loadConfig();
  const stores = loadStores(opencode);
  const off = new Set(cfg.disabled);
  const jobs: [string, () => Promise<ProviderStatus | null>][] = [
    ["anthropic", () => fetchAnthropic(stores.opencode)],
    ...cfg.claude.accounts.map(
      (a): [string, () => Promise<ProviderStatus | null>] => [
        claudeAccountId(a),
        () => fetchAnthropic(stores.opencode, claudeAccountSources(a), a),
      ],
    ),
    ["openai", () => fetchOpenAI(stores.opencode)],
    ["zai", () => fetchZai(stores.opencode)],
    ["xai", () => fetchXai(stores.opencode)],
    ["antigravity", () => fetchAntigravity(stores.opencode)],
    ["kimi", () => fetchKimi()],
    ["minimax", () => fetchMinimax(stores.opencode)],
  ];
  const fetched = await Promise.all(
    jobs.filter(([id]) => !off.has(id as never)).map(([, run]) => run()),
  );
  const previous = loadCachedSnapshot();
  const providers = fetched
    .filter((p): p is ProviderStatus => p != null)
    .map((p) => withStaleFallback(p, previous));
  const snapshot = finalizeSnapshot(providers, cfg.thresholds, cfg.summary);
  saveSnapshot(snapshot);
  appendHistory(snapshot, cfg.historyDays);
  return snapshot;
}

/**
 * A failed refresh keeps the last good reading, dimmed with "as of", instead
 * of blanking the meter — an expired token or a flaky endpoint shouldn't make
 * you blind. Windows whose reset has since passed are dropped (stale numbers).
 */
export function withStaleFallback(
  current: ProviderStatus,
  previous: UsageSnapshot | null,
  now = Date.now(),
): ProviderStatus {
  if (current.ok) return current;
  const prev = previous?.providers.find((p) => p.id === current.id && p.ok);
  if (!prev) return current;
  const asOf = prev.asOf || prev.fetchedAt;
  if (!asOf || now - Date.parse(asOf) > STALE_MAX_MS) return current;
  const windows = prev.windows
    .filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now)
    .map(({ pace: _pace, ...w }) => ({ ...w, resetAfterSeconds: secondsUntil(w.resetsAt) ?? w.resetAfterSeconds }));
  if (!windows.some((w) => w.usedPercent != null)) return current;
  return finalizeProvider({
    id: prev.id,
    name: prev.name,
    plan: prev.plan,
    source: prev.source,
    ok: true,
    stale: true,
    asOf,
    error: current.error,
    windows,
    fetchedAt: current.fetchedAt,
  });
}

export function saveSnapshot(snapshot: UsageSnapshot): void {
  mkdirSync(cacheDir(), { recursive: true });
  const tmp = cacheSnapshotPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  renameSync(tmp, cacheSnapshotPath());
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
