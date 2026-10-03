import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectUsage } from "./collect.ts";
import { loadConfig } from "./config.ts";
import {
  anthropicSources,
  kimiTokens,
  loadStores,
  minimaxKeys,
  openaiSources,
  ownerRunning,
  xaiSources,
  zaiKeys,
  type ApiKeySource,
  type OAuthSource,
} from "./credentials.ts";
import { isOAuthExpired } from "./oauth-refresh.ts";
import { cacheSnapshotPath, configDir, configPath, historyPath, xdgConfigHome } from "./paths.ts";
import { formatDuration } from "./util.ts";

const OK = "✓";
const WARN = "!";
const BAD = "✗";

function oauthLine(s: OAuthSource): string {
  const running = ownerRunning(s.owner);
  let state: string;
  if (s.cred.expires == null) state = "no expiry recorded";
  else if (isOAuthExpired(s.cred)) {
    state = running
      ? `expired — ${s.label} is running, it refreshes on next use`
      : s.cred.refresh
        ? `expired — will refresh (${s.label} idle)`
        : "expired, no refresh token — log in again";
  } else state = `valid ${formatDuration((s.cred.expires - Date.now()) / 1000)}`;
  const mark = isOAuthExpired(s.cred) && (running || !s.cred.refresh) ? WARN : OK;
  return `    ${mark} ${s.label.padEnd(12)} ${state}${running ? "  [running]" : ""}`;
}

function keyLine(k: ApiKeySource): string {
  return `    ${OK} ${k.label}`;
}

export async function runDoctor(): Promise<string> {
  const out: string[] = ["llm-usage doctor", ""];
  const stores = loadStores();
  const cfg = loadConfig();

  out.push("Credentials (first usable wins; refresh only while the owning agent is idle)");
  const groups: [string, string[]][] = [
    ["Claude", anthropicSources(stores).map(oauthLine)],
    ["OpenAI", openaiSources(stores).map(oauthLine)],
    ["Grok / xAI", xaiSources(stores).map(oauthLine)],
    ["GLM / Z.AI", zaiKeys(stores).map(keyLine)],
    ["Kimi", kimiTokens(configDir()).map(keyLine)],
    ["MiniMax", minimaxKeys(stores).map(keyLine)],
  ];
  for (const [name, lines] of groups) {
    out.push(`  ${name}`);
    out.push(...(lines.length ? lines : [`    · none found`]));
  }
  if (cfg.disabled.length) out.push(`  disabled in config: ${cfg.disabled.join(", ")}`);

  out.push("", "Live check");
  const snap = await collectUsage();
  for (const p of snap.providers) {
    const mark = p.ok && !p.stale ? OK : p.stale ? WARN : BAD;
    const detail = p.ok
      ? `${Math.round(p.usedPercent ?? 0)}% via ${p.source ?? "?"}${p.stale ? ` (stale, as of ${p.asOf}) — ${p.error}` : ""}`
      : p.error;
    out.push(`  ${mark} ${p.name.padEnd(12)} ${detail}`);
  }

  out.push("", "Integration");
  const bar = join(xdgConfigHome(), "quickshell", "ii", "modules", "ii", "bar", "BarContent.qml");
  const barText = existsSync(bar) ? readFileSync(bar, "utf8") : "";
  out.push(
    barText.includes("LlmUsageBar.qml")
      ? `  ${OK} Quickshell bar loads LlmUsageBar`
      : `  ${WARN} Quickshell BarContent has no LlmUsageBar Loader (see README)`,
  );
  const timer = Bun.spawnSync(["systemctl", "--user", "is-active", "llm-usage.timer"]);
  out.push(
    timer.stdout.toString().trim() === "active"
      ? `  ${OK} systemd timer llm-usage.timer active (notifications + history)`
      : `  ${WARN} llm-usage.timer not active — ./install.sh --systemd for background alerts`,
  );
  const notifySend = Bun.which("notify-send");
  out.push(notifySend ? `  ${OK} notify-send` : `  ${BAD} notify-send missing (pacman -S libnotify)`);
  out.push(
    "",
    "Files",
    `  config   ${configPath()}${existsSync(configPath()) ? "" : " (defaults)"}`,
    `  snapshot ${cacheSnapshotPath()}`,
    `  history  ${historyPath()}`,
  );
  return out.join("\n") + "\n";
}
