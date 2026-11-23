import type { AuthFile } from "../auth.ts";
import {
  antigravitySources,
  callWithOAuth,
  CredentialError,
  loadStores,
  shortMessage,
  type OAuthSource,
} from "../credentials.ts";
import { googleRefresher } from "../oauth-refresh.ts";
import { finalizeProvider } from "../severity.ts";
import type { ProviderStatus, UsageWindow } from "../types.ts";
import { clampPercent, fetchJson, secondsUntil } from "../util.ts";

/**
 * Google Antigravity (pi-antigravity extension, `/login antigravity`).
 * Quota lives in shared pools — Gemini and Claude+GPT — each with a 5h and a
 * weekly bucket, read from Cloud Code Assist's retrieveUserQuotaSummary.
 */
const ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

// same wire fingerprint as pi-antigravity, so the endpoint treats us like the CLI
const USER_AGENT =
  "antigravity/cli/1.2.4 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

interface QuotaBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  resetTime?: string;
  remainingFraction?: number;
}

interface QuotaSummary {
  groups?: { displayName?: string; buckets?: QuotaBucket[] }[];
}

interface Tier {
  id?: string;
  name?: string;
}

interface LoadCodeAssist {
  currentTier?: Tier;
  paidTier?: Tier;
}

/**
 * POST to the first endpoint that answers; 403/404/429/5xx fall through to
 * the next. If none answers, throw the error that says most: a
 * SUBSCRIPTION_REQUIRED from any endpoint, else the last one.
 */
async function post<T>(path: string, token: string, body: unknown): Promise<T> {
  let last: unknown;
  let telling: unknown;
  for (const base of ENDPOINTS) {
    try {
      return await fetchJson<T>(`${base}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (/HTTP 401/.test(String(err))) throw err;
      if (/SUBSCRIPTION_REQUIRED/i.test(String(err))) telling ??= err;
      last = err;
    }
  }
  throw telling ?? last;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** "18000s" (proto Duration), "5h", "weekly", … → seconds, for the pace tick. */
function windowSeconds(b: QuotaBucket): number | undefined {
  const dur = /^(\d+(?:\.\d+)?)s$/.exec((b.window || "").trim());
  if (dur) return Number(dur[1]);
  const text = `${b.window || ""} ${b.displayName || ""} ${b.bucketId || ""}`.toLowerCase();
  const hours = /(\d+)\s*-?\s*h(?:ou)?r?s?\b/.exec(text);
  if (hours) return Number(hours[1]) * 3600;
  if (/week/.test(text)) return 7 * 86400;
  if (/\bday|daily/.test(text)) return 86400;
  return undefined;
}

/** "Gemini Models" + "Five Hour Limit Remaining" (18000s) → "Gemini 5h" */
function bucketLabel(pool: string, b: QuotaBucket, secs?: number): string {
  const name = pool.replace(/\s+models?$/i, "");
  const span =
    secs === 7 * 86400
      ? "Weekly"
      : secs && secs < 86400 && secs % 3600 === 0
        ? `${secs / 3600}h`
        : (b.displayName || b.bucketId)!.replace(/\s*limit remaining$/i, "");
  return `${name} ${span}`;
}

export function windowsFromSummary(summary: QuotaSummary): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const group of summary.groups || []) {
    const pool = (group.displayName || "Quota").trim();
    const rows: UsageWindow[] = [];
    for (const b of group.buckets || []) {
      if (!b.bucketId && !b.displayName) continue;
      // proto3 JSON drops zero values: a bucket without a fraction is used up
      const remaining = clampPercent((b.remainingFraction ?? 0) * 100);
      const secs = windowSeconds(b);
      rows.push({
        id: slug(b.bucketId || `${pool} ${b.displayName}`),
        label: bucketLabel(pool, b, secs),
        usedPercent: clampPercent(100 - remaining),
        remainingPercent: remaining,
        resetsAt: b.resetTime,
        resetAfterSeconds: secondsUntil(b.resetTime),
        windowSeconds: secs,
      });
    }
    // 5h before weekly, like the other cards
    rows.sort((a, b) => (a.windowSeconds ?? Infinity) - (b.windowSeconds ?? Infinity));
    windows.push(...rows);
  }
  return windows;
}

function shortError(err: unknown): string {
  if (err instanceof CredentialError && err.message === "no credentials") {
    return "No Antigravity OAuth — run /login antigravity in pi";
  }
  if (/SUBSCRIPTION_REQUIRED/i.test(String(err))) {
    return "Quota summary needs a paid Google AI plan";
  }
  return shortMessage(err);
}

/** null = no Antigravity login in pi: the card is not shown, as for Kimi and MiniMax. */
export async function fetchAntigravity(
  auth?: AuthFile,
  sources: OAuthSource[] = antigravitySources(loadStores(auth)),
): Promise<ProviderStatus | null> {
  if (sources.length === 0) return null;
  const base = { id: "antigravity" as const, name: "Antigravity", fetchedAt: new Date().toISOString() };
  try {
    const { result, source } = await callWithOAuth(sources, () => googleRefresher, async (cred) => {
      const [summary, assist] = await Promise.all([
        post<QuotaSummary>("/v1internal:retrieveUserQuotaSummary", cred.access, {}),
        post<LoadCodeAssist>("/v1internal:loadCodeAssist", cred.access, {
          metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
        }).catch(() => null),
      ]);
      return { summary, assist };
    });
    const windows = windowsFromSummary(result.summary);
    // currentTier says free-tier even on Google AI Pro; the plan lives in paidTier
    const plan = result.assist?.paidTier?.name || result.assist?.currentTier?.name;
    return finalizeProvider({
      ...base,
      plan,
      source: source.label,
      ok: windows.length > 0,
      error: windows.length ? undefined : "No Antigravity quota buckets returned",
      windows,
    });
  } catch (err) {
    return finalizeProvider({ ...base, ok: false, error: shortError(err), windows: [] });
  }
}
