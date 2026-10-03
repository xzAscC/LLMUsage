#!/usr/bin/env bash
# Local-only. Does NOT install global packages.
#   ./install.sh             check the Quickshell bar Loader
#   ./install.sh --systemd   also install + enable the user timer (alerts + history)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BAR="${XDG_CONFIG_HOME:-$HOME/.config}/quickshell/ii/modules/ii/bar/BarContent.qml"
SRC="file://$ROOT/integrations/quickshell/bar/LlmUsageBar.qml"

if [[ ! -f "$BAR" ]]; then
  echo "BarContent.qml not found at $BAR — skip QS patch."
elif grep -q 'llmUsageLoader\|LLMUsage/integrations/quickshell/bar/LlmUsageBar.qml' "$BAR"; then
  echo "ok  BarContent already loads LlmUsageBar"
else
  echo "Manual step: add Loader in BarContent leftCenterGroup:"
  cat <<SNIP

            Loader {
                id: llmUsageLoader
                active: root.useShortenedForm < 2
                Layout.alignment: Qt.AlignVCenter
                Layout.preferredWidth: item ? item.implicitWidth : 0
                Layout.preferredHeight: item ? item.implicitHeight : 0
                source: "$SRC"
            }

SNIP
fi

if [[ "${1:-}" == "--systemd" ]]; then
  BUN="$(command -v bun || true)"
  [[ -n "$BUN" ]] || { echo "bun not on PATH (pacman -S bun-bin / yay -S bun-bin)"; exit 1; }
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  sed -e "s#@BUN@#$BUN#" -e "s#@ROOT@#$ROOT#" "$ROOT/integrations/systemd/llm-usage.service" > "$UNIT_DIR/llm-usage.service"
  cp "$ROOT/integrations/systemd/llm-usage.timer" "$UNIT_DIR/llm-usage.timer"
  systemctl --user daemon-reload
  systemctl --user enable --now llm-usage.timer
  echo "ok  llm-usage.timer enabled ($(systemctl --user is-active llm-usage.timer))"
fi

echo "CLI: $ROOT/bin/llm-usage status | doctor"
echo "Reload QS: killall qs; qs -c ii &"
