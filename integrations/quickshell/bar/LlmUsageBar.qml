import qs.modules.common
import qs.modules.common.widgets
import qs.services
import QtQuick
import QtQuick.Layouts

MouseArea {
    id: root

    property bool popupOpen: false
    readonly property bool enabledByConfig: Config.options?.bar?.llmUsage?.enable ?? true
    readonly property real usedFraction: Math.min(1, Math.max(0, (LlmUsage.worstUsedPercent || 0) / 100))
    readonly property bool isWarn: LlmUsage.severity === "warn"
    readonly property bool isCrit: LlmUsage.severity === "crit" || LlmUsage.severity === "error"

    visible: enabledByConfig
    implicitWidth: visible ? row.implicitWidth + 8 : 0
    implicitHeight: Appearance.sizes.barHeight
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    cursorShape: Qt.PointingHandCursor

    onClicked: event => {
        if (event.button === Qt.RightButton) {
            LlmUsage.refresh()
            return
        }
        root.popupOpen = !root.popupOpen
    }

    // Fake containsMouse so StyledPopup can be click-toggled
    Item {
        id: popupAnchor
        anchors.fill: parent
        property bool containsMouse: root.popupOpen
    }

    RowLayout {
        id: row
        anchors.centerIn: parent
        spacing: 2

        ClippedFilledCircularProgress {
            id: circ
            Layout.alignment: Qt.AlignVCenter
            lineWidth: Appearance.rounding.unsharpen
            value: root.usedFraction
            implicitSize: 20
            colPrimary: root.isCrit
                ? Appearance.colors.colError
                : root.isWarn
                    ? Appearance.m3colors.m3tertiary
                    : Appearance.colors.colOnSecondaryContainer
            accountForLightBleeding: !root.isCrit
            enableAnimation: false

            Item {
                anchors.centerIn: parent
                width: circ.implicitSize
                height: circ.implicitSize

                MaterialSymbol {
                    anchors.centerIn: parent
                    font.weight: Font.DemiBold
                    fill: 1
                    text: "auto_awesome"
                    iconSize: Appearance.font.pixelSize.normal
                    color: Appearance.m3colors.m3onSecondaryContainer
                }
            }
        }

        Item {
            Layout.alignment: Qt.AlignVCenter
            implicitWidth: pctMetrics.width
            implicitHeight: pctText.implicitHeight

            TextMetrics {
                id: pctMetrics
                text: "100"
                font.pixelSize: Appearance.font.pixelSize.small
            }

            StyledText {
                id: pctText
                anchors.centerIn: parent
                color: Appearance.colors.colOnLayer1
                font.pixelSize: Appearance.font.pixelSize.small
                text: LlmUsage.ready
                    ? `${Math.round(LlmUsage.worstUsedPercent || 0)}`
                    : "…"
            }
        }
    }

    LlmUsagePopup {
        hoverTarget: popupAnchor
    }
}
