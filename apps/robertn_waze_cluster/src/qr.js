// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * A QR code as a PNG the HMI shows: the text at error correction level M
 * (src/qrcodegen.js), black on white with the 4-module quiet zone, each module
 * a whole number of pixels so the picture stays sharp, at most maxPx wide.
 * qrPng(null) is a blank white square of maxPx, for no code.
 */
'use strict';

const zlib = require('zlib');
const qrcodegen = require('./qrcodegen.js');

const QUIET = 4;
const MAX_PX = 360;

const CRC_TABLE = (() => {
    const t = [];
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t.push(c >>> 0);
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

/** { png: Buffer, width, modules } for text (RGBA, deflated). */
function qrPng(text, maxPx) {
    const max = maxPx || MAX_PX;
    const code = text ? qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM) : null;
    const modules = code ? code.size + 2 * QUIET : max;
    const scale = Math.max(1, Math.floor(max / modules));
    const width = modules * scale;
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * width, 255);
    for (let y = 0; y < width; y += 1) {
        raw[y * stride] = 0;
        const my = Math.floor(y / scale) - QUIET;
        for (let mx = 0; code && my >= 0 && my < code.size && mx < code.size; mx += 1) {
            if (code.getModule(mx, my)) {
                const x0 = (mx + QUIET) * scale;
                raw.fill(0, y * stride + 1 + x0 * 4, y * stride + 1 + (x0 + scale) * 4);
                for (let x = x0; x < x0 + scale; x += 1) {
                    raw[y * stride + 1 + x * 4 + 3] = 255;
                }
            }
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(width, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
    return { png, width, modules: code ? code.size : 0 };
}

/* The PNG of an RGBA image (w × h, rows of 4-byte pixels). */
function rgbaPng(rgba, w, h) {
    const stride = w * 4 + 1;
    const raw = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y += 1) {
        rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

/* The page preview's size (src/previews.js) and its text band at the bottom. */
const PREVIEW_W = 957;
const PREVIEW_H = 639;
const PREVIEW_BAND = 220;
const RED = [219, 41, 33];

/**
 * The Logs page's preview picture: the QR code of text on a white card in
 * the middle of the preview's upper part, over the same red glow and grid of
 * dots as the main page's pictures (tools/previews.swift), the bottom band
 * left for the text. A PNG of 957 × 639.
 */
function qrPreviewPng(text) {
    const w = PREVIEW_W, h = PREVIEW_H;
    const free = h - PREVIEW_BAND;
    const cx = w / 2, cy = free / 2;
    const rgba = Buffer.alloc(w * h * 4);
    const put = (x, y, rgb, a) => {
        const i = (y * w + x) * 4;
        const a0 = rgba[i + 3] / 255;
        const out = a + a0 * (1 - a);
        for (let k = 0; k < 3; k += 1) {
            rgba[i + k] = Math.round(out ? (rgb[k] * a + rgba[i + k] * a0 * (1 - a)) / out : 0);
        }
        rgba[i + 3] = Math.round(out * 255);
    };
    /* the glow: 14 rings of flat colour, as tools/previews.swift draws it */
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
            const rings = Math.max(0, Math.min(14, 14 - Math.floor(d / (330 / 14))));
            if (rings) {
                put(x, y, RED, 1 - Math.pow(1 - 0.032, rings));
            }
        }
    }
    /* the dots above the text band */
    for (let dx = 24; dx < w; dx += 28) {
        for (let dy = PREVIEW_BAND + 14; dy < h; dy += 28) {
            const y0 = h - dy;
            for (let y = y0 - 1; y <= y0 + 1; y += 1) {
                for (let x = dx - 1; x <= dx + 1; x += 1) {
                    if (y >= 0 && x < w) {
                        put(x, y, [179, 179, 179], 0.22);
                    }
                }
            }
        }
    }
    /* the code on a white card with rounded corners */
    const code = text ? qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM) : null;
    const modules = code ? code.size + 2 * QUIET : 41;
    const scale = Math.max(1, Math.floor((free - 60) / modules));
    const side = modules * scale;
    const x0 = Math.round(cx - side / 2), y0 = Math.round(cy - side / 2);
    const r = 3 * scale;
    for (let y = 0; y < side; y += 1) {
        for (let x = 0; x < side; x += 1) {
            const qx = Math.min(x, side - 1 - x), qy = Math.min(y, side - 1 - y);
            if (qx < r && qy < r && Math.hypot(r - qx - 0.5, r - qy - 0.5) > r) {
                continue;
            }
            const mx = Math.floor(x / scale) - QUIET, my = Math.floor(y / scale) - QUIET;
            const dark = code && mx >= 0 && my >= 0 && mx < code.size && my < code.size && code.getModule(mx, my);
            put(x0 + x, y0 + y, dark ? [0, 0, 0] : [255, 255, 255], 1);
        }
    }
    return { png: rgbaPng(rgba, w, h), width: w, height: h, modules: code ? code.size : 0 };
}

module.exports = { qrPng, qrPreviewPng };
