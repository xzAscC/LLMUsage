pragma Singleton
pragma ComponentBehavior: Bound

import qs.modules.common
import qs.modules.common.functions
import QtQuick
import Quickshell
import Quickshell.Io

/**
 * Local LLM subscription usage service.
 * Reads ~/.cache/llm-usage/snapshot.json written by project-local bin/llm-usage.
 * No global install; absolute CLI path only.
 */
Singleton {
    id: root

    readonly property string projectRoot: "/home/xzascc/Documents/code/LLMUsage"
    readonly property string cliPath: projectRoot + "/bin/llm-usage"
    // Always ~/.cache/llm-usage (not the illogical-impulse cache dir)
    readonly property string cachePath: FileUtils.trimFileProtocol(Directories.home) + "/.cache/llm-usage/snapshot.json"

    property bool ready: false
    property var providers: []
    property real worstUsedPercent: 0
    property string severity: "unknown"
    property string fetchedAt: ""
    property string lastError: ""
    property bool checking: refreshProc.running

    function load() {
        refresh()
    }

    function refresh() {
        if (refreshProc.running)
            return
        refreshProc.running = true
    }

    function applySnapshot(text) {
        try {
            const data = JSON.parse(text)
            root.providers = data.providers || []
            root.worstUsedPercent = Number(data.worstUsedPercent ?? 0)
            root.severity = data.severity || "unknown"
            root.fetchedAt = data.fetchedAt || ""
            root.lastError = ""
            root.ready = true
        } catch (e) {
            root.lastError = String(e)
            root.ready = false
        }
    }

    Timer {
        id: pollTimer
        interval: 1
        running: true
        repeat: true
        onTriggered: {
            root.refresh()
            interval = (Config.options?.bar?.llmUsage?.refreshInterval ?? 300) * 1000
        }
    }

    Process {
        id: refreshProc
        command: [root.cliPath, "json", "--force"]
        stdout: StdioCollector {
            onStreamFinished: {
                // CLI also writes cache; re-read file for FileView sync
                cacheFile.reload()
            }
        }
        stderr: StdioCollector {
            onStreamFinished: {
                if (text && text.trim().length > 0)
                    root.lastError = text.trim().slice(0, 200)
            }
        }
        onExited: (exitCode, _exitStatus) => {
            if (exitCode !== 0 && root.lastError === "")
                root.lastError = "llm-usage exited " + exitCode
            cacheFile.reload()
        }
    }

    FileView {
        id: cacheFile
        path: root.cachePath
        watchChanges: true
        onFileChanged: reload()
        onLoaded: root.applySnapshot(text())
        onLoadFailed: _err => {
            // First run: wait for Process to populate cache
            root.ready = root.providers.length > 0
        }
    }
}
