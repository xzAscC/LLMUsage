import qs.modules.common
import qs.modules.common.widgets
import QtQuick
import QtQuick.Layouts

/** One usage window: label · % used, the segmented gauge, reset + pace line. */
ColumnLayout {
    id: meter
    property var skin
    property var win
    property real dim: 1

    readonly property bool unlimited: win.usedPercent == null && win.note === "unlimited"
    readonly property var pace: win.pace
    readonly property real secs: skin.secondsLeft(win)

    spacing: 5
    opacity: dim

    function paceText() {
        if (!pace) return ""
        if (pace.kind === "reserve") return pace.marginPercent + "% in reserve"
        if (pace.kind === "even") return "on pace"
        if (pace.runsOutAt && Date.parse(pace.runsOutAt) - Date.now() < 16 * 3600 * 1000)
            return "empties ~" + skin.clock(pace.runsOutAt)
        return "lands ~" + pace.projectedPercent + "%"
    }

    function paceColor() {
        if (!pace) return skin.faint
        if (pace.kind === "reserve") return skin.healthy
        if (pace.kind === "even") return skin.faint
        const soon = pace.runsOutAt && Date.parse(pace.runsOutAt) - Date.now() < 16 * 3600 * 1000
        return soon ? skin.pressing : skin.warming
    }

    RowLayout {
        Layout.fillWidth: true
        StyledText {
            text: (meter.win.label || "").trim()
            textFormat: Text.PlainText // names and errors come from servers and logs
            color: meter.skin.ink2
            font.pixelSize: 12
        }
        Item { Layout.fillWidth: true }
        StyledText {
            visible: !meter.unlimited
            text: Math.round(meter.win.usedPercent) + "% used"
            color: meter.skin.ink2
            font.pixelSize: 12
            font.family: Appearance.font.family.numbers
        }
        RowLayout {
            visible: meter.unlimited
            spacing: 3
            MaterialSymbol {
                text: "all_inclusive"
                iconSize: 13
                color: meter.skin.healthy
            }
            StyledText {
                text: "Unlimited"
                color: meter.skin.healthy
                font.pixelSize: 12
                font.weight: Font.Medium
            }
        }
    }

    LuGauge {
        visible: !meter.unlimited
        Layout.fillWidth: true
        Layout.topMargin: 1
        Layout.bottomMargin: 1
        skin: meter.skin
        fraction: (meter.win.usedPercent || 0) / 100
        paceElapsed: meter.pace ? meter.pace.elapsedPercent / 100 : -1
    }

    Rectangle {
        visible: meter.unlimited
        Layout.fillWidth: true
        implicitHeight: 8
        radius: 2
        color: meter.skin.alpha(meter.skin.healthy, 0.18)
    }

    // an unused window has no reset time yet; say so, which also keeps every
    // meter the same height so meters in a row of cards line up
    readonly property bool notStarted: meter.win.usedPercent === 0 && meter.secs < 0 && !meter.pace

    RowLayout {
        visible: !meter.unlimited && (meter.secs >= 0 || !!meter.pace || meter.notStarted)
        spacing: 5
        StyledText {
            visible: meter.notStarted
            text: "not started"
            color: meter.skin.faint
            font.pixelSize: 11
        }
        StyledText {
            visible: meter.secs >= 0
            text: "resets " + meter.skin.relIn(meter.secs)
            color: meter.skin.faint
            font.pixelSize: 11
        }
        StyledText {
            visible: meter.secs >= 0 && !!meter.pace
            text: "·"
            color: meter.skin.faint
            font.pixelSize: 11
        }
        StyledText {
            visible: !!meter.pace
            text: meter.paceText()
            color: meter.paceColor()
            font.pixelSize: 11
            font.weight: meter.pace && meter.pace.kind === "deficit" ? Font.Medium : Font.Normal
        }
    }
}
