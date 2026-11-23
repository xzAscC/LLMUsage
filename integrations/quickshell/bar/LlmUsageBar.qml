import qs.modules.common
import qs.modules.common.widgets
import qs.modules.common.functions
import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

/**
 * Self-contained LLM usage bar chip, styled after Headroom: a chef-hat gauge
 * in the bar and a warm card popup (usage + history).
 * Lives in the LLMUsage project; loaded via Loader from BarContent.
 * Data: ~/.cache/llm-usage/snapshot.json via project-local bun CLI.
 */
MouseArea {
    id: root

    // --- state ---
    property bool popupOpen: false
    property bool popupHovered: false
    property bool showHistory: false
    property bool ready: false
    property bool checking: false
    property var providers: []
    property real worstUsedPercent: 0
    property string severity: "unknown"
    property string lastError: ""
    property string fetchedAt: ""
    property var tokenSeries: null
    property var utilization: []
    property bool historyLoading: false

    readonly property string projectRoot: FileUtils.trimFileProtocol(Qt.resolvedUrl("../../.."))
    readonly property string bunPath: "/usr/bin/bun"
    readonly property string entryPath: projectRoot + "/src/index.ts"
    readonly property string cachePath: FileUtils.trimFileProtocol(Directories.home) + "/.cache/llm-usage/snapshot.json"
    readonly property real usedFraction: Math.min(1, Math.max(0, worstUsedPercent / 100))
    readonly property bool failed: severity === "error"
    readonly property color tint: failed ? lu.critical : lu.ramp(usedFraction)

    LuSkin {
        id: lu
        dark: Appearance.m3colors.darkmode
    }

    implicitWidth: row.implicitWidth + 10
    implicitHeight: Appearance.sizes.barHeight
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    cursorShape: Qt.PointingHandCursor

    function applySnapshot(text) {
        try {
            const data = JSON.parse(text)
            root.providers = data.providers || []
            root.worstUsedPercent = Number(data.headlinePercent ?? data.worstUsedPercent ?? 0)
            root.severity = data.severity || "unknown"
            root.fetchedAt = data.fetchedAt || ""
            root.lastError = ""
            root.ready = Array.isArray(root.providers) && root.providers.length > 0
        } catch (e) {
            root.lastError = String(e)
            root.ready = false
        }
    }

    // Periodic refreshes reuse a snapshot the systemd timer wrote in the last
    // 4 minutes; right-click (or the popup's refresh button) forces a live fetch.
    property bool forceNext: false

    function refresh(force) {
        if (refreshProc.running)
            return
        root.forceNext = !!force
        root.checking = true
        refreshProc.running = true
    }

    function loadHistory() {
        if (tokensProc.running)
            return
        root.historyLoading = true
        tokensProc.running = true
        utilProc.running = true
    }

    // --- card layout: how tall a card is, in meter rows (data only, no measuring) ---
    function cardWeight(p) {
        const ws = p.windows || []
        const meters = ws.filter(w => w.usedPercent != null || w.note === "unlimited").length
        const notes = ws.some(w => w.usedPercent == null && w.note && w.note !== "unlimited")
        const login = Date.parse(p.loginExpiresAt || "") - Date.now() <= 3 * 86400000
        return (p.ok ? meters : 1) + (notes || login ? 0.5 : 0)
    }

    // Equal-height rows: pair the two tallest cards, then the next two, ...;
    // each pair keeps the config order left to right, rows keep it top to bottom.
    function arrange(ps, columns) {
        if (columns < 2) return ps
        const byWeight = ps.map((p, i) => ({ p: p, i: i, w: cardWeight(p) }))
            .sort((a, b) => b.w - a.w || a.i - b.i)
        const rows = []
        for (let k = 0; k < byWeight.length; k += columns)
            rows.push(byWeight.slice(k, k + columns).sort((a, b) => a.i - b.i))
        rows.sort((a, b) => a[0].i - b[0].i)
        return [].concat.apply([], rows).map(x => x.p)
    }

    // --- capacity summary across providers (Headroom's "3 comfortable · 1 tight") ---
    function tightest(p) {
        const nums = (p.windows || []).map(w => w.usedPercent).filter(n => n != null)
        return nums.length ? Math.max(...nums) : null
    }

    readonly property var capacity: {
        let comfortable = 0, warming = 0, tight = 0, down = 0
        let hot = null, room = null
        for (const p of providers) {
            const t = p.ok ? tightest(p) : null
            if (t == null) { down++; continue }
            if (t < 70) comfortable++
            else if (t < 85) warming++
            else tight++
            if (!hot || t > hot.t) hot = { name: p.name, t: t }
            if (!room || t < room.t) room = { name: p.name, t: t }
        }
        const parts = []
        if (comfortable) parts.push(comfortable + " comfortable")
        if (warming) parts.push(warming + " warming")
        if (tight) parts.push(tight + " tight")
        if (down) parts.push(down + " unavailable")
        return {
            phrase: parts.join(" · "),
            color: tight ? lu.pressing : warming ? lu.warming : lu.healthy,
            hot: hot && hot.t >= 70 && room && room.name !== hot.name ? hot : null,
            room: room
        }
    }

    onClicked: event => {
        if (event.button === Qt.RightButton) {
            root.refresh(true)
            return
        }
        root.popupOpen = !root.popupOpen
    }

    // close shortly after the pointer leaves both the chip and the popup
    Timer {
        id: closeTimer
        interval: 350
        onTriggered: {
            if (!root.containsMouse && !root.popupHovered)
                root.popupOpen = false
        }
    }
    onContainsMouseChanged: if (!containsMouse) closeTimer.restart()
    onPopupHoveredChanged: if (!popupHovered) closeTimer.restart()
    onPopupOpenChanged: {
        if (!popupOpen) root.showHistory = false
    }
    onShowHistoryChanged: if (showHistory) root.loadHistory()

    RowLayout {
        id: row
        anchors.centerIn: parent
        spacing: 4

        LuChefHat {
            Layout.alignment: Qt.AlignVCenter
            implicitWidth: 19
            implicitHeight: 19
            fraction: root.ready ? Math.max(0.04, root.usedFraction) : 0
            tint: root.tint
        }

        StyledText {
            Layout.alignment: Qt.AlignVCenter
            color: root.ready ? root.tint : Appearance.colors.colOnLayer1
            font.pixelSize: Appearance.font.pixelSize.small
            font.weight: Font.DemiBold
            font.family: Appearance.font.family.numbers
            text: root.ready
                ? (Math.round(root.worstUsedPercent || 0) + "%")
                : (root.checking ? "…" : "!")
        }
    }

    // --- data sources ---
    Timer {
        interval: 400
        running: true
        repeat: true
        onTriggered: {
            root.refresh(false)
            interval = 300000 // 5 min
        }
    }

    Process {
        id: refreshProc
        command: [root.bunPath, root.entryPath, "json", root.forceNext ? "--force" : "--max-age=240"]
        stdout: StdioCollector {
            onStreamFinished: {
                root.checking = false
                if (text && text.trim().length > 0)
                    root.applySnapshot(text.trim())
                cacheFile.reload()
            }
        }
        stderr: StdioCollector {
            onStreamFinished: {
                if (text && text.trim().length > 0)
                    root.lastError = text.trim().slice(0, 240)
            }
        }
        onExited: (code, _st) => {
            root.checking = false
            if (code !== 0 && !root.ready)
                root.lastError = root.lastError || ("exit " + code)
            cacheFile.reload()
        }
    }

    Process {
        id: tokensProc
        command: [root.bunPath, root.entryPath, "tokens", "--json", "--days=30", "--max-age=900"]
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    root.tokenSeries = JSON.parse(text)
                } catch (e) {}
                root.historyLoading = false
            }
        }
        onExited: root.historyLoading = false
    }

    Process {
        id: utilProc
        command: [root.bunPath, root.entryPath, "history", "--json", "--days=30"]
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    root.utilization = JSON.parse(text)
                } catch (e) {}
            }
        }
    }

    FileView {
        id: cacheFile
        path: root.cachePath
        watchChanges: true
        onFileChanged: reload()
        onLoaded: {
            const t = text()
            if (t && t.trim().length > 0)
                root.applySnapshot(t)
        }
    }

    Component.onCompleted: {
        cacheFile.reload()
        root.refresh(false)
    }

    // --- popup ---
    LazyLoader {
        active: root.popupOpen

        component: PanelWindow {
            id: popupWindow
            color: "transparent"

            readonly property bool vertical: Config.options.bar.vertical
            readonly property bool bottom: Config.options.bar.bottom

            anchors.left: !vertical || (vertical && !bottom)
            anchors.right: vertical && bottom
            anchors.top: vertical || (!vertical && !bottom)
            anchors.bottom: !vertical && bottom

            implicitWidth: panel.implicitWidth + Appearance.sizes.elevationMargin * 2
            implicitHeight: panel.implicitHeight + Appearance.sizes.elevationMargin * 2

            mask: Region {
                item: panel
            }
            exclusionMode: ExclusionMode.Ignore
            exclusiveZone: 0
            margins {
                left: {
                    if (!popupWindow.vertical)
                        return Math.max(0, root.QsWindow?.mapFromItem(root, (root.width - popupWindow.implicitWidth) / 2, 0).x ?? 0)
                    return Appearance.sizes.verticalBarWidth
                }
                top: {
                    if (!popupWindow.vertical)
                        return Appearance.sizes.barHeight
                    return Math.max(0, root.QsWindow?.mapFromItem(root, 0, (root.height - popupWindow.implicitHeight) / 2).y ?? 0)
                }
                right: Appearance.sizes.verticalBarWidth
                bottom: Appearance.sizes.barHeight
            }
            WlrLayershell.namespace: "quickshell:popup"
            WlrLayershell.layer: WlrLayer.Overlay

            StyledRectangularShadow {
                target: panel
            }

            Rectangle {
                id: panel
                anchors.fill: parent
                anchors.margins: Appearance.sizes.elevationMargin
                readonly property int columns: root.providers.length >= 4 ? 2 : 1
                readonly property real cardWidth: 320
                implicitWidth: content.width + 28
                // switching views never shrinks the panel: a shorter view would
                // pull the toggle out from under the pointer and close the popup
                property real minHeight: 0
                implicitHeight: Math.max(content.implicitHeight + footer.implicitHeight + 38, minHeight)
                radius: 12
                color: lu.bg
                border.width: 1
                border.color: lu.edge

                HoverHandler {
                    onHoveredChanged: root.popupHovered = hovered
                }

                ColumnLayout {
                    id: content
                    anchors.top: parent.top
                    anchors.topMargin: 14
                    anchors.horizontalCenter: parent.horizontalCenter
                    width: panel.columns * panel.cardWidth + (panel.columns - 1) * 10
                    spacing: 10

                    // header
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 8
                        LuChefHat {
                            implicitWidth: 22
                            implicitHeight: 22
                            fraction: 1
                            tint: lu.clay
                            outline: false
                        }
                        StyledText {
                            text: root.showHistory ? "Usage History" : "LLM Usage"
                            color: lu.ink
                            font.pixelSize: 16
                            font.weight: Font.Bold
                        }
                        Item { Layout.fillWidth: true }
                        StyledText {
                            visible: root.showHistory
                            text: "tokens · from local logs"
                            color: lu.faint
                            font.pixelSize: 11
                        }
                        MaterialSymbol {
                            visible: !root.showHistory
                            text: "refresh"
                            iconSize: 18
                            color: refreshArea.containsMouse ? lu.ink : lu.faint
                            RotationAnimator on rotation {
                                running: root.checking
                                from: 0
                                to: 360
                                duration: 900
                                loops: Animation.Infinite
                            }
                            MouseArea {
                                id: refreshArea
                                anchors.fill: parent
                                anchors.margins: -4
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: root.refresh(true)
                            }
                        }
                    }

                    // capacity line
                    RowLayout {
                        visible: !root.showHistory && root.capacity.phrase !== ""
                        Layout.leftMargin: 2
                        spacing: 7
                        Rectangle {
                            implicitWidth: 7
                            implicitHeight: 7
                            radius: 3.5
                            color: root.capacity.color
                        }
                        StyledText {
                            text: root.capacity.phrase
                            color: lu.ink2
                            font.pixelSize: 12
                        }
                    }

                    // "use this next" banner
                    Rectangle {
                        visible: !root.showHistory && !!root.capacity.hot
                        Layout.fillWidth: true
                        implicitHeight: bannerRow.implicitHeight + 12
                        radius: 8
                        color: lu.alpha(lu.healthy, 0.10)
                        border.width: 1
                        border.color: lu.alpha(lu.healthy, 0.30)
                        RowLayout {
                            id: bannerRow
                            anchors.verticalCenter: parent.verticalCenter
                            x: 9
                            spacing: 7
                            MaterialSymbol {
                                text: "subdirectory_arrow_right"
                                iconSize: 14
                                color: lu.healthy
                            }
                            StyledText {
                                textFormat: Text.StyledText
                                text: root.capacity.hot
                                    ? ("<b>" + root.capacity.hot.name + "</b> " + Math.round(root.capacity.hot.t)
                                        + "% used · most room: <b>" + root.capacity.room.name + "</b> " + Math.round(root.capacity.room.t) + "%")
                                    : ""
                                color: lu.ink2
                                font.pixelSize: 12
                            }
                        }
                    }

                    // cards: rows of similar-height cards, each row as tall as its tallest
                    GridLayout {
                        visible: !root.showHistory
                        Layout.fillWidth: true
                        columns: panel.columns
                        columnSpacing: 10
                        rowSpacing: 10
                        Repeater {
                            model: root.arrange(root.providers, panel.columns)
                            delegate: LuCard {
                                required property var modelData
                                Layout.preferredWidth: panel.cardWidth
                                Layout.fillHeight: true
                                skin: lu
                                provider: modelData
                            }
                        }
                    }

                    StyledText {
                        visible: !root.showHistory && !root.ready
                        text: root.lastError || "Loading…"
                        textFormat: Text.PlainText // names and errors come from servers and logs
                        color: lu.faint
                        font.pixelSize: 12
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                    }

                    LuHistory {
                        visible: root.showHistory
                        Layout.fillWidth: true
                        skin: lu
                        tokenSeries: root.tokenSeries
                        utilization: root.utilization
                        loading: root.historyLoading
                    }
                }

                // footer, pinned to the bottom edge so the view toggle stays put
                ColumnLayout {
                    id: footer
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: 14
                    anchors.horizontalCenter: parent.horizontalCenter
                    width: content.width
                    spacing: 10

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: 1
                        color: lu.edge
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: 12
                        StyledText {
                            text: root.checking ? "Updating…" : ("Updated " + lu.ago(root.fetchedAt))
                            color: lu.faint
                            font.pixelSize: 11
                        }
                        Item { Layout.fillWidth: true }
                        MaterialSymbol {
                            text: root.showHistory ? "dashboard" : "bar_chart"
                            iconSize: 18
                            color: histArea.containsMouse ? lu.ink : lu.ink2
                            MouseArea {
                                id: histArea
                                anchors.fill: parent
                                anchors.margins: -4
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    panel.minHeight = panel.height
                                    root.showHistory = !root.showHistory
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
