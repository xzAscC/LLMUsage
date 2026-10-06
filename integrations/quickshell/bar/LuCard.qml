import qs.modules.common
import qs.modules.common.widgets
import QtQuick
import QtQuick.Layouts
import Quickshell

/** One provider: monogram · name · PLAN chip · status dot, then its meters. */
Rectangle {
    id: card
    property var skin
    property var provider

    readonly property bool ok: !!provider.ok
    readonly property bool stale: !!provider.stale
    readonly property var meters: (provider.windows || []).filter(w => w.usedPercent != null || w.note === "unlimited")
    readonly property var chips: buildChips()

    readonly property string dashboard: ({
        anthropic: "https://claude.ai/settings/usage",
        openai: "https://chatgpt.com/codex/settings/usage",
        zai: "https://z.ai/manage-apikey/coding-plan/personal/usage",
        xai: "https://grok.com/?_s=usage",
        kimi: "https://www.kimi.com/code/console",
        minimax: "https://platform.minimax.io/user-center/payment/token-plan"
    })[skin.baseId(provider.id)] || ""

    // note-only windows (credits, reset credits) become compact chips
    function buildChips() {
        const out = []
        const ws = provider.windows || []
        for (let i = 0; i < ws.length; i++) {
            const w = ws[i]
            if (w.usedPercent != null || w.note === "unlimited" || !w.note) continue
            if (/^(rate-)?reset-\d+$/.test(w.id)) continue
            if (w.label.trim() === "Resets") {
                const count = parseInt(w.note)
                if (!(count > 0)) continue
                const next = ws.find(x => /^(rate-)?reset-\d+$/.test(x.id))
                const exp = /exp (\d+)\/(\d+)/.exec(next ? next.note : w.note)
                let text = count + (count === 1 ? " reset left" : " resets left")
                if (exp) text += " · next expires " + Qt.formatDate(new Date(2000, exp[1] - 1, exp[2]), "MMM d")
                out.push({ icon: "replay", text: text })
            } else {
                out.push({ icon: "toll", text: w.label.trim() + " " + w.note.replace(/^balance /, "") })
            }
        }
        return out
    }

    // extra Claude accounts keep their own name ("Claude OSU") so the two cards differ
    readonly property string title: provider.id !== skin.baseId(provider.id) ? provider.name : ({
        anthropic: "Claude", openai: "OpenAI", zai: "GLM", xai: "Grok", kimi: "Kimi", minimax: "MiniMax"
    })[provider.id] || provider.name

    // "GLM Coding Max" on the GLM card reads twice; drop the brand prefix
    readonly property string plan: {
        const p = (provider.plan || "").trim()
        const brand = title.toLowerCase()
        return p.toLowerCase().startsWith(brand + " ") ? p.slice(brand.length + 1) : p
    }

    implicitHeight: body.implicitHeight + 24
    radius: 9
    color: skin.card
    border.width: 1
    border.color: skin.edge

    ColumnLayout {
        id: body
        anchors {
            fill: parent
            leftMargin: 12
            rightMargin: 12
            topMargin: 11
            bottomMargin: 10
        }
        spacing: 10

        // header
        RowLayout {
            Layout.fillWidth: true
            spacing: 6

            Rectangle {
                implicitWidth: 20
                implicitHeight: 20
                radius: 10
                color: card.skin.alpha(card.skin.accent(card.provider.id), 0.15)
                border.width: 1
                border.color: card.skin.alpha(card.skin.accent(card.provider.id), 0.7)
                StyledText {
                    anchors.centerIn: parent
                    text: card.skin.letter(card.provider.id)
                    color: card.skin.accent(card.provider.id)
                    font.pixelSize: 10
                    font.weight: Font.Bold
                }
            }
            StyledText {
                text: card.title
                color: card.skin.ink
                font.pixelSize: 14
                font.weight: Font.DemiBold
                elide: Text.ElideRight
                Layout.maximumWidth: 140
            }
            Rectangle {
                visible: card.plan !== ""
                implicitWidth: planText.implicitWidth + 12
                implicitHeight: planText.implicitHeight + 4
                radius: height / 2
                color: card.skin.clay
                StyledText {
                    id: planText
                    anchors.centerIn: parent
                    text: card.plan.toUpperCase()
                    color: card.skin.bg2
                    font.pixelSize: 10
                    font.weight: Font.Bold
                }
            }
            Item { Layout.fillWidth: true }
            MaterialSymbol {
                visible: card.dashboard !== ""
                text: "open_in_new"
                iconSize: 13
                color: dashArea.containsMouse ? card.skin.ink2 : card.skin.faint
                MouseArea {
                    id: dashArea
                    anchors.fill: parent
                    anchors.margins: -3
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: Quickshell.execDetached(["xdg-open", card.dashboard])
                }
            }
            Rectangle {
                implicitWidth: 7
                implicitHeight: 7
                radius: 3.5
                color: !card.ok ? card.skin.critical : card.stale ? card.skin.warming : card.skin.healthy
            }
        }

        // meters
        Repeater {
            model: card.ok ? card.meters : []
            delegate: LuMeter {
                required property var modelData
                Layout.fillWidth: true
                skin: card.skin
                win: modelData
                dim: card.stale ? 0.5 : 1
            }
        }

        // chips: credits / reset credits
        Flow {
            visible: card.ok && card.chips.length > 0
            Layout.fillWidth: true
            spacing: 5
            Repeater {
                model: card.chips
                delegate: Rectangle {
                    required property var modelData
                    implicitWidth: chipRow.implicitWidth + 12
                    implicitHeight: chipRow.implicitHeight + 4
                    radius: height / 2
                    color: card.skin.bg2
                    border.width: 1
                    border.color: card.skin.edge
                    RowLayout {
                        id: chipRow
                        anchors.centerIn: parent
                        spacing: 3
                        MaterialSymbol {
                            text: modelData.icon
                            iconSize: 12
                            color: card.skin.clay
                        }
                        StyledText {
                            text: modelData.text
                            color: card.skin.ink2
                            font.pixelSize: 11
                        }
                    }
                }
            }
        }

        // error: what went wrong, in a soft rust well
        Rectangle {
            visible: !card.ok
            Layout.fillWidth: true
            implicitHeight: errText.implicitHeight + 14
            radius: 7
            color: card.skin.alpha(card.skin.critical, 0.10)
            border.width: 1
            border.color: card.skin.alpha(card.skin.critical, 0.30)
            StyledText {
                id: errText
                anchors.fill: parent
                anchors.margins: 7
                text: card.provider.error || "Couldn't read usage."
                color: card.skin.ink2
                font.pixelSize: 11
                wrapMode: Text.Wrap
            }
        }

        // pushes the footer to the bottom so cards in a row share a baseline
        Item { Layout.fillHeight: true }

        Rectangle {
            Layout.fillWidth: true
            implicitHeight: 1
            color: card.skin.alpha(card.skin.edge, 0.7)
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: 4
            MaterialSymbol {
                visible: !!card.provider.source
                text: "key"
                iconSize: 12
                color: card.skin.faint
            }
            StyledText {
                text: card.provider.source ? ("via " + card.provider.source) : "no credentials"
                color: card.skin.faint
                font.pixelSize: 11
            }
            Item { Layout.fillWidth: true }
            StyledText {
                visible: card.stale
                text: "couldn't refresh · as of " + card.skin.ago(card.provider.asOf)
                color: card.skin.warming
                font.pixelSize: 11
            }
        }
    }
}
