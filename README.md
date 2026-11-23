# LLMUsage

**Track Claude / ChatGPT / GLM / Grok / Antigravity / Kimi / MiniMax subscription usage from your Hyprland bar.**

There are plenty of LLM usage monitors — web dashboards, browser extensions, Electron widgets, macOS menu-bar apps like [Headroom](https://github.com/BioInfo/headroom). Most of them fall short if you actually live on a tiling compositor:

- They assume macOS / Windows / a browser tab, not a **Hyprland** status bar
- They're heavy (Electron) or remote (someone else's cloud account)
- They don't reuse the logins your coding agents already hold

**LLMUsage** is built for that gap: a small, local-first toolkit that reads the credentials **Claude Code, Codex and pi** already store (OpenCode as a fallback), and surfaces remaining quota **where you look** — the bar — with a plain CLI and a systemd timer for everything else.

No Electron. No cloud account. No global npm install. Just Bun + your existing logins.

| Surface | What you get |
|---------|----------------|
| **CLI** | Table with pace, JSON, Waybar module, history, token totals, doctor |
| **Quickshell bar** | Chef-hat gauge + Headroom-style card popup (pace ticks, plan chips, usage + token history) |
| **systemd user timer** | Background refresh, usage history, de-duplicated `notify-send` alerts |

---

## Features

- **Claude** — session 5h + weekly (+ per-model weekly) from `api/oauth/usage`
- **OpenAI / Codex (ChatGPT OAuth)** — rate windows, credit balance, **rate-limit reset credits**
- **GLM / Z.AI Coding Plan** — session 5h + weekly token quotas, plan name
- **Grok / xAI** — weekly SuperGrok pool + **usage-limit resets**
- **Google Antigravity** — Gemini and Claude+GPT pools, 5h + weekly each, plan from the paid tier; shown when pi has an Antigravity login. The OAuth client is not in this repo: it comes from `ANTIGRAVITY_CLIENT_ID`/`ANTIGRAVITY_CLIENT_SECRET`, else it is read as text (never run) from the installed pi-antigravity
- **Kimi** and **MiniMax** coding plans — optional, shown only when a token/key is configured
- **Pace vs even burn** on every rolling window: `14% in reserve`, `on pace · lands ~98%`, `8% in deficit · runs out ~21:40`
- **Stale, not blank** — when a refresh fails, the last good reading stays (dimmed, “as of 2h ago”) for up to 3 days
- **Login end** — a Claude login ends on a fixed date that refreshing does not move; the card warns in the last 3 days (“Login expires in 2 days · run /login”), as Claude Code does
- **History** — daily peak + mean per window, `llm-usage history` with sparklines / CSV
- **Local token totals** — tokens per day and per model from Claude Code, Codex and pi session logs (`llm-usage tokens`)
- **Alerts** — fire once per threshold crossing (75/90/95), on exhaustion/reset, optionally on pace deficit
- **`llm-usage doctor`** — which store each credential comes from, expiry, refresh ownership, live check, integration
- **Tests**: `bun test` (credential stores are sandboxed; tests never touch your real logins)

### Where credentials come from

One card = one login: the first store that holds a login is used and the others are ignored, so a failing login never shows another account's numbers (an old ChatGPT login left in pi, say).

| Provider | Sources, in order |
|----------|-------------------|
| Claude | `~/.claude/.credentials.json` → pi `anthropic` → OpenCode `anthropic` |
| OpenAI | `~/.codex/auth.json` → pi `openai-codex` → OpenCode `openai` |
| Grok / xAI | `~/.grok/auth.json` (grok CLI) → pi `xai` → OpenCode `xai` |
| Antigravity | pi `antigravity` ([pi-antigravity](https://github.com/Rahularya01/pi-antigravity), `/login antigravity`) |
| GLM | `$ZAI_API_KEY` / `$ZHIPUAI_API_KEY` / `$GLM_API_KEY` → `~/.z-ai-api-key` → pi `zai` → OpenCode `zai-coding-plan` |
| Kimi | `$KIMI_TOKEN` → `~/.config/llm-usage/kimi-token` (kimi.com `localStorage.access_token`, ~30 days) |
| MiniMax | `$MINIMAX_API_KEY` → `~/.minimax-api-key` → pi / OpenCode `minimax` |

**Refresh ownership:** an expired OAuth token is refreshed — and the rotated token written back to its own file under a lock — **only while the agent that owns it is not running** (`claude`, `codex`, `pi`, `opencode`, `grok`, detected via `/proc`). While the agent runs, it stays the sole rotator, so LLMUsage never races it for a single-use refresh token.

**Claude Code is the exception:** its sessions already share one credentials file. Before refreshing, each takes `<config dir>/.oauth_refresh.lock` and then `<config dir>.lock` (mkdir locks, Claude Code 2.1.x) and re-reads the file inside them. LLMUsage takes the same two locks in the same order, so it refreshes like one more session even while `claude` runs, and the Claude card never goes stale just because a session sits idle. It asks for the login's existing scopes and keeps `refreshTokenExpiresAt` up to date. The final read-modify-write of `.credentials.json` also takes `<config dir>/.storage-write.lock`, as Claude Code does, and writes only over the same login: a `/login` or `/logout` made meanwhile wins, and a file that does not parse is left alone. This applies only while every running `claude` is a native build from 2.1.328 on whose binary still names these locks; with any other `claude` running, LLMUsage waits as before. A stale lock is broken only if it is an empty directory, and a collector stopped by a signal starts no new refresh and lets a running one write its token (up to 30 s); a second signal exits at once.

**Antigravity:** Google's refresh tokens do not rotate, so while pi runs, LLMUsage gets an access token for its own call and leaves pi's file alone.

---

## Requirements

- [Bun](https://bun.sh) on `PATH` (runtime only)
- At least one of: Claude Code (`claude auth login`), Codex, [pi](https://github.com/badlogic/pi-mono) (`/login`), grok CLI, or OpenCode
- Optional UI: [Hyprland](https://hyprland.org) + [Quickshell](https://quickshell.outfoxxed.me) (e.g. dots-hyprland `ii`)
- Optional alerts: `libnotify` (`notify-send`) + systemd user session

---

## Quick start (CLI)

```bash
git clone https://github.com/xzAscC/LLMUsage.git
cd LLMUsage

./bin/llm-usage status            # table with pace
./bin/llm-usage doctor            # where each credential comes from + live check
./bin/llm-usage history --days=30 # daily peak/avg sparklines (--csv / --json)
./bin/llm-usage tokens --days=14  # local tokens from Claude Code / Codex / pi logs
./bin/llm-usage json              # structured snapshot
./bin/llm-usage waybar            # Waybar custom module JSON
./bin/llm-usage notify            # refresh + transition alerts
./bin/llm-usage status --force
```

Background refresh + alerts + history (systemd user timer, every 5 min):

```bash
./install.sh --systemd
```

```bash
bun test
```

---

n test
```

---

## Quickshell bar (Hyprland)

Widget source (self-contained):

```text
integrations/quickshell/bar/LlmUsageBar.qml
```

Add a `Loader` next to your bar resources (example for dots-hyprland `BarContent.qml`):

```qml
Loader {
    id: llmUsageLoader
    active: root.useShortenedForm < 2
    Layout.alignment: Qt.AlignVCenter
    Layout.preferredWidth: item ? item.implicitWidth : 0
    Layout.preferredHeight: item ? item.implicitHeight : 0
    // set to YOUR clone path
    source: "file:///home/YOU/path/to/LLMUsage/integrations/quickshell/bar/LlmUsageBar.qml"
}
```

Also set `projectRoot` (and `bunPath` if needed) near the top of `LlmUsageBar.qml` to match your machine.

| Input | Action |
|-------|--------|
| Left click | Open the popup (stays open while hovered; closes when the pointer leaves) |
| Right click | Force refresh |

The look follows [Headroom](https://github.com/BioInfo/headroom): a warm cream/espresso palette (light/dark follows ii's dark mode), a chef-hat gauge that fills bottom-up in the tier color, and one card per provider. Each card has a 20-segment olive→amber→terracotta→rust meter with an even-burn pace tick, "resets in … · 12% in reserve / empties ~21:40", plan chip, status dot, and a link to the provider's usage page (`llm-usage doctor` tells which store each login comes from). Cards of similar height share a row, so every row lines up; an unused window reads "not started". The header sums things up ("3 comfortable · 1 tight") and, when one plan runs hot, suggests the one with the most room. The chart button switches to **Usage History**: token tiles (yesterday / 7 / 30 days), a token trend per agent, tokens per model over the last 7 days, and the recorded daily peak per window.

Components live next to the widget (`Lu*.qml`); Loader-only integration is unchanged.

The chip reuses a snapshot the systemd timer wrote in the last 4 minutes, so the two don't double-poll the provider APIs.

Reload the shell, e.g. `killall qs; qs -c ii &`.

---

## How it works

```
Claude Code / Codex / pi / grok CLI / OpenCode credential files
                               │  (refresh only if owner idle)
                               ▼
        providers (Anthropic / ChatGPT / Z.AI / xAI / Antigravity / Kimi / MiniMax APIs)
                               │
          ┌────────────────────┼─────────────────────────┐
          ▼                    ▼                         ▼
 ~/.cache/llm-usage/   ~/.local/state/llm-usage/   ~/.local/state/llm-usage/
   snapshot.json          history.json               alerts.json
          │
  ┌───────┼──────────────┐
  ▼       ▼              ▼
 CLI   Waybar JSON   Quickshell bar
```

---

## Privacy & local-only policy

- Credentials never leave your machine except to the provider usage APIs you already use
- Snapshot / history store usage percentages and reset times only — **no tokens**
- No telemetry, no cloud backend, no global package install

---

## License

MIT

---

## Config (optional)

`~/.config/llm-usage/config.json` — every key is optional:

```json
{
  "claude": { "accounts": [{ "name": "OSU", "dir": "~/.claude-alt" }] },
  "openai": { "resetCreditsDisplay": "all" },
  "xai": { "resetCreditsDisplay": "summary" },
  "summary": "max",
  "thresholds": { "warn": 70, "crit": 90 },
  "disabled": ["minimax"],
  "notify": { "thresholds": [75, 90, 95], "exhausted": true, "pace": false, "refilled": false },
  "historyDays": 90
}
```

| Key | Meaning |
|-----|---------|
| `claude.accounts` | Extra Claude Code logins (another `CLAUDE_CONFIG_DIR`), each shown as its own card `Claude <name>` with id `anthropic-<name>` |
| `*.resetCreditsDisplay` | `"all"` lists every reset credit / expiry; `"summary"` shows `4 available · next exp 7/18` |
| `summary` | Bar number: `"max"` = tightest window (default), `"avg"` = mean across providers |
| `thresholds` | Ring / Waybar colour levels |
| `disabled` | Provider ids to skip: `anthropic`, `anthropic-<name>`, `openai`, `zai`, `xai`, `antigravity`, `kimi`, `minimax` |
| `notify.thresholds` | Alert once when a window climbs past each level |
| `notify.exhausted` | Alert at 100% and again when the window resets |
| `notify.pace` | Predictive alert when a window falls into pace deficit |
| `notify.refilled` | Soft ping when a window that crossed a threshold resets |
| `historyDays` | Days of history to keep |
