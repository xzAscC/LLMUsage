#!/usr/bin/env bun
import { alertText, evaluateAlerts, loadAlertState, saveAlertState } from "./alerts.ts";
import { collectOrCache, collectUsage } from "./collect.ts";
import { loadConfig } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { formatHuman, formatWaybar } from "./format.ts";
import { formatHistory, historyCsv, loadHistory, seriesFor } from "./history.ts";
import { cachedTokenSeries, formatTokens, scanTokens, tokensCsv, type ModelDays } from "./tokens.ts";
import type { UsageSnapshot } from "./types.ts";

const args = process.argv.slice(2);
const cmd = args[0] || "status";
const force = args.includes("--force") || args.includes("-f");

function intArg(name: string, fallback: number): number {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  const n = a ? Number.parseInt(a.split("=")[1] || "", 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const maxAgeSec = intArg("max-age", 60);

function usage(): never {
  console.log(`llm-usage — local subscription usage for Claude / ChatGPT / GLM / Grok / Kimi / MiniMax

Usage:
  llm-usage status  [--force] [--max-age=60]   table with pace vs even burn
  llm-usage json    [--force] [--max-age=60]   snapshot JSON (Quickshell reads this)
  llm-usage waybar  [--force] [--max-age=60]   Waybar custom module JSON
  llm-usage notify                             refresh + alert on threshold/exhaustion/pace transitions
  llm-usage history [--days=14] [--csv|--json] daily peak/avg per window (self-recorded)
  llm-usage tokens  [--days=14] [--csv|--json] daily tokens from Claude Code / Codex / pi logs
  llm-usage doctor                             credentials, refresh ownership, live check, integration
  llm-usage help

Credentials come from Claude Code (~/.claude), Codex (~/.codex), pi (~/.pi/agent),
then OpenCode as a fallback. Tokens are refreshed only while their owning agent is not running.
Config: ~/.config/llm-usage/config.json
`);
  process.exit(0);
}

async function getSnapshot(): Promise<UsageSnapshot> {
  if (force) return collectUsage();
  return collectOrCache({ maxAgeSec });
}

async function notify(): Promise<void> {
  const cfg = loadConfig();
  const snap = await collectUsage();
  const { alerts, state } = evaluateAlerts(snap, cfg.notify, loadAlertState());
  saveAlertState(state);
  for (const a of alerts) {
    const t = alertText(a);
    const proc = Bun.spawn(
      ["notify-send", "-u", t.urgency, "-a", "llm-usage", "-i", "dialog-information", t.title, t.body],
      { stdout: "ignore", stderr: "ignore" },
    );
    await proc.exited;
  }
}

async function main() {
  switch (cmd) {
    case "help":
    case "-h":
    case "--help":
      usage();
      break;
    case "status":
    case "popup":
      process.stdout.write(formatHuman(await getSnapshot()));
      break;
    case "json":
      process.stdout.write(JSON.stringify(await getSnapshot(), null, 2) + "\n");
      break;
    case "waybar":
      process.stdout.write(formatWaybar(await getSnapshot()) + "\n");
      break;
    case "notify":
      await notify();
      break;
    case "history": {
      const days = intArg("days", 14);
      const series = seriesFor(loadHistory(), days);
      if (args.includes("--csv")) process.stdout.write(historyCsv(series));
      else if (args.includes("--json")) process.stdout.write(JSON.stringify(series, null, 2) + "\n");
      else process.stdout.write(formatHistory(series, days));
      break;
    }
    case "tokens": {
      const days = intArg("days", 14);
      if (args.includes("--json")) {
        const series = cachedTokenSeries(days, force ? 0 : maxAgeSec, force);
        process.stdout.write(JSON.stringify(series) + "\n");
        break;
      }
      const models: ModelDays = {};
      const data = scanTokens(days, Date.now(), models);
      process.stdout.write(args.includes("--csv") ? tokensCsv(data) : formatTokens(data, days, Date.now(), models));
      break;
    }
    case "doctor":
      process.stdout.write(await runDoctor());
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
