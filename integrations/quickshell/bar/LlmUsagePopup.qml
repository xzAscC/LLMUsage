import qs.modules.common
import qs.modules.common.widgets
import qs.services
import QtQuick
import QtQuick.Layouts

StyledPopup {
    id: root

    function formatReset(w) {
        if (w.resetAfterSeconds != null && w.resetAfterSeconds >= 0) {
            const s = Math.floor(w.resetAfterSeconds)
            const d = Math.floor(s / 86400)
            const h = Math.floor((s % 86400) / 3600)
            const m = Math.floor((s % 3600) / 60)
            if (d > 0) return `${d}d ${h}h`
            if (h > 0) return `${h}h ${m}m`
            return `${m}m`
        }
        return "—"
    }

    function shortId(id) {
        if (id === "openai") return "OpenAI"
        if (id === "zai") return "GLM"
        if (id === "xai") return "Grok"
        return id || "?"
    }

    Row {
        anchors.centerIn: parent
        spacing: 14

        Repeater {
            model: LlmUsage.providers

            delegate: Column {
                required property var modelData
                spacing: 8
                width: 150

                StyledPopupHeaderRow {
                    icon: modelData.id === "openai"
                        ? "smart_toy"
                        : modelData.id === "zai"
                            ? "token"
                            : "bolt"
                    label: {
                        const name = root.shortId(modelData.id)
                        return modelData.plan ? `${name} · ${modelData.plan}` : name
                    }
                }

                Column {
                    spacing: 4
                    width: parent.width
                    visible: modelData.ok

                    StyledPopupValueRow {
                        icon: "percent"
                        label: Translation.tr("Used:")
                        value: modelData.usedPercent != null
                            ? `${Math.round(modelData.usedPercent)}%`
                            : "—"
                    }

                    Repeater {
                        model: modelData.windows || []

                        delegate: StyledPopupValueRow {
                            required property var modelData
                            icon: "timelapse"
                            label: (modelData.label || "?") + ":"
                            value: {
                                if (modelData.usedPercent != null) {
                                    const reset = root.formatReset(modelData)
                                    const note = modelData.note ? ` · ${modelData.note}` : ""
                                    return `${Math.round(modelData.usedPercent)}% · ${reset}${note}`
                                }
                                return modelData.note || "—"
                            }
                        }
                    }
                }

                Column {
                    spacing: 4
                    width: parent.width
                    visible: !modelData.ok

                    StyledPopupValueRow {
                        icon: "error"
                        label: Translation.tr("Error:")
                        value: modelData.error || "unknown"
                    }
                }
            }
        }

        // Empty state
        Column {
            visible: !LlmUsage.ready || (LlmUsage.providers || []).length === 0
            spacing: 6
            StyledPopupHeaderRow {
                icon: "hourglass_empty"
                label: "LLM Usage"
            }
            StyledPopupValueRow {
                icon: "info"
                label: Translation.tr("Status:")
                value: LlmUsage.lastError || Translation.tr("Loading…")
            }
        }
    }
}
