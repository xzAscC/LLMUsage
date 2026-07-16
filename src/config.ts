import { existsSync, readFileSync } from "fs";
import { configPath } from "./paths.ts";

export type OpenAiResetCreditsDisplay = "all" | "summary";

export interface AppConfig {
  openai: {
    /** How to show ChatGPT rate-limit reset credits. Default: "all" */
    resetCreditsDisplay: OpenAiResetCreditsDisplay;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  openai: {
    resetCreditsDisplay: "all",
  },
};

function asDisplay(v: unknown): OpenAiResetCreditsDisplay {
  if (v === "summary" || v === "all") return v;
  return DEFAULT_CONFIG.openai.resetCreditsDisplay;
}

export function loadConfig(path = configPath()): AppConfig {
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<{
      openai?: { resetCreditsDisplay?: unknown };
    }>;
    return {
      openai: {
        resetCreditsDisplay: asDisplay(raw.openai?.resetCreditsDisplay),
      },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}
