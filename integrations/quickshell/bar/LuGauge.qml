import QtQuick

/**
 * Twenty-segment meter on the warm ramp. Lit segments take the color of
 * their own position, so the bar shows how hot you are, not just how far.
 * The tick marks the even-burn line: fill past it = ahead of pace.
 */
Item {
    id: gauge
    property var skin
    property real fraction: 0          // 0..1+
    property real paceElapsed: -1      // 0..1, <0 hides the tick
    property int segments: 20
    property real gap: 2

    implicitHeight: 8
    readonly property real segW: (width - gap * (segments - 1)) / segments

    Repeater {
        model: gauge.segments
        delegate: Rectangle {
            required property int index
            x: index * (gauge.segW + gauge.gap)
            width: gauge.segW
            height: gauge.height
            radius: 2
            readonly property bool lit: gauge.fraction > index / gauge.segments + 0.0001
            color: !lit ? gauge.skin.alpha(gauge.skin.edge, 0.55)
                : gauge.fraction > 1 ? gauge.skin.runaway
                : gauge.skin.ramp((index + 1) / gauge.segments)
        }
    }

    Rectangle {
        visible: gauge.paceElapsed >= 0
        width: 2
        height: gauge.height + 5
        radius: 1
        x: gauge.width * Math.max(0, Math.min(1, gauge.paceElapsed)) - 1
        y: -2.5
        color: gauge.skin.alpha(gauge.skin.ink, 0.55)
    }
}
