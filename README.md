# llm-usage

Local-only subscription usage for **OpenAI (ChatGPT)** / **GLM (Z.AI Coding Plan)** / **Grok (xAI)** via OpenCode credentials.

**Arch + Hyprland + Quickshell (ii)**. No global npm/bun package install.

## CLI (project-local only)

```bash
./bin/llm-usage status      # human table
./bin/llm-usage json        # structured snapshot
./bin/llm-usage waybar      # Waybar JSON
./bin/llm-usage notify      # notify-send if high
```

Requires system `bun` on PATH as a runtime (like `python`). Does **not** install packages globally.

Credentials: `~/.local/share/opencode/auth.json` only  
Cache write: `~/.cache/llm-usage/snapshot.json` only (percentages, never tokens)

## Tests (TDD)

```bash
bun test
```

## Quickshell bar (click for details)

Self-contained widget lives **in this repo**:

`integrations/quickshell/bar/LlmUsageBar.qml`

BarContent loads it with a `Loader` (absolute `file://` path) so Quickshell module type registration is not required.

**Minimal host change** (already applied if you used this machine’s setup):

```qml
Loader {
    id: llmUsageLoader
    active: root.useShortenedForm < 2
    Layout.alignment: Qt.AlignVCenter
    Layout.preferredWidth: item ? item.implicitWidth : 0
    Layout.preferredHeight: item ? item.implicitHeight : 0
    source: "file:///home/xzascc/Documents/code/LLMUsage/integrations/quickshell/bar/LlmUsageBar.qml"
}
```

- **Click** — 3-column popup (OpenAI / GLM / Grok)
- **Right-click** — force refresh
- **Ring number** — worst usage % across providers

Reload Quickshell: `killall qs; qs -c ii &` (or your dots-hyprland restart bind).

If you move the repo, edit the `projectRoot` / Loader `source` path inside the QML.

## Local-only policy

- No `npm i -g` / no AUR package for this app
- No tokens written to cache
- Prefer changes inside this directory; Quickshell only needs the one Loader line
