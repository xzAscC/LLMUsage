import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { configPath } from "./paths.ts";
import { DEFAULT_THRESHOLDS, type ProviderId, type Thresholds } from "./types.ts";

export type ResetCreditsDisplay = "all" | "summary";

export interface NotifyConfig {
  /** usage % levels that alert once per crossing */
  thresholds: number[];
  /** alert when a window hits 100% and again when it is usable */
  exhausted: boolean;
  /** predictive alert when a window falls into pace deficit */
  pace: boolean;
  /** soft ping when a window that crossed a threshold resets */
  refilled: boolean;
}

export interface ClaudeAccount {
  /** card title suffix, e.g. "OSU" → "Claude OSU"; also names the provider id */
  name: string;
  /** Claude Code config dir holding `.credentials.json` (CLAUDE_CONFIG_DIR) */
  dir: string;
}

export interface AppConfig {
  claude: {
    /** Extra Claude Code logins, each shown as its own card */
    accounts: ClaudeAccount[];
  };
  openai: {
    /** How to show ChatGPT rate-limit reset credits. Default: "all" */
    resetCreditsDisplay: ResetCreditsDisplay;
  };
  xai: {
    /** How to show Grok usage-limit resets. Default: "all" */
    resetCreditsDisplay: ResetCreditsDisplay;
  };
  /** Bar number: worst window across providers (default) or their mean */
  summary: "max" | "avg";
  /** Severity colors */
  thresholds: Thresholds;
  /** Providers to skip entirely */
  disabled: ProviderId[];
  notify: NotifyConfig;
  /** Days of usage history to keep */
  historyDays: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  claude: { accounts: [] },
  openai: { resetCreditsDisplay: "all" },
  xai: { resetCreditsDisplay: "all" },
  summary: "max",
  thresholds: DEFAULT_THRESHOLDS,
  disabled: [],
  notify: { thresholds: [75, 90, 95], exhausted: true, pace: false, refilled: false },
  historyDays: 90,
};

function asDisplay(v: unknown): ResetCreditsDisplay {
  if (v === "summary" || v === "all") return v;
  return DEFAULT_CONFIG.openai.resetCreditsDisplay;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

function asAccounts(v: unknown): ClaudeAccount[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((a) => a && typeof a.name === "string" && a.name.trim() && typeof a.dir === "string" && a.dir)
    .map((a) => ({ name: a.name.trim(), dir: expandHome(a.dir) }));
}

/** Provider id for an extra Claude account: "OSU" → "anthropic-osu". */
export function claudeAccountId(a: ClaudeAccount): `anthropic-${string}` {
  return `anthropic-${a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

export function loadConfig(path = configPath()): AppConfig {
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    const d = DEFAULT_CONFIG;
    const levels = Array.isArray(raw.notify?.thresholds)
      ? raw.notify.thresholds.filter((n: unknown) => typeof n === "number")
      : d.notify.thresholds;
    return {
      claude: { accounts: asAccounts(raw.claude?.accounts) },
      openai: { resetCreditsDisplay: asDisplay(raw.openai?.resetCreditsDisplay) },
      xai: { resetCreditsDisplay: asDisplay(raw.xai?.resetCreditsDisplay) },
      summary: raw.summary === "avg" ? "avg" : "max",
      thresholds: {
        warn: asNumber(raw.thresholds?.warn, d.thresholds.warn),
        crit: asNumber(raw.thresholds?.crit, d.thresholds.crit),
      },
      disabled: Array.isArray(raw.disabled) ? raw.disabled : [],
      notify: {
        thresholds: levels,
        exhausted: asBool(raw.notify?.exhausted, d.notify.exhausted),
        pace: asBool(raw.notify?.pace, d.notify.pace),
        refilled: asBool(raw.notify?.refilled, d.notify.refilled),
      },
      historyDays: asNumber(raw.historyDays, d.historyDays),
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}
