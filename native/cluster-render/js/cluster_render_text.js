/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Text for cluster-render layers (PROTOCOL.md "Text"), with no service
 * change: a Font is a one-row R8 atlas of its glyphs, each a whole line
 * high, sent once as an asset; a Text is an effect layer drawing a string
 * from it, laid out here (advances, kerning, alignment) and sent as a
 * uniform array of glyph boxes and their count. Changing the string sends
 * those two uniforms alone, under 700 bytes; the atlas is never sent again.
 *
 *   const { Font, Text } = require('./cluster_render_text.js');
 *   const font = Font.fromGrid({ pixels, w: 160, h: 64, cols: 10, rows: 2, chars: '0123456789ABCDEFGHIJ' });
 *   const atlas = font.asset(cr, 'panel');
 *   const speed = new Text(cr, font, atlas, { target: 'panel', x: 100, y: 100, w: 300, h: 64,
 *       color: [1, 1, 1, 1], align: 'right' });
 *   speed.set('123');
 *
 * Node 8. */
'use strict';

/* The fragment shader of a Text of at most n glyphs: GLSL ES 1.00, a loop
 * of constant bound over a uniform array (constant-index expressions), each
 * glyph box (x0, x1 in the layer's width, u0, u1 in the atlas's) tested,
 * the brightest sample of those covering the pixel drawn (boxes overlap
 * where kerning or a bearing pulls glyphs together). Premultiplied out;
 * n + 2 uniform vectors. */
function textFragmentShader(n) {
    return '#version 100\n' +
        'precision mediump float;\n' +
        'uniform sampler2D u_atlas;\n' +
        'uniform vec4 u_glyphs[' + n + '];\n' +
        'uniform float u_count;\n' +
        'uniform vec4 u_color;\n' +
        'varying vec2 v_uv;\n' +
        'void main() {\n' +
        '    float a = 0.0;\n' +
        '    for (int i = 0; i < ' + n + '; i++) {\n' +
        '        if (float(i) >= u_count) break;\n' +
        '        vec4 g = u_glyphs[i];\n' +
        '        if (v_uv.x >= g.x && v_uv.x < g.y) {\n' +
        '            float t = (v_uv.x - g.x) / (g.y - g.x);\n' +
        '            a = max(a, texture2D(u_atlas, vec2(mix(g.z, g.w, t), v_uv.y)).r);\n' +
        '        }\n' +
        '    }\n' +
        '    gl_FragColor = vec4(u_color.rgb * u_color.a, u_color.a) * a;\n' +
        '}\n';
}

const MAX_ATLAS = 2048;
/* The most glyphs a Text holds: its shader's 16 uniform vectors, the least
 * GLSL ES 1.00 gives a fragment shader. */
const MAX_GLYPHS = 14;

class Font {
    /* glyphs: [{ code, w, advance, left, pixels }]: each glyph's bitmap w x
     * lineHeight R8 (top row the line's top), its advance and left bearing
     * in pixels; kerning: Map of 'first,second' code pairs to pixels. Throws
     * when the atlas would pass 2048 pixels wide. */
    constructor(lineHeight, glyphs, kerning) {
        if (!(lineHeight >= 1 && lineHeight <= MAX_ATLAS)) throw new Error('lineHeight is 1 to 2048');
        this.lineHeight = lineHeight;
        this.kerning = kerning || new Map();
        this.glyphs = new Map();
        let x = 1;   /* a column of 0 between glyphs: nothing bleeds when sampled bilinear */
        glyphs.forEach((g) => { x += g.w + 1; });
        if (x > MAX_ATLAS) throw new Error('the glyphs make an atlas ' + x + ' pixels wide, past ' + MAX_ATLAS);
        this.w = x;
        this.pixels = Buffer.alloc(this.w * lineHeight);
        x = 1;
        glyphs.forEach((g) => {
            for (let y = 0; y < lineHeight; y++)
                g.pixels.copy(this.pixels, y * this.w + x, y * g.w, y * g.w + g.w);
            this.glyphs.set(g.code, { x: x, w: g.w, advance: g.advance, left: g.left || 0 });
            x += g.w + 1;
        });
    }

    /* Glyphs of bitmaps (each w x h R8, top: its first row's distance below
     * the line's top) in a line lineHeight high; an advance absent or
     * negative: the glyph's width. */
    static fromGlyphs(lineHeight, glyphs, kerning) {
        return new Font(lineHeight, glyphs.map((g) => {
            const px = Buffer.alloc(g.w * lineHeight);
            for (let y = 0; y < g.h; y++) {
                const row = (g.top || 0) + y;
                if (row >= 0 && row < lineHeight) g.pixels.copy(px, row * g.w, y * g.w, y * g.w + g.w);
            }
            const code = typeof g.char === 'string' ? g.char.codePointAt(0) : g.code;
            return { code: code, w: g.w, advance: g.advance === undefined || g.advance < 0 ? g.w : g.advance, left: g.left || 0,
                pixels: px };
        }), kerning);
    }

    /* A monospace grid: pixels (w x h R8, or RGBA with bpp 4: its alpha)
     * of cols x rows cells, chars the characters cell by cell; advance: the
     * cells' (their width by default). */
    static fromGrid(o) {
        const bpp = o.bpp || 1, cw = Math.floor(o.w / o.cols), ch = Math.floor(o.h / o.rows);
        const chars = Array.from(o.chars);
        if (chars.length > o.cols * o.rows) throw new Error('more chars than cells');
        return new Font(ch, chars.map((c, i) => {
            const cx = (i % o.cols) * cw, cy = Math.floor(i / o.cols) * ch, px = Buffer.alloc(cw * ch);
            for (let y = 0; y < ch; y++)
                for (let x = 0; x < cw; x++)
                    px[y * cw + x] = o.pixels[((cy + y) * o.w + cx + x) * bpp + bpp - 1];
            return { code: c.codePointAt(0), w: cw, advance: o.advance || cw, left: 0, pixels: px };
        }));
    }

    /* An AngelCode BMFont (its text .fnt) and its page's pixels (page.w x
     * page.h, R8, or RGBA with bpp 4: its alpha). Throws for a font of
     * several pages, of glyphs packed in channels, of a glyph outside the
     * page or of a negative xadvance. */
    static fromBMFont(fnt, page) {
        const bpp = page.bpp || 1;
        const field = (line, k) => { const m = new RegExp('\\b' + k + '=(-?\\d+)').exec(line); return m ? Number(m[1]) : 0; };
        let lineHeight = 0;
        const glyphs = [], kerning = new Map();
        fnt.split(/\r?\n/).forEach((line) => {
            if (/^common\b/.test(line)) {
                lineHeight = field(line, 'lineHeight');
                if (field(line, 'pages') > 1 || field(line, 'packed')) throw new Error('a BMFont of one page, unpacked');
            } else if (/^char\b/.test(line)) {
                const g = { code: field(line, 'id'), x: field(line, 'x'), y: field(line, 'y'), w: field(line, 'width'),
                    h: field(line, 'height'), left: field(line, 'xoffset'), top: field(line, 'yoffset'),
                    advance: field(line, 'xadvance') };
                const chnl = field(line, 'chnl');
                if (field(line, 'page') || (chnl && chnl !== 15)) throw new Error('a BMFont of one page, unpacked');
                if (g.x < 0 || g.y < 0 || g.w < 0 || g.h < 0 || g.x + g.w > page.w || g.y + g.h > page.h)
                    throw new Error('glyph ' + g.code + ' outside the page');
                if (g.advance < 0) throw new Error('glyph ' + g.code + ': a negative xadvance');
                const px = Buffer.alloc(g.w * g.h);
                for (let y = 0; y < g.h; y++)
                    for (let x = 0; x < g.w; x++)
                        px[y * g.w + x] = page.pixels[((g.y + y) * page.w + g.x + x) * bpp + bpp - 1];
                g.pixels = px;
                glyphs.push(g);
            } else if (/^kerning\b/.test(line)) {
                kerning.set(field(line, 'first') + ',' + field(line, 'second'), field(line, 'amount'));
            }
        });
        return Font.fromGlyphs(lineHeight, glyphs, kerning);
    }

    /* The atlas as an r8 asset on target, sampled bilinear; its ref. */
    asset(cr, target) {
        const ref = cr.asset({ target: target, format: 'r8', w: this.w, h: this.lineHeight, sampling: 'bilinear' });
        if (ref) cr.pixels(ref, null, this.pixels);
        return ref;
    }

    /* text laid out a line h pixels high, spacing pixels between
     * characters: { boxes: [{ x0, x1, u0, u1 }] in pixels of the line and
     * the atlas, width: from the first character's start to the last one's
     * advance }. A character the font lacks takes a space's advance, or
     * nothing. */
    layout(text, h, spacing) {
        const s = h / this.lineHeight, boxes = [];
        let x = 0, prev = -1;
        Array.from(text).forEach((c) => {
            const code = c.codePointAt(0), g = this.glyphs.get(code);
            if (prev >= 0) x += (this.kerning.get(prev + ',' + code) || 0) * s + (spacing || 0);
            if (g) {
                if (g.w) boxes.push({ x0: x + g.left * s, x1: x + (g.left + g.w) * s, u0: g.x, u1: g.x + g.w });
                x += g.advance * s;
            } else {
                const space = this.glyphs.get(32);
                x += space ? space.advance * s : 0;
            }
            prev = code;
        });
        return { boxes: boxes, width: x };
    }
}

class Text {
    /* An effect layer drawing strings from font (whose atlas is the asset
     * atlas) over its rect, a line as high as the rect: opts the layer's
     * (target, x, y, w, h, klass, z, canvas, ...), color [r, g, b, a] (0-1,
     * white by default), align 'left' (default), 'center' or 'right',
     * spacing (pixels between characters), maxGlyphs (the glyphs its shader
     * holds: 1 to MAX_GLYPHS, the default). ref 0, nothing sent, when w or
     * h is not a number above 0 or maxGlyphs is out of range. */
    constructor(cr, font, atlas, opts) {
        this.cr = cr;
        this.font = font;
        this.opts = Object.assign({ align: 'left', spacing: 0, maxGlyphs: MAX_GLYPHS, color: [1, 1, 1, 1] }, opts);
        this.max = this.opts.maxGlyphs;
        this.ref = 0;
        if (!(this.opts.w > 0 && this.opts.h > 0 && isFinite(this.opts.w) && isFinite(this.opts.h)) ||
            !(Number.isInteger(this.max) && this.max >= 1 && this.max <= MAX_GLYPHS)) return;
        const lo = Object.assign({}, opts);
        ['color', 'align', 'spacing', 'maxGlyphs'].forEach((k) => delete lo[k]);
        this.ref = cr.effect(Object.assign(lo, { fs: textFragmentShader(this.max), blend: 'premultiplied' }));
        if (!this.ref) return;
        cr.bind(this.ref, 'u_atlas', atlas);
        this.color(this.opts.color);
        this.set('');
    }

    /* The string shown, sent as two uniforms (u_glyphs, u_count), the
     * boxes to 6 significant digits as the C++ client sends them; false
     * when it has more glyphs than the layer holds or is wider than its
     * rect (it is shown cut). */
    set(text) {
        if (!this.ref) return false;
        const w = this.opts.w, l = this.font.layout(String(text), this.opts.h, this.opts.spacing);
        const shift = this.opts.align === 'right' ? w - l.width : this.opts.align === 'center' ? (w - l.width) / 2 : 0;
        const v = new Array(this.max * 4).fill(0);
        const boxes = l.boxes.slice(0, this.max);
        const six = (x) => Number(x.toPrecision(6));
        boxes.forEach((b, i) => {
            v[i * 4] = six((b.x0 + shift) / w);
            v[i * 4 + 1] = six((b.x1 + shift) / w);
            v[i * 4 + 2] = six(b.u0 / this.font.w);
            v[i * 4 + 3] = six(b.u1 / this.font.w);
        });
        this.cr.uniform(this.ref, 'u_glyphs', v, { type: 'vec4' });
        this.cr.uniform(this.ref, 'u_count', [boxes.length]);
        return l.boxes.length <= this.max && l.width <= w;
    }

    color(rgba) {
        if (this.ref) this.cr.uniform(this.ref, 'u_color', [].concat(rgba));
    }

    drop() {
        if (this.ref) this.cr.drop(this.ref);
        this.ref = 0;
    }
}

module.exports = { Font, Text, textFragmentShader, MAX_GLYPHS };
