import QtQuick

/**
 * Headroom's warm "cookbook" palette: cream → clay → charcoal chrome plus an
 * olive → amber → terracotta → rust gauge ramp. Light and dark variants.
 */
QtObject {
    id: skin
    property bool dark: true

    readonly property color bg: dark ? "#2A2520" : "#F3EAD5"
    readonly property color card: dark ? "#352F2A" : "#FFFDF8"
    readonly property color bg2: dark ? "#31291F" : "#F5E7C9"
    readonly property color edge: dark ? "#4A4036" : "#E2CDB1"
    readonly property color clay: dark ? "#8C7257" : "#B79476"
    readonly property color ink: dark ? "#F0E7D3" : "#4A463E"
    readonly property color ink2: dark ? "#C9BCA4" : "#6B6B64"
    readonly property color faint: dark ? "#9A8E78" : "#968A73"

    readonly property color healthy: dark ? "#8AA64F" : "#6E8B3D"
    readonly property color warming: dark ? "#E0A24F" : "#CC8A3C"
    readonly property color pressing: dark ? "#D5743A" : "#C2622D"
    readonly property color critical: dark ? "#BC5040" : "#9E3B2E"
    readonly property color runaway: dark ? "#8C5476" : "#6D3B5E"

    // usage fraction (0..1, may exceed 1) → tier color
    function ramp(f) {
        if (f < 0.70) return healthy
        if (f < 0.85) return warming
        if (f < 0.95) return pressing
        if (f <= 1.0) return critical
        return runaway
    }

    function alpha(c, a) {
        return Qt.rgba(c.r, c.g, c.b, a)
    }

    // per-provider monogram + accent (our own letters, no logos)
    function letter(id) {
        return ({ anthropic: "C", openai: "O", zai: "G", xai: "X", kimi: "K", minimax: "M" })[id] || "?"
    }
    function accent(id) {
        if (id === "anthropic") return pressing
        if (id === "openai") return healthy
        if (id === "zai") return runaway
        if (id === "xai") return ink2
        if (id === "kimi") return warming
        if (id === "minimax") return critical
        return clay
    }

    // --- text helpers shared by the popup ---

    // seconds → "in 45 min" / "in 2 hours" / "in 5 days"
    function relIn(sec) {
        if (sec == null || sec < 0) return ""
        if (sec < 90) return "in a minute"
        if (sec < 3600) return "in " + Math.round(sec / 60) + " min"
        if (sec < 86400) {
            const h = Math.round(sec / 3600)
            return "in " + h + (h === 1 ? " hour" : " hours")
        }
        const d = Math.round(sec / 86400)
        return d === 1 ? "in 1 day" : "in " + d + " days"
    }

    function ago(iso) {
        if (!iso) return ""
        const s = (Date.now() - Date.parse(iso)) / 1000
        if (!isFinite(s)) return ""
        if (s < 60) return "now"
        if (s < 3600) return Math.round(s / 60) + " min ago"
        if (s < 86400) return Math.round(s / 3600) + "h ago"
        return Math.round(s / 86400) + "d ago"
    }

    function secondsLeft(w) {
        if (w.resetsAt) {
            const s = (Date.parse(w.resetsAt) - Date.now()) / 1000
            if (isFinite(s)) return Math.max(0, s)
        }
        return w.resetAfterSeconds != null ? w.resetAfterSeconds : -1
    }

    function clock(iso) {
        return Qt.formatTime(new Date(iso), "hh:mm")
    }

    function tokens(n) {
        if (n >= 1e9) return (n / 1e9).toFixed(2) + "B"
        if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
        if (n >= 1e3) return Math.round(n / 1e3) + "k"
        return "" + Math.round(n)
    }
}
