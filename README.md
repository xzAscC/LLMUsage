# LLMUsage

**Track Claude / ChatGPT / GLM / Grok / Kimi / MiniMax subscription usage from your Hyprland bar.**

<p align="center">
  <img src="docs/popup.png" alt="LLMUsage Quickshell popup — OpenAI, GLM, Grok, and Claude usage at a glance" widt## Motivation

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
- **Kimi** and **MiniMax** coding plans — optional, shown only when a token/key is configured
- **Pace vs even burn** on every rolling window: `14% in reserve`, `on pace · lands ~98%`, `8% in deficit · runs out ~21:40`
- **Stale, not blank** — when a refresh fails, the last good reading stays (dimmed, “as of 2h ago”) for up to 3 days
- **History** — daily peak + mean per window, `llm-usage history` with sparklines / CSV
- **Local token totals** — per-day tokens from Claude Code, Codex and pi session logs (`llm-usage tokens`)
- **Alerts** — fire once per threshold crossing (75/90/95), on exhaustion/reset, optionally on pace deficit
- **`llm-usage doctor`** — which store each credential comes from, expiry, refresh ownership, live check, integration
- **Tests**: `bun test` (credential stores are sandboxed; tests never touch your real logins)

### Where credentials come from

First usable source wins; a token rejected with 401 falls through to the next one.

| Provider | Sources, in order |
|----------|-------------------|
| Claude | `~/.claude/.credentials.json` → pi `anthropic` → OpenCode `anthropic` |
| OpenAI | `~/.codex/auth.json` → pi `openai-codex` → OpenCode `openai` |
| Grok / xAI | `~/.grok/auth.json` (grok CLI) → pi `xai` → OpenCode `xai` |
| GLM | `$ZAI_API_KEY` / `$ZHIPUAI_API_KEY` / `$GLM_API_KEY` → `~/.z-ai-api-key` → pi `zai` → OpenCode `zai-coding-plan` |
| Kimi | `$KIMI_TOKEN` → `~/.config/llm-usage/kimi-token` (kimi.com `localStorage.access_token`, ~30 days) |
| MiniMax | `$MINIMAX_API_KEY` → `~/.minimax-api-key` → pi / OpenCode `minimax` |

**Refresh ownership:** an expired OAuth token is refreshed — and the rotated token written back to its own file under a lock — **only while the agent that owns it is not running** (`claude`, `codex`, `pi`, `opencode`, `grok`, detected via `/proc`). While the agent runs, it stays the sole rotator and LLMUsage moves on to the next source, so it never races the agent for a single-use refresh token.

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

The look follows [Headroom](https://github.com/BioInfo/headroom): a warm cream/espresso palette (light/dark follows ii's dark mode), a chef-hat gauge that fills bottom-up in the tier color, and one card per provider. Each card has a 20-segment olive→amber→terracotta→rust meter with an even-burn pace tick, "resets in … · 12% in reserve / empties ~21:40", plan chip, status dot, a link to the provider's usage page, and the credential source. The header sums things up ("3 comfortable · 1 tight") and, when one plan runs hot, suggests the one with the most room. The chart button switches to **Usage History**: token tiles (yesterday / 7 / 30 days), a token trend per agent, and the recorded daily peak per window.

Components live next to the widget (`Lu*.qml`); Loader-only integration is unchanged.

The chip reuses a snapshot the systemd timer wrote in the last 4 minutes, so the two don't double-poll the provider APIs.

Reload the shell, e.g. `killall qs; qs -c ii &`.

---

## How it works

```
Claude Code / Codex / pi / grok CLI / OpenCode credential files
                               │  (refresh only if owner idle)
                               ▼
        providers (Anthropic / ChatGPT / Z.AI / xAI / Kimi / MiniMax APIs)
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
| `*.resetCreditsDisplay` | `"all"` lists every reset credit / expiry; `"summary"` shows `4 available · next exp 7/18` |
| `summary` | Bar number: `"max"` = tightest window (default), `"avg"` = mean across providers |
| `thresholds` | Ring / Waybar colour levels |
| `disabled` | Provider ids to skip: `anthropic`, `openai`, `zai`, `xai`, `kimi`, `minimax` |
| `notify.thresholds` | Alert once when a window climbs past each level |
| `notify.exhausted` | Alert at 100% and again when the window resets |
| `notify.pace` | Predictive alert when a window falls into pace deficit |
| `notify.refilled` | Soft ping when a window that crossed a threshold resets |
| `historyDays` | Days of history to keep |
