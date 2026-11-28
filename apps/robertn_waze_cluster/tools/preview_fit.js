// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * How many lines a preview text takes on the head unit: the preview shows
 * three, and puts whatever is left on the third, cut off mid-letter. The
 * text runs 791 wide in a 42 font (the HMI's ContentPreviewTextW_ID7 and
 * fontSizePreviewTable_ID7), broken at spaces, as the HMI breaks it.
 *
 * Exact with the HMI's own font, BMWTALG.ttf (/mnt/dataro/data/hmi/common/
 * font on the head unit; BMW's, so not in this repository), named by
 * BMW_FONT: the lines match the head unit's word for word. Without it, an
 * estimate from the letters (0.44 em each, an em for Chinese, Japanese and
 * Korean): it agrees with the font on most texts, and errs both ways by a
 * line on a few, so a text near three lines is worth measuring.
 *
 *   BMW_FONT=... node tools/preview_fit.js "text" ...
 */
const fs = require('fs');

const WIDTH = 791;
const SIZE = 42;
const LINES = 3;
const WIDE = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/u;

/* From the TTF only what measuring needs: units per em, the advance widths
 * (hmtx) and the character map (cmap formats 4 and 12). */
function loadFont(file) {
    const b = fs.readFileSync(file);
    const tables = {};
    for (let i = 0, n = b.readUInt16BE(4); i < n; i++) {
        const o = 12 + 16 * i;
        tables[b.toString('latin1', o, o + 4)] = b.readUInt32BE(o + 8);
    }
    const em = b.readUInt16BE(tables.head + 18);
    const wide = b.readUInt16BE(tables.hhea + 34);
    const advance = (g) => b.readUInt16BE(tables.hmtx + 4 * Math.min(g, wide - 1));
    const glyphs = new Map();
    const cmap = tables.cmap;
    for (let i = 0, n = b.readUInt16BE(cmap + 2); i < n; i++) {
        const platform = b.readUInt16BE(cmap + 4 + 8 * i);
        const encoding = b.readUInt16BE(cmap + 6 + 8 * i);
        const o = cmap + b.readUInt32BE(cmap + 8 + 8 * i);
        const format = b.readUInt16BE(o);
        if (format === 4 && (platform === 0 || (platform === 3 && encoding === 1))) {
            const segs = b.readUInt16BE(o + 6) / 2;
            const ends = o + 14, starts = ends + 2 * segs + 2, deltas = starts + 2 * segs, offsets = deltas + 2 * segs;
            for (let s = 0; s < segs; s++) {
                const c0 = b.readUInt16BE(starts + 2 * s), c1 = b.readUInt16BE(ends + 2 * s);
                const d = b.readUInt16BE(deltas + 2 * s), r = b.readUInt16BE(offsets + 2 * s);
                for (let c = c0; c <= c1 && c !== 0xFFFF; c++) {
                    let g = r === 0 ? (c + d) & 0xFFFF : b.readUInt16BE(offsets + 2 * s + r + 2 * (c - c0));
                    g = r !== 0 && g ? (g + d) & 0xFFFF : g;
                    if (g && !glyphs.has(c)) {
                        glyphs.set(c, g);
                    }
                }
            }
        } else if (format === 12 && (platform === 0 || platform === 3)) {
            for (let k = 0, n2 = b.readUInt32BE(o + 12); k < n2; k++) {
                const c0 = b.readUInt32BE(o + 16 + 12 * k), c1 = b.readUInt32BE(o + 20 + 12 * k), g0 = b.readUInt32BE(o + 24 + 12 * k);
                for (let c = c0; c <= c1; c++) {
                    if (!glyphs.has(c)) {
                        glyphs.set(c, g0 + c - c0);
                    }
                }
            }
        }
    }
    /* A text's width in the display's units; a letter the font lacks (the HMI
     * draws it in another font) counts an em. */
    return (text) => [...text].reduce((w, ch) => {
        const g = glyphs.get(ch.codePointAt(0));
        return w + (g ? advance(g) * SIZE / em : SIZE);
    }, 0);
}

/* A width estimate without the font: an em for a wide letter, 0.44 em for the rest. */
const estimate = (text) => [...text].reduce((w, ch) => w + (WIDE.test(ch) ? SIZE : SIZE * 0.44), 0);

/* The text's lines: broken at spaces, or, in text without them, where the
 * line is full. */
function lines(text, measure = estimate) {
    const out = [];
    const byLetter = WIDE.test(text) || !/\s/.test(text);
    const words = byLetter ? [...text] : text.split(' ');
    const join = byLetter ? '' : ' ';
    let line = '';
    words.forEach((word) => {
        const next = line ? `${line}${join}${word}` : word;
        if (!line || measure(next) <= WIDTH) {
            line = next;
        } else {
            out.push(line);
            line = word;
        }
    });
    if (line) {
        out.push(line);
    }
    return out;
}

/* The measure to use: the HMI's font when BMW_FONT names it, the estimate otherwise. */
function measure() {
    return process.env.BMW_FONT ? loadFont(process.env.BMW_FONT) : estimate;
}

module.exports = { WIDTH, SIZE, LINES, loadFont, estimate, lines, measure };

if (require.main === module) {
    const m = measure();
    process.argv.slice(2).forEach((text) => {
        const l = lines(text, m);
        console.log(`${l.length} line${l.length === 1 ? '' : 's'}${process.env.BMW_FONT ? '' : ' (estimated)'}`);
        l.forEach((line) => console.log(`   |${line}|`));
    });
}
