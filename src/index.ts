#!/usr/bin/env bun
import { collectOrCache, collectUsage } from "./collect.ts";
import { formatHuman, formatWaybar } from "./format.ts";
import type { UsageSnapshot } from "./types.ts";

const args = process.argv.slice(2);
const cmd = args[0] || "status";
const force = args.includes("--force") || args.includes("-f");
const maxAgeArg = args.find((a) => a.startsWith("--max-age="));
const maxAgeSec = maxAgeArg
  ? Number.parseInt(maxAgeArg.split("=")[1] || "60", 10)
  : 60;

function usage(): never {
  console.log(`llm-usage — local OpenCode subscription usage (Hyprland/Quickshell)

Usage:
  llm-usage status [--force] [--max-age=60]
  llm-usage json   [--force] [--max-age=60]
  llm-usage waybar [--force] [--max-age=60]
  llm-usage notify [--force] [--threshold=80]
  llm-usage popup  [--force]   # human status for floating terminal
  llm-usage help

Reads credentials only from ~/.local/share/opencode/auth.json
Providers: OpenAI (ChatGPT OAuth), GLM/Z.AI coding plan, Grok/xAI OAuth
`);
  process.exit(0);
}

async function getSnapshot(): Promise<UsageSnapshot> {
  if (force || cmd === "notify") {
    return collectUsage();
  }
  return collectOrCache({ maxAgeSec, force });
}

async function main() {
  switch (cmd) {
    case "help":
    case "-h":
    case "--help":
      usage();
      break;
    case "status":
    case "popup": {
      const snap = await getSnapshot();
      process.stdout.write(formatHuman(snap));
      break;
    }
    case "json": {
      const snap = await getSnapshot();
      process.stdout.write(JSON.stringify(snap, null, 2) + "\n");
      break;
    }
    case "waybar": {
      const snap = await getSnapshot();
      process.stdout.write(formatWaybar(snap) + "\n");
      break;
    }
    case "notify": {
      const thresholdArg = args.find((a) => a.startsWith("--threshold="));
      const threshold = thresholdArg
        ? Number.parseInt(thresholdArg.split("=")[1] || "80", 10)
        : 80;
      const snap = await collectUsage();
      const hot = snap.providers.filter(
        (p) => p.ok && p.usedPercent != null && p.usedPercent >= threshold,
      );
      if (hot.length === 0) {
        process.exit(0);
      }
      const body = hot
        .map((p) => `${p.name}: ${Math.round(p.usedPercent!)}%`)
        .join("\n");
      const proc = Bun.spawn(
        [
          "notify-send",
          "-u",
          "critical",
          "-a",
          "llm-usage",
          "LLM usage high",
          body,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      await proc.exited;
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
