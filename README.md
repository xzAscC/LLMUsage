# llm-usage

Local-only subscription usage monitor for **OpenAI (ChatGPT)** / **GLM (Z.AI Coding Plan)** / **Grok (xAI)** via OpenCode credentials.

Designed for **Arch + Hyprland + Quickshell (ii)**.

## Requirements

- [Bun](https://bun.sh) on PATH (runtime only; no global npm packages)
- OpenCode logins in `~/.local/share/opencode/auth.json`:
  - `openai` — ChatGPT OAuth (`/connect` ChatGPT Plus/Pro)
  - `zai-coding-plan` — API key
  - `xai` — OAuth

## CLI (project-local)

```bash
./bin/llm-usage status      # human table
./bin/llm-usage json        # structured snapshot
./bin/llm-usage waybar      # Waybar custom module JSON
./bin/llm-usage notify      # notify-send if usage high
./bin/llm-usage status --force
```

Cache (only write location): `~/.cache/llm-usage/snapshot.json`  
**Never stores tokens** — only percentages, plan names, reset times.

## Tests

```bash
bun test
```

## Quickshell bar widget

```bash
bash install.sh   # symlinks into ~/.config/quickshell/ii (no global install)
```

Then ensure:

1. `Config.options.bar.llmUsage.enable` is `true` (default)
2. `BarContent.qml` includes `LlmUsageBar` next to `Resources` (done by install docs / patch)

**Bar:** single ring = worst usage % across providers  
**Click:** open 3-column popup (OpenAI / GLM / Grok)  
**Right-click:** force refresh  

Reload Quickshell (e.g. `Ctrl+Super+R` on dots-hyprland, or restart `qs -c ii`).

## Local-only policy

- No `npm install -g`
- No system package for this app
- Credentials only from OpenCode auth file
- Project path hardcoded in QS service: edit `integrations/quickshell/services/LlmUsage.qml` if you move the repo
