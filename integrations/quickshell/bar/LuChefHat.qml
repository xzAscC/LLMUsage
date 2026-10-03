import QtQuick

/**
 * The chef's-toque gauge: a hat silhouette that fills bottom-up with the
 * tier color as quota is spent (brim first, then crown). Drawn in a unit box.
 */
Canvas {
    id: hat
    property real fraction: 0
    property color tint: "#6E8B3D"
    property real trackOpacity: 0.22
    property bool outline: true

    implicitWidth: 18
    implicitHeight: 18
    antialiasing: true

    onFractionChanged: requestPaint()
    onTintChanged: requestPaint()
    onWidthChanged: requestPaint()
    onHeightChanged: requestPaint()

    function hatPath(ctx, w, h) {
        ctx.beginPath()
        function puff(cx, cy, r) {
            ctx.ellipse((cx - r) * w, (cy - r) * h, 2 * r * w, 2 * r * h)
        }
        puff(0.31, 0.40, 0.205)
        puff(0.69, 0.40, 0.205)
        puff(0.50, 0.30, 0.235)
        ctx.moveTo(0.16 * w, 0.50 * h)
        ctx.lineTo(0.84 * w, 0.50 * h)
        ctx.lineTo(0.80 * w, 0.66 * h)
        ctx.lineTo(0.20 * w, 0.66 * h)
        ctx.closePath()
        ctx.roundedRect(0.21 * w, 0.62 * h, 0.58 * w, 0.24 * h, 0.055 * w, 0.06 * h)
    }

    onPaint: {
        const ctx = getContext("2d")
        const w = width, h = height
        ctx.reset()
        const f = Math.max(0, Math.min(1, fraction))
        // the hat occupies y ∈ [0.065, 0.86] of the box; fill that span
        const top = 0.065 * h, bottom = 0.86 * h

        hatPath(ctx, w, h)
        ctx.fillStyle = Qt.rgba(tint.r, tint.g, tint.b, trackOpacity)
        ctx.fill()

        if (f >= 1) {
            hatPath(ctx, w, h)
            ctx.fillStyle = tint
            ctx.fill()
        } else if (f > 0) {
            ctx.save()
            hatPath(ctx, w, h)
            ctx.clip()
            const fillTop = bottom - (bottom - top) * f
            ctx.fillStyle = tint
            ctx.fillRect(0, fillTop, w, h - fillTop)
            ctx.restore()
        }

        if (outline) {
            hatPath(ctx, w, h)
            ctx.lineWidth = Math.max(0.8, w / 22)
            ctx.strokeStyle = tint
            ctx.stroke()
        }
    }
}
