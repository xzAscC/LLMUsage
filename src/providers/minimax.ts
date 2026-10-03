import type { AuthFile } from "../auth.ts";
import { loadStores, minimaxKeys, type ApiKeySource } from "../credentials.ts";
import { finalizeProvider } from "../severity.ts";
import type { ProviderStatus, UsageWindow } from "../types.ts";
import { clampPercent, fetchJson, isoFromEpochMs, secondsUntil } from "../util.ts";

/** MiniMax coding plan: the `sk-cp-…` key works as a Bearer on the remains endpoint. */
const REMAINS_URL = "https://api.minimax.io/v1/token_plan/remains";

interface ModelRemain {
  model_name?: string;
  start_time?: number;
  end_time?: number;
  current_interval_remaining_percent?: number;
  current_interval_status?: number;
  weekly_start_time?: number;
  weekly_end_time?: number;
  current_weekly_remaining_percent?: number;
  current_weekly_status?: number;
}

interface RemainsResponse {
  model_remains?: ModelRemain[];
  base_resp?: { status_code?: number; status_msg?: string };
}

// status 3 = uncapped window (always reports 100% remaining) → not a meter
const UNLIMITED = 3;

function window(
  id: string,
  label: string,
  remaining: number | undefined,
  status: number | undefined,
  start?: number,
  end?: number,
): UsageWindow | null {
  if (remaining == null) return null;
  if (status === UNLIMITED) return { id, label, note: "unlimited" };
  const usedPercent = clampPercent(100 - remaining);
  const resetsAt = isoFromEpochMs(end);
  return {
    id,
    label,
    usedPercent,
    remainingPercent: clampPercent(remaining),
    resetsAt,
    resetAfterSeconds: secondsUntil(resetsAt),
    windowSeconds: start != null && end != null && end > start ? (end - start) / 1000 : undefined,
  };
}

export function mapMinimaxRemains(body: RemainsResponse): UsageWindow[] {
  const m =
    body.model_remains?.find((r) => r.model_name === "general") ??
    body.model_remains?.[0];
  if (!m) return [];
  return [
    window("session", "Session 5h", m.current_interval_remaining_percent, m.current_interval_status, m.start_time, m.end_time),
    window("weekly", "Weekly", m.current_weekly_remaining_percent, m.current_weekly_status, m.weekly_start_time, m.weekly_end_time),
  ].filter((w): w is UsageWindow => w != null);
}

export async function fetchMinimax(
  auth?: AuthFile,
  keys: ApiKeySource[] = minimaxKeys(loadStores(auth)),
): Promise<ProviderStatus | null> {
  if (keys.length === 0) return null; // not configured → not shown
  const now = new Date().toISOString();
  const base = { id: "minimax" as const, name: "MiniMax", fetchedAt: now };
  const key = keys[0]!;
  try {
    const body = await fetchJson<RemainsResponse>(REMAINS_URL, {
      headers: { Authorization: `Bearer ${key.key}`, Accept: "application/json" },
    });
    const code = body.base_resp?.status_code ?? 0;
    if (code !== 0) {
      throw new Error(
        code === 2049 ? "MiniMax key rejected (2049)" : body.base_resp?.status_msg || `MiniMax code ${code}`,
      );
    }
    return finalizeProvider({
      ...base,
      plan: "Coding",
      source: key.label,
      ok: true,
      windows: mapMinimaxRemains(body),
    });
  } catch (err) {
    return finalizeProvider({
      ...base,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      windows: [],
    });
  }
}
