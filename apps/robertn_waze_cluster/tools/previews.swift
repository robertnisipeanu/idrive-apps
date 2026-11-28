// SPDX-License-Identifier: GPL-3.0-or-later
// Draws the main page's preview pictures (src/previews.js) into
// package/previews/<name>.png:
//
//   swift tools/previews.swift            (macOS; any 957 × 639 PNG will do)
//
// Each is the preview's whole area, 957 × 639 in the HMI's 1920 × 720 units
// (LT_State_Regular_ContentHidden's contentPreviewRegularW/H_ID7; smaller
// displays scale the whole page down alike): the drawing in the upper part,
// the bottom 220 left for the preview's three lines of text, in the style of
// BMW's settings pages: a lit line drawing, a red glow behind it and a grid
// of dots. The drawings are line art in a 300 × 220 box, so a new one is a
// few strokes; keep the bottom band free.
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "package/previews"
let red = NSColor(calibratedRed: 0.86, green: 0.16, blue: 0.13, alpha: 1)
let white = NSColor(calibratedWhite: 0.92, alpha: 1)
let W = 957, H = 639
let band: CGFloat = 220     // the text's band: three lines of 56 and the top margin
let scale: CGFloat = 1.6   // the 300 × 220 drawing on the picture

func png(_ name: String, _ draw: (CGContext) -> Void) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let c = NSGraphicsContext.current!.cgContext
    c.setLineCap(.round); c.setLineJoin(.round)
    draw(c)
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
}

/* A lit stroke: the line with a red glow around it. */
func stroke(_ c: CGContext, _ color: NSColor, _ width: CGFloat, _ p: CGPath) {
    c.saveGState()
    c.setShadow(offset: .zero, blur: 16, color: red.withAlphaComponent(0.9).cgColor)
    c.setStrokeColor(color.cgColor); c.setLineWidth(width); c.addPath(p); c.strokePath()
    c.restoreGState()
}
func rounded(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> CGPath {
    CGPath(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerWidth: r, cornerHeight: r, transform: nil)
}
func lines(_ points: [[CGFloat]]) -> CGPath {
    let p = CGMutablePath()
    points.forEach { s in
        p.move(to: CGPoint(x: s[0], y: s[1]))
        stride(from: 2, to: s.count, by: 2).forEach { i in p.addLine(to: CGPoint(x: s[i], y: s[i + 1])) }
    }
    return p
}
/* A navigation arrow, its tip at (x, y + h). */
func arrow(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGPath {
    let p = lines([[x - w / 2, y, x, y + h, x + w / 2, y, x, y + h * 0.25]]).mutableCopy()!
    p.closeSubpath()
    return p
}
/* An arrowhead line from (x0, y0) to (x1, y1). */
func pointer(_ x0: CGFloat, _ y0: CGFloat, _ x1: CGFloat, _ y1: CGFloat) -> CGPath {
    let a = atan2(y1 - y0, x1 - x0), l: CGFloat = 14
    return lines([[x0, y0, x1, y1], [x1 - l * cos(a - 0.6), y1 - l * sin(a - 0.6), x1, y1, x1 - l * cos(a + 0.6), y1 - l * sin(a + 0.6)]])
}

/* The pieces the drawings share. */
func cluster(_ c: CGContext, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, map: Bool) {
    stroke(c, map ? red : white, 8, rounded(x, y, w, h, h * 0.21))
    let r = h * 0.2
    /* two alike gauges, open at the bottom (one open and one closed reads as a wink) */
    let dials = CGMutablePath()
    for cx in [x + w * 0.17, x + w * 0.83] {
        dials.move(to: CGPoint(x: cx + r * cos(-.pi * 0.25), y: y + h / 2 + r * sin(-.pi * 0.25)))
        dials.addArc(center: CGPoint(x: cx, y: y + h / 2), radius: r, startAngle: -.pi * 0.25, endAngle: .pi * 1.25, clockwise: false)
    }
    stroke(c, white, 5, dials)
    /* a needle in each, as a speedometer and a rev counter */
    let needles = CGMutablePath()
    for (cx, a) in [(x + w * 0.17, CGFloat.pi * 0.7), (x + w * 0.83, CGFloat.pi * 0.35)] {
        needles.move(to: CGPoint(x: cx, y: y + h / 2))
        needles.addLine(to: CGPoint(x: cx + r * 0.8 * cos(a), y: y + h / 2 + r * 0.8 * sin(a)))
    }
    stroke(c, red, 4, needles)
    if map { stroke(c, red, 7, arrow(x + w / 2, y + h * 0.21, w * 0.15, h * 0.57)) }
}
func windscreen(_ c: CGContext, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, map: Bool) {
    let p = lines([[x, y, x + w, y, x + w * 0.87, y + h, x + w * 0.13, y + h]]).mutableCopy()!
    p.closeSubpath()
    stroke(c, white, 7, p)
    if map { stroke(c, red, 7, arrow(x + w / 2, y + h * 0.23, w * 0.23, h * 0.46)) }
}
func phone(_ c: CGContext, _ x: CGFloat, _ y: CGFloat) {
    stroke(c, red, 8, rounded(x, y, 80, 160, 16))
}
func slash(_ c: CGContext) { stroke(c, red, 10, lines([[40, 25, 260, 195]])) }

let drawings: [(String, (CGContext) -> Void)] = [
    /* Show on and its choices */
    ("cluster", { c in cluster(c, 20, 40, 260, 140, map: true) }),
    ("hud", { c in windscreen(c, 40, 50, 220, 130, map: true) }),
    ("cluster-hud", { c in
        windscreen(c, 70, 130, 160, 75, map: true)
        cluster(c, 40, 15, 220, 95, map: true)
    }),
    ("off", { c in cluster(c, 20, 40, 260, 140, map: false); slash(c) }),
    /* General */
    ("profile", { c in
        let p = CGMutablePath()
        p.addEllipse(in: CGRect(x: 120, y: 110, width: 60, height: 70))
        p.move(to: CGPoint(x: 80, y: 30)); p.addCurve(to: CGPoint(x: 220, y: 30), control1: CGPoint(x: 85, y: 115), control2: CGPoint(x: 215, y: 115))
        stroke(c, white, 7, p)
        stroke(c, red, 6, rounded(200, 120, 70, 50, 12))
        stroke(c, red, 5, lines([[210, 145, 260, 145]]))
    }),
    ("turn-box", { c in
        stroke(c, white, 7, rounded(80, 40, 140, 140, 18))
        stroke(c, white, 8, lines([[130, 60, 130, 120, 175, 120], [160, 135, 178, 120, 160, 105]]))
        slash(c)
    }),
    ("logs", { c in
        stroke(c, red, 8, rounded(85, 20, 130, 180, 12))
        stroke(c, white, 6, lines([[110, 160, 190, 160], [110, 135, 190, 135], [110, 110, 190, 110]]))
        stroke(c, red, 7, lines([[150, 95, 150, 45], [130, 65, 150, 45, 170, 65]]))
    }),
    /* HUD */
    ("hud-keep", { c in
        windscreen(c, 40, 50, 220, 130, map: true)
        stroke(c, white, 5, rounded(165, 70, 70, 45, 8))
        stroke(c, white, 4, lines([[178, 100, 222, 100], [178, 85, 210, 85]]))
    }),
    ("hud-size", { c in
        windscreen(c, 40, 50, 220, 130, map: false)
        stroke(c, red, 7, pointer(150, 115, 225, 115))
        stroke(c, red, 7, pointer(150, 115, 75, 115))
    }),
    ("hud-move", { c in
        windscreen(c, 40, 50, 220, 130, map: false)
        stroke(c, red, 6, pointer(150, 115, 150, 165))
        stroke(c, red, 6, pointer(150, 115, 150, 65))
        stroke(c, red, 6, pointer(150, 115, 205, 115))
        stroke(c, red, 6, pointer(150, 115, 95, 115))
    }),
    ("hud-centre", { c in
        windscreen(c, 40, 50, 220, 130, map: false)
        let p = CGMutablePath()
        p.addEllipse(in: CGRect(x: 120, y: 85, width: 60, height: 60))
        p.addEllipse(in: CGRect(x: 142, y: 107, width: 16, height: 16))
        stroke(c, red, 6, p)
    }),
    /* CarPlay and Android Auto */
    ("phone-patch", { c in
        phone(c, 40, 30)
        stroke(c, red, 8, rounded(170, 70, 110, 80, 18))
        stroke(c, white, 6, pointer(128, 110, 162, 110))
    }),
    ("phone-unpatch", { c in
        phone(c, 40, 30)
        stroke(c, white, 8, rounded(170, 70, 110, 80, 18))
        stroke(c, white, 6, pointer(128, 110, 162, 110))
        stroke(c, red, 9, lines([[175, 45, 275, 175]]))
    }),
    ("zoom", { c in
        let p = CGMutablePath()
        p.addEllipse(in: CGRect(x: 80, y: 70, width: 110, height: 110))
        stroke(c, white, 8, p)
        stroke(c, white, 10, lines([[175, 80, 225, 30]]))
        stroke(c, red, 7, lines([[105, 125, 165, 125], [135, 95, 135, 155]]))
    }),
    ("phone-card", { c in
        stroke(c, white, 7, rounded(70, 25, 160, 170, 16))
        stroke(c, red, 6, rounded(85, 140, 130, 40, 8))
        stroke(c, red, 7, arrow(150, 50, 30, 60))
        stroke(c, red, 9, lines([[70, 125, 230, 195]]))
    }),
    ("restart", { c in
        let p = CGMutablePath()
        p.addArc(center: CGPoint(x: 150, y: 110), radius: 65, startAngle: .pi * 0.35, endAngle: .pi * 2.15, clockwise: false)
        stroke(c, white, 9, p)
        /* the arrowhead at the circle's open end, along its turn */
        stroke(c, red, 8, pointer(215, 112, 208, 140))
    })
]

try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
for (name, draw) in drawings {
    png(name) { c in
        let free = CGFloat(H) - band
        let centre = CGPoint(x: CGFloat(W) / 2, y: band + free / 2)
        /* the glow, in rings of flat colour (a smooth gradient makes a PNG large) */
        for i in 0..<14 {
            let r = 330 * CGFloat(14 - i) / 14
            c.setFillColor(red.withAlphaComponent(0.032).cgColor)
            c.fillEllipse(in: CGRect(x: centre.x - r, y: centre.y - r, width: 2 * r, height: 2 * r))
        }
        c.setFillColor(NSColor(calibratedWhite: 0.7, alpha: 0.22).cgColor)
        for x in stride(from: 24, to: W, by: 28) {
            for y in stride(from: Int(band) + 14, to: H, by: 28) {
                c.fillEllipse(in: CGRect(x: CGFloat(x) - 1.5, y: CGFloat(y) - 1.5, width: 3, height: 3))
            }
        }
        c.translateBy(x: (CGFloat(W) - 300 * scale) / 2, y: band + (free - 220 * scale) / 2)
        c.scaleBy(x: scale, y: scale)
        draw(c)
    }
}
