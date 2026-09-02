import { existsSync, readFileSync } from "fs";
import { configPath } from "./paths.ts";

export type ResetCreditsDisplay = "all" | "summary";

export interface AppConfig {
  openai: {
    /** How to show ChatGPT rate-limit reset credits. Default: "all" */
    resetCreditsDisplay: ResetCreditsDisplay;
  };
  xai: {
    /** How to show Grok usage-limit resets. Default: "all" */
    resetCreditsDisplay: ResetCreditsDisplay;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  openai: {
    resetCreditsDisplay: "all",
  },
  xai: {
    resetCreditsDisplay: "all",
  },
};

function asDisplay(v: unknown): ResetCreditsDisplay {
  if (v === "summary" || v === "all") return v;
  return DEFAULT_CONFIG.openai.resetCreditsDisplay;
}

export function loadConfig(path = configPath()): AppConfig {
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<{
      openai?: { resetCreditsDisplay?: unknown };
      xai?: { resetCreditsDisplay?: unknown };
    }>;
    return {
      openai: {
        resetCreditsDisplay: asDisplay(raw.openai?.resetCreditsDisplay),
      },
      xai: {
        resetCreditsDisplay: asDisplay(raw.xai?.resetCreditsDisplay),
      },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}
