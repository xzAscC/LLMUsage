import qs.modules.common
import qs.modules.common.widgets
import QtQuick
import QtQuick.Layouts

/**
 * Usage history: token totals from local Claude Code / Codex / pi logs
 * (stat tiles + trend), and the self-recorded daily peak per window.
 */
ColumnLayout {
    id: hist
    property var skin
    property var tokenSeries: null     // { days: [...], sources: { name: [n...] } }
    property var utilization: []       // [{ id, label, peaks: [...] }]
    property bool loading: false
    property string source: "All"

    spacing: 10

    readonly property var sourceNames: tokenSeries ? Object.keys(tokenSeries.sources).filter(k => tokenSeries.sources[k].some(v => v > 0)) : []
    readonly property var values: {
        if (!tokenSeries) return []
        const names = source === "All" ? sourceNames : [source]
        return tokenSeries.days.map((_, i) => names.reduce((a, n) => a + (tokenSeries.sources[n] ? tokenSeries.sources[n][i] : 0), 0))
    }

    // tokens per model over the last 7 days, for the agent picked in the trend
    readonly property var modelRows: {
        if (!tokenSeries || !tokenSeries.models) return []
        const n = tokenSeries.days.length
        return tokenSeries.models
            .filter(m => source === "All" || m.source === source)
            .map(m => ({ label: m.label, total: m.days.slice(Math.max(0, n - 7)).reduce((a, b) => a + b, 0) }))
            .filter(m => m.total > 0)
            .sort((a, b) => b.total - a.total)
            .slice(0, 6)
    }

    function sumLast(n, skipToday) {
        const v = values
        const end = skipToday ? v.length - 1 : v.length
        let s = 0
        for (let i = Math.max(0, end - n); i < end; i++) s += v[i]
        return s
    }

    component Tile: Rectangle {
        property string value
        property string caption
        Layout.fillWidth: true
        implicitHeight: 54
        radius: 9
        color: hist.skin.card
        border.width: 1
        border.color: hist.skin.edge
        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 10
            spacing: 0
            StyledText {
                text: parent.parent.value
                color: hist.skin.ink
                font.pixelSize: 17
                font.weight: Font.DemiBold
                font.family: Appearance.font.family.numbers
            }
            StyledText {
                text: parent.parent.caption
                color: hist.skin.faint
                font.pixelSize: 11
            }
        }
    }

    component Panel: Rectangle {
        default property alias content: inner.data
        property string title
        Layout.fillWidth: true
        implicitHeight: inner.implicitHeight + 34
        radius: 9
        color: hist.skin.card
        border.width: 1
        border.color: hist.skin.edge
        StyledText {
            x: 10
            y: 8
            text: parent.title
            color: hist.skin.ink2
            font.pixelSize: 12
            font.weight: Font.DemiBold
        }
        ColumnLayout {
            id: inner
            anchors {
                left: parent.left
                right: parent.right
                top: parent.top
                topMargin: 28
                leftMargin: 10
                rightMargin: 10
            }
            spacing: 6
        }
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 8
        Tile { value: hist.tokenSeries ? hist.skin.tokens(hist.sumLast(1, false)) : "…"; caption: "Today" }
        Tile { value: hist.tokenSeries ? hist.skin.tokens(hist.sumLast(7, false)) : "…"; caption: "Last 7 days" }
        Tile { value: hist.tokenSeries ? hist.skin.tokens(hist.sumLast(30, false)) : "…"; caption: "Last 30 days" }
    }

    Panel {
        title: "Token Trend" + (hist.loading ? "  ·  scanning logs…" : "")

        Flow {
            Layout.fillWidth: true
            spacing: 5
            Repeater {
                model: ["All"].concat(hist.sourceNames)
                delegate: Rectangle {
                    required property var modelData
                    readonly property bool on: hist.source === modelData
                    implicitWidth: chipText.implicitWidth + 14
                    implicitHeight: chipText.implicitHeight + 4
                    radius: height / 2
                    color: on ? hist.skin.clay : hist.skin.bg2
                    border.width: 1
                    border.color: on ? hist.skin.clay : hist.skin.edge
                    StyledText {
                        id: chipText
                        anchors.centerIn: parent
                        text: modelData
                        color: parent.on ? hist.skin.bg2 : hist.skin.ink2
                        font.pixelSize: 11
                        font.weight: parent.on ? Font.Bold : Font.Normal
                    }
                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: hist.source = modelData
                    }
                }
            }
        }

        Canvas {
            id: chart
            Layout.fillWidth: true
            implicitHeight: 130
            antialiasing: true
            property var vals: hist.values
            property var days: hist.tokenSeries ? hist.tokenSeries.days : []
            onValsChanged: requestPaint()
            onWidthChanged: requestPaint()

            onPaint: {
                const ctx = getContext("2d")
                ctx.reset()
                const v = vals
                if (!v || v.length < 2) return
                const axisW = 42, padTop = 6, padBottom = 18
                const w = width - axisW, h = height - padTop - padBottom
                const max = Math.max(1, ...v) * 1.1
                const sk = hist.skin

                ctx.font = "10px sans-serif"
                ctx.textBaseline = "middle"
                for (let g = 0; g <= 2; g++) {
                    const y = padTop + h - (h * g) / 2
                    ctx.strokeStyle = sk.alpha(sk.edge, 0.8)
                    ctx.lineWidth = 1
                    ctx.beginPath()
                    ctx.moveTo(0, y)
                    ctx.lineTo(w, y)
                    ctx.stroke()
                    ctx.fillStyle = sk.faint
                    ctx.fillText(sk.tokens((max * g) / 2), w + 5, y)
                }

                const px = i => (w * i) / (v.length - 1)
                const py = n => padTop + h - (h * n) / max

                ctx.textBaseline = "top"
                for (let i = 0; i < days.length; i += 7) {
                    const x = px(i)
                    ctx.strokeStyle = sk.alpha(sk.edge, 0.6)
                    for (let y = padTop; y < padTop + h; y += 5) {
                        ctx.beginPath()
                        ctx.moveTo(x, y)
                        ctx.lineTo(x, Math.min(y + 2, padTop + h))
                        ctx.stroke()
                    }
                    const d = new Date(days[i] + "T12:00:00")
                    ctx.fillStyle = sk.faint
                    ctx.fillText(Qt.formatDate(d, "MMM d"), x + 3, padTop + h + 4)
                }

                function curve() {
                    ctx.moveTo(px(0), py(v[0]))
                    for (let i = 1; i < v.length; i++) {
                        const xm = (px(i - 1) + px(i)) / 2
                        ctx.bezierCurveTo(xm, py(v[i - 1]), xm, py(v[i]), px(i), py(v[i]))
                    }
                }

                const grad = ctx.createLinearGradient(0, padTop, 0, padTop + h)
                grad.addColorStop(0, sk.alpha(sk.pressing, 0.28))
                grad.addColorStop(1, sk.alpha(sk.pressing, 0.02))
                ctx.beginPath()
                curve()
                ctx.lineTo(px(v.length - 1), padTop + h)
                ctx.lineTo(px(0), padTop + h)
                ctx.closePath()
                ctx.fillStyle = grad
                ctx.fill()

                ctx.beginPath()
                curve()
                ctx.strokeStyle = sk.pressing
                ctx.lineWidth = 2
                ctx.stroke()
            }
        }
    }

    Panel {
        title: "By model · last 7 days"
        visible: hist.modelRows.length > 0

        Repeater {
            model: hist.modelRows
            delegate: RowLayout {
                required property var modelData
                Layout.fillWidth: true
                spacing: 8
                StyledText {
                    text: modelData.label
                    textFormat: Text.PlainText // names and errors come from servers and logs
                    color: hist.skin.ink2
                    font.pixelSize: 11
                    elide: Text.ElideRight
                    Layout.preferredWidth: 130
                }
                Item {
                    Layout.fillWidth: true
                    implicitHeight: 10
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        height: 8
                        radius: 4
                        width: Math.max(3, parent.width * modelData.total / hist.modelRows[0].total)
                        color: hist.skin.clay
                    }
                }
                StyledText {
                    text: hist.skin.tokens(modelData.total)
                    color: hist.skin.ink2
                    font.pixelSize: 11
                    font.family: Appearance.font.family.numbers
                    Layout.preferredWidth: 44
                    horizontalAlignment: Text.AlignRight
                }
            }
        }
    }

    Panel {
        title: "Recorded utilization · daily peak, last 30 days"

        StyledText {
            visible: hist.utilization.length === 0
            text: "Nothing recorded yet — history accrues with every refresh."
            color: hist.skin.faint
            font.pixelSize: 11
        }

        Repeater {
            model: hist.utilization
            delegate: RowLayout {
                required property var modelData
                Layout.fillWidth: true
                spacing: 8
                StyledText {
                    text: modelData.label
                    textFormat: Text.PlainText // names and errors come from servers and logs
                    color: hist.skin.ink2
                    font.pixelSize: 11
                    elide: Text.ElideRight
                    Layout.preferredWidth: 130
                }
                Item {
                    Layout.fillWidth: true
                    implicitHeight: 22
                    Row {
                        height: 22
                        spacing: 2
                        Repeater {
                            model: modelData.peaks
                            delegate: Rectangle {
                                required property var modelData
                                y: 22 - height
                                width: 5
                                radius: 1.5
                                height: modelData == null ? 2 : Math.max(3, 22 * Math.min(1, modelData / 100))
                                color: modelData == null ? hist.skin.alpha(hist.skin.edge, 0.6) : hist.skin.ramp(modelData / 100)
                            }
                        }
                    }
                }
                StyledText {
                    readonly property var known: modelData.peaks.filter(x => x != null)
                    text: known.length ? Math.round(known[known.length - 1]) + "%" : "—"
                    color: hist.skin.ink2
                    font.pixelSize: 11
                    font.family: Appearance.font.family.numbers
                    Layout.preferredWidth: 30
                    horizontalAlignment: Text.AlignRight
                }
            }
        }
    }
}
