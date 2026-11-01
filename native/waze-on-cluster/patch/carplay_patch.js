#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* carplay_patch.js — four reversible edits to the CarPlay binary that,
 * together, put the CarPlay instrument-cluster ("alternate screen") H.264 where
 * this tool can read it, at the size this tool displays (PATCH.md).
 *
 *   variant  one 4-byte jump-table slot. The converter maps raw
 *            KI_KOMBI_VARIANT 9->IC_HIGH, 10->IC_MID, everything else incl. 7
 *            ->OTHER (which fails the alternate-display gate). Remapping the
 *            variant-7 slot to a supported value makes every downstream check
 *            pass, so MGU advertises the 2nd display and the phone sends the
 *            cluster stream. Touches variant 7 only.
 *   sink     the 2nd-stream Cinemo sink URL string. As shipped it is
 *            `avb://media_transport.avb_streaming.15?mime_type=video/H264`,
 *            sending the H.264 undecoded over AVB to the cluster. Repointing it
 *            (--sink <url>, or --capture <fifo> for the file:// form) sends the
 *            same undecoded H.264 to this tool: a `udp://127.0.0.1:<port>`
 *            stream sink, or a `file://<fifo>`. Same length or shorter,
 *            NUL-padded in place.
 *   selfstart one `call` retargeted (4-byte rel32). CarPlay's AlternateDisplays
 *            waits for NavController to forward a requestStream command before it
 *            shows the cluster UI, but NavController never forwards it on this
 *            build, so the stream never starts. Retargeting onSuggestUi's
 *            setStreamStatus(AVAILABLE) call to requestStream() makes CarPlay
 *            start the stream itself. Applied in every mode.
 *   resolution the IC_HIGH display geometry `ICSafeAreaProvider` advertises to
 *            the phone: pixel size, physical size (mm), and the view/safe
 *            areas, held as four `movabs` immediates in one builder function.
 *            Stock advertises a 1920x900 cluster display; this tool shows the
 *            map in the cluster's central map area, so `apply --panel high`
 *            rewrites the geometry to the displayed size (1088x480 px at
 *            138x61 mm, view area the full frame) and the phone renders its
 *            cluster map at that size. The safe area, where the phone keeps
 *            its guidance UI, is the part of the frame the gauges and
 *            native readouts leave visible (504x368 at 286,72). `--res WxH`
 *            picks another pixel size at the same physical size, `--safe`
 *            another safe area; `--res stock`, and `--panel mid`, keep the
 *            stock geometry.
 *
 * Node 8.16.2 on the unit, no dependencies. All four edits are reversible from a
 * verified full backup of the original binary; the original build is pinned by
 * SHA-256 and each modified region is validated by its anchor bytes, so the
 * script refuses an unrecognised build.
 *
 *   carplay_patch.js status [--target <file>]
 *   carplay_patch.js apply  --panel high|mid [--sink <url> | --capture <fifo>] [--res WxH|stock] [--safe WxH+X+Y|full] [--target <file>] [--yes]
 *   carplay_patch.js revert [--target <file>] [--yes] [--drop-backup]
 *   carplay_patch.js verify [--target <file>]
 *
 * Default target /usr/bin/carplay. This edits the file by atomic rename, not
 * the running process, which keeps the old binary until carplay next starts.
 */
'use strict';

var fs = require('fs');
var crypto = require('crypto');
var path = require('path');

/* The build this patch was proven against: carplay 22.28.3 as shipped. */
var BUILD_22_28_3 = {
    version: 'carplay 22.28.3+gitr624+993efc1-r0.14',
    size: 3484912,
    sha256_original: 'ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50',

    /* variant: the converter jump table (12 signed int32 offsets from its
     * own base). Index 7 is KI_KOMBI_VARIANT 7; the IC_HIGH/IC_MID targets
     * are the live values of indices 9 and 10. */
    table_offset: 0x2ba4d4,
    table_original: [
        0xfff7f2fc, 0xfff7f2ec, 0xfff7f2ec, 0xfff7f2ec, 0xfff7f2ec, 0xfff7f2ec,
        0xfff7f2ec, 0xfff7f2ec, 0xfff7f2ec, 0xfff7f2bc, 0xfff7f30c, 0xfff7f2ec,
    ],
    slot_index: 7,
    slot_offset: 0x2ba4f0,
    variant_original: 0xfff7f2ec, /* -> OTHER handler 0x2397c0 */
    variant_high: 0xfff7f2bc,     /* index 9 value -> IC_HIGH handler 0x239790 */
    variant_mid: 0xfff7f30c,      /* index 10 value -> IC_MID handler 0x2397e0 */

    /* sink: the 2nd-stream URL string and its NUL-terminated slot. The slot
     * runs to the next string; anchors on both sides pin the offset. */
    sink_offset: 0x2a20b0,
    sink_original: 'avb://media_transport.avb_streaming.15?mime_type=video/H264',
    sink_slot_len: 59,            /* bytes available before the trailing NULs */
    sink_anchor_before: '72726f7228292e00', /* "rror()." + NUL, just before the string */
    sink_anchor_after: 'mCarPlay->GetDisplaySource(', /* the next string, after the NUL run */
    sink_anchor_after_gap: 5,     /* NUL bytes between the slot and the next string */

    /* selfstart: one 5-byte `call` instruction retargeted. In
     * AlternateDisplays::onSuggestUi() (0x1816f0), once the alternate display is
     * available and not already streaming, the call at 0x18176c invokes
     * setStreamStatus(this, AVAILABLE) — which only tells NavController, and
     * NavController never forwards the requestStream it would take to start the
     * phone's cluster stream (unimplemented on this build; see PATCH.md Edit 3).
     * Retargeting that call to requestStream() (0x181810) makes CarPlay start
     * the stream itself at the same moment, with `this` (rdi=rbp) already loaded.
     * requestStream() reads only CarPlayConstantsRepository's URL/UUID and its
     * own stream-status field, re-sends STREAMING to NavController from its tail,
     * and guards on already-streaming, so it is a one-shot per session. The
     * opcode byte (e8) is unchanged; only the 4-byte rel32 differs. */
    selfstart_offset: 0x18176c,   /* the `call` instruction (e8 + rel32) */
    selfstart_original: 'e8effdffff', /* call setStreamStatus 0x181560 */
    selfstart_patched: 'e89f000000',  /* call requestStream   0x181810 */
    selfstart_anchor_before: '4883c01048890424', /* add rax,0x10 ; mov [rsp],rax (0x181764) */
    selfstart_anchor_after: '488b442418',         /* mov rax,[rsp+0x18], the epilogue (0x181771) */

    /* resolution: the IC_HIGH geometry builder (0x20ca30) stores four movabs
     * immediates into the ICSafeAreaProvider object:
     *   +0x10 (mm pair)     from the movabs at res_mm_offset
     *   +0x08 and +0x18     from the movabs at res_px_offset (pixel pair; the
     *                       +0x18 copy is the view area's size)
     *   +0x20               view-area x/y offsets (u16s) + safe-area width
     *   +0x28               safe-area height + safe-area x/y offsets (u16s)
     * Each movabs is `48 b8|ba <8 immediate bytes>`; only the immediates
     * change. The anchor after each movabs pins the offset. The IC_MID
     * builder (0x20caa0) is left stock, so --panel mid is the unmodified
     * geometry. Stock IC_HIGH advertises 1920x900 px at 234x110 mm with a
     * 612x526 safe area at (514,192). The map this tool displays occupies
     * the cluster's 1088x480 central map area (138x61 mm of glass), and the
     * render's texture is that area pixel for pixel, so the patched geometry
     * advertises exactly that: 1088x480 px at 138x61 mm, view area the full
     * frame at (0,0). The phone draws its map across the whole view area and
     * keeps its guidance UI inside the safe area, so the safe area is the
     * frame's visible middle (PATCH.md, Edit 4). */
    res_mm_offset: 0x20ca30,      /* movabs rdx, imm64 -> object +0x10 */
    res_mm_opcode: '48ba',
    res_mm_anchor_after: '4883ec18',  /* sub rsp,0x18 (0x20ca3a) */
    res_px_offset: 0x20ca52,      /* movabs rax, imm64 -> object +0x08/+0x18 */
    res_px_opcode: '48b8',
    res_px_anchor_after: '48894708',  /* mov [rdi+0x08],rax (0x20ca5c) */
    res_safe1_offset: 0x20ca64,   /* movabs rax, imm64 -> object +0x20 */
    res_safe1_opcode: '48b8',
    res_safe1_anchor_after: '48894720', /* mov [rdi+0x20],rax (0x20ca6e) */
    res_safe2_offset: 0x20ca72,   /* movabs rax, imm64 -> object +0x28 */
    res_safe2_opcode: '48b8',
    res_safe2_anchor_after: '48894728', /* mov [rdi+0x28],rax (0x20ca7c) */
    res_stock: { w: 1920, h: 900, mmw: 234, mmh: 110, safew: 612, safeh: 526, safex: 514, safey: 192 },
    res_default: { w: 1088, h: 480, mmw: 138, mmh: 61 },
    /* The default safe area in the 1088x480 frame: x from BMW's own IC_MID
     * safe area (the stock rect for the 1920x720 cluster, which lies inside
     * the map area), y from below the native model badge to inside the
     * gauge mask's lower edge. Other --res sizes scale it. */
    safe_default: { x: 286, y: 72, w: 504, h: 368 },
};

/* carplay 21.37.3 (MGU firmware K18_21w45.4-1-3, e.g. a 2021 G30). The same
 * code at other offsets: every region carries the 22.28.3 build's anchor
 * bytes and stock values (the converter's jump table with the same relative
 * entries, the same sink string between the same neighbours, onSuggestUi's
 * setStreamStatus call with the same rel32 to requestStream, the IC_HIGH
 * builder's four movabs with the stock 1920x900 / 234x110 geometry). */
var BUILD_21_37_3 = Object.assign({}, BUILD_22_28_3, {
    version: 'carplay 21.37.3+gitrAUTOINC+fd6caa8777-r0',
    size: 3448056,
    sha256_original: 'dac7f1a63df6ea6dbffd9f5e8a10c6d8805489e362806608441d566876038aa2',
    table_offset: 0x2b9614,
    table_original: [
        0xfff8120c, 0xfff811fc, 0xfff811fc, 0xfff811fc, 0xfff811fc, 0xfff811fc,
        0xfff811fc, 0xfff811fc, 0xfff811fc, 0xfff811cc, 0xfff8121c, 0xfff811fc,
    ],
    slot_offset: 0x2b9630,
    variant_original: 0xfff811fc, /* -> OTHER handler 0x23a810 */
    variant_high: 0xfff811cc,     /* -> IC_HIGH handler 0x23a7e0 */
    variant_mid: 0xfff8121c,      /* -> IC_MID handler 0x23a830 */
    sink_offset: 0x29c150,
    selfstart_offset: 0x18033c,   /* onSuggestUi 0x1802c0; setStreamStatus 0x180130, requestStream 0x1803e0 */
    res_mm_offset: 0x20b4c0,
    res_px_offset: 0x20b4e2,
    res_safe1_offset: 0x20b4f4,
    res_safe2_offset: 0x20b502
});

/* The builds this patch knows, told apart by size; the first is the one an
 * unrecognised binary is reported against. */
var BUILDS = [BUILD_22_28_3, BUILD_21_37_3];
var KNOWN = BUILDS[0];

/* The byte ranges the four edits write: apply changes only these, and revert
 * restores only these, so changes another tool made elsewhere stay. */
function regionsOf(k) {
    return [[k.slot_offset, 4], [k.sink_offset, k.sink_slot_len], [k.selfstart_offset, 5],
        [k.res_mm_offset + 2, 8], [k.res_px_offset + 2, 8], [k.res_safe1_offset + 2, 8], [k.res_safe2_offset + 2, 8]];
}
var REGIONS = regionsOf(KNOWN);

/* Picks the known build the target's size names (every edit keeps the size). */
function selectBuild(target) {
    var size = -1;
    try { size = fs.statSync(target).size; } catch (e) {}
    for (var i = 0; i < BUILDS.length; i++) {
        if (BUILDS[i].size === size) { KNOWN = BUILDS[i]; break; }
    }
    REGIONS = regionsOf(KNOWN);
}

function u32le(buf, off) { return buf.readUInt32LE(off) >>> 0; }
function u16le(buf, off) { return buf.readUInt16LE(off); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function die(msg) { process.stderr.write('error: ' + msg + '\n'); process.exit(1); }

function backupPath(t) { return t + '.woc-orig'; }
function metaPath(t) { return t + '.woc-orig.json'; }

/* The variant state of a buffer, independent of the sink. */
function variantState(buf) {
    for (var i = 0; i < KNOWN.table_original.length; i++) {
        if (i === KNOWN.slot_index) continue;
        if (u32le(buf, KNOWN.table_offset + i * 4) !== KNOWN.table_original[i]) {
            return { state: 'unknown', reason: 'converter table[' + i + '] does not match the known build' };
        }
    }
    var v = u32le(buf, KNOWN.slot_offset);
    if (v === KNOWN.variant_original) return { state: 'original' };
    if (v === KNOWN.variant_high) return { state: 'patched', panel: 'high' };
    if (v === KNOWN.variant_mid) return { state: 'patched', panel: 'mid' };
    return { state: 'unknown', reason: 'converter slot 7 = 0x' + v.toString(16) + ' is neither original nor a known panel' };
}

/* The sink state of a buffer. The anchors pin the offset; the content tells
 * original from redirected. */
function sinkState(buf) {
    var before = buf.slice(KNOWN.sink_offset - 8, KNOWN.sink_offset).toString('hex');
    if (before !== KNOWN.sink_anchor_before) return { state: 'unknown', reason: 'sink preceding anchor does not match the known build' };
    var slot = buf.slice(KNOWN.sink_offset, KNOWN.sink_offset + KNOWN.sink_slot_len);
    var afterOff = KNOWN.sink_offset + KNOWN.sink_slot_len + KNOWN.sink_anchor_after_gap;
    var after = buf.slice(afterOff, afterOff + KNOWN.sink_anchor_after.length).toString('latin1');
    if (after !== KNOWN.sink_anchor_after) return { state: 'unknown', reason: 'sink following anchor does not match the known build' };
    var nul = slot.indexOf(0);
    var url = (nul >= 0 ? slot.slice(0, nul) : slot).toString('latin1');
    if (url === KNOWN.sink_original) return { state: 'original' };
    /* A redirect points the 2nd stream at this tool: file:// (a FIFO) or a
     * stream scheme (udp:///tcp://, which the bridge's RTP muxer accepts where a
     * seekable file:// is rejected — see README). */
    if (/^(file|udp|tcp):\/\//.test(url)) return { state: 'redirected', url: url };
    return { state: 'unknown', reason: 'sink URL "' + url + '" is neither original nor a known redirect' };
}

/* The self-start state of a buffer. The anchors on both sides pin the call
 * site; the 5 call bytes tell stock (waits for NavController) from retargeted
 * (starts the stream itself). */
function selfstartState(buf) {
    var before = buf.slice(KNOWN.selfstart_offset - 8, KNOWN.selfstart_offset).toString('hex');
    if (before !== KNOWN.selfstart_anchor_before) return { state: 'unknown', reason: 'self-start preceding anchor does not match the known build' };
    var afterOff = KNOWN.selfstart_offset + 5;
    var after = buf.slice(afterOff, afterOff + KNOWN.selfstart_anchor_after.length / 2).toString('hex');
    if (after !== KNOWN.selfstart_anchor_after) return { state: 'unknown', reason: 'self-start following anchor does not match the known build' };
    var call = buf.slice(KNOWN.selfstart_offset, KNOWN.selfstart_offset + 5).toString('hex');
    if (call === KNOWN.selfstart_original) return { state: 'original' };
    if (call === KNOWN.selfstart_patched) return { state: 'patched' };
    return { state: 'unknown', reason: 'self-start call = 0x' + call + ' is neither stock nor the requestStream retarget' };
}

/* The resolution state of a buffer: the IC_HIGH geometry in the four movabs
 * immediates. The opcode and the store after each movabs pin the offsets;
 * the immediates tell stock geometry from this tool's geometry (view area the
 * frame at (0,0), a non-empty safe area inside the frame). Anything else is
 * unrecognised. */
function resState(buf) {
    var fields = [
        ['mm', KNOWN.res_mm_offset, KNOWN.res_mm_opcode, KNOWN.res_mm_anchor_after],
        ['px', KNOWN.res_px_offset, KNOWN.res_px_opcode, KNOWN.res_px_anchor_after],
        ['safe1', KNOWN.res_safe1_offset, KNOWN.res_safe1_opcode, KNOWN.res_safe1_anchor_after],
        ['safe2', KNOWN.res_safe2_offset, KNOWN.res_safe2_opcode, KNOWN.res_safe2_anchor_after],
    ];
    for (var i = 0; i < fields.length; i++) {
        var off = fields[i][1];
        if (buf.slice(off, off + 2).toString('hex') !== fields[i][2])
            return { state: 'unknown', reason: 'resolution ' + fields[i][0] + ' opcode does not match the known build' };
        if (buf.slice(off + 10, off + 14).toString('hex') !== fields[i][3])
            return { state: 'unknown', reason: 'resolution ' + fields[i][0] + ' anchor does not match the known build' };
    }
    var g = {
        mmw: u32le(buf, KNOWN.res_mm_offset + 2), mmh: u32le(buf, KNOWN.res_mm_offset + 6),
        w: u32le(buf, KNOWN.res_px_offset + 2), h: u32le(buf, KNOWN.res_px_offset + 6),
        viewx: u16le(buf, KNOWN.res_safe1_offset + 2), viewy: u16le(buf, KNOWN.res_safe1_offset + 4),
        safew: u32le(buf, KNOWN.res_safe1_offset + 6),
        safeh: u32le(buf, KNOWN.res_safe2_offset + 2),
        safex: u16le(buf, KNOWN.res_safe2_offset + 6), safey: u16le(buf, KNOWN.res_safe2_offset + 8),
    };
    var s = KNOWN.res_stock;
    if (g.w === s.w && g.h === s.h && g.mmw === s.mmw && g.mmh === s.mmh &&
        g.viewx === 0 && g.viewy === 0 && g.safew === s.safew && g.safeh === s.safeh &&
        g.safex === s.safex && g.safey === s.safey)
        return { state: 'original', res: g };
    if (g.viewx === 0 && g.viewy === 0 && g.safew > 0 && g.safeh > 0 &&
        g.safex + g.safew <= g.w && g.safey + g.safeh <= g.h)
        return { state: 'patched', res: g };
    return { state: 'unknown', reason: 'resolution geometry ' + g.w + 'x' + g.h + ' view offset ' + g.viewx + ',' + g.viewy + ' safe ' + g.safew + 'x' + g.safeh + ' at ' + g.safex + ',' + g.safey + ' is neither stock nor a patch with its safe area inside the frame' };
}

/* Write one geometry into the four immediates. g carries the pixel size, the
 * physical size, and the safe-area rect; the view area is the full frame. */
function writeRes(buf, g) {
    buf.writeUInt32LE(g.mmw >>> 0, KNOWN.res_mm_offset + 2);
    buf.writeUInt32LE(g.mmh >>> 0, KNOWN.res_mm_offset + 6);
    buf.writeUInt32LE(g.w >>> 0, KNOWN.res_px_offset + 2);
    buf.writeUInt32LE(g.h >>> 0, KNOWN.res_px_offset + 6);
    buf.writeUInt16LE(0, KNOWN.res_safe1_offset + 2);
    buf.writeUInt16LE(0, KNOWN.res_safe1_offset + 4);
    buf.writeUInt32LE(g.safew >>> 0, KNOWN.res_safe1_offset + 6);
    buf.writeUInt32LE(g.safeh >>> 0, KNOWN.res_safe2_offset + 2);
    buf.writeUInt16LE(g.safex, KNOWN.res_safe2_offset + 6);
    buf.writeUInt16LE(g.safey, KNOWN.res_safe2_offset + 8);
}

function safeText(g) { return 'safe ' + g.safew + 'x' + g.safeh + ' at ' + g.safex + ',' + g.safey; }

function classify(buf) {
    if (buf.length !== KNOWN.size) return { ok: false, reason: 'size ' + buf.length + ' != ' + KNOWN.size + ' (unrecognised build)' };
    return { ok: true, variant: variantState(buf), sink: sinkState(buf), selfstart: selfstartState(buf), res: resState(buf) };
}

function readTarget(t) {
    try { return fs.readFileSync(t); } catch (e) { die('cannot read ' + t + ': ' + e.message); }
}

function cmdStatus(target) {
    var buf = readTarget(target);
    var hash = sha256(buf);
    var c = classify(buf);
    process.stdout.write('target:   ' + target + '\n');
    process.stdout.write('size:     ' + buf.length + '\n');
    process.stdout.write('sha256:   ' + hash + '\n');
    if (!c.ok) { process.stdout.write('known:    NO — ' + c.reason + '\n'); return; }
    var known = (hash === KNOWN.sha256_original) ? 'yes, pristine ' + KNOWN.version
        : (c.variant.state !== 'unknown' && c.sink.state !== 'unknown' && c.selfstart.state !== 'unknown' && c.res.state !== 'unknown') ? 'yes, modified build' : 'NO — unrecognised';
    process.stdout.write('known:    ' + known + '\n');
    process.stdout.write('variant:  ' + (c.variant.state === 'original' ? 'ORIGINAL (2nd display gated off for variant 7)'
        : c.variant.state === 'patched' ? 'PATCHED -> IC_' + c.variant.panel.toUpperCase()
        : 'UNKNOWN (' + c.variant.reason + ')') + '\n');
    process.stdout.write('sink:     ' + (c.sink.state === 'original' ? 'ORIGINAL (2nd stream -> AVB stream 15)'
        : c.sink.state === 'redirected' ? 'REDIRECTED -> ' + c.sink.url
        : 'UNKNOWN (' + c.sink.reason + ')') + '\n');
    process.stdout.write('selfstart:' + (c.selfstart.state === 'original' ? ' ORIGINAL (waits for NavController; stream never starts)'
        : c.selfstart.state === 'patched' ? ' SELF-START (CarPlay starts the cluster stream itself)'
        : ' UNKNOWN (' + c.selfstart.reason + ')') + '\n');
    process.stdout.write('res:      ' + (c.res.state === 'original' ? 'ORIGINAL (IC_HIGH advertises ' + KNOWN.res_stock.w + 'x' + KNOWN.res_stock.h + ')'
        : c.res.state === 'patched' ? 'PATCHED (IC_HIGH advertises ' + c.res.res.w + 'x' + c.res.res.h + ' at ' + c.res.res.mmw + 'x' + c.res.res.mmh + 'mm, ' + safeText(c.res.res) + ')'
        : 'UNKNOWN (' + c.res.reason + ')') + '\n');
    process.stdout.write('backup:   ' + (fs.existsSync(backupPath(target)) ? backupPath(target) : 'none') + '\n');
}

/* The sink URL a --capture/--sink apply writes, or undefined for the stock AVB
 * sink (the AVB test). --capture <fifo> is sugar for a file:// FIFO; --sink
 * <url> takes a full udp://, tcp:// or file:// URL. */
function sinkUrlFor(capture, sink) {
    if (sink !== undefined) {
        if (sink === null || !/^(file|udp|tcp):\/\/[^\0]+$/.test(sink)) die('--sink needs a file://, udp:// or tcp:// URL');
        return sink;
    }
    if (capture === undefined) return undefined;
    if (capture === null) die('--capture needs an absolute FIFO path');
    if (!/^\/[^\0]+$/.test(capture)) die('--capture must be an absolute path');
    return 'file://' + capture + '?mime_type=video/H264';
}

/* The geometry an apply writes. The high panel advertises this tool's
 * display size: --res WxH, or the default, at the map area's physical size,
 * with the default safe area scaled to that size, --safe WxH+X+Y, or --safe
 * full (the whole frame). --res stock and the mid panel keep the stock
 * IC_HIGH geometry (the mid builder is never rewritten). */
function resFor(panel, res, safe) {
    var s = KNOWN.res_stock;
    var stock = { stock: true, w: s.w, h: s.h, mmw: s.mmw, mmh: s.mmh, safew: s.safew, safeh: s.safeh, safex: s.safex, safey: s.safey };
    if (res !== undefined && panel !== 'high') die('--res rewrites the IC_HIGH geometry; it goes with --panel high');
    if (safe !== undefined && (panel !== 'high' || res === 'stock')) die('--safe sets the safe area of the advertised size; it goes with --panel high, not --res stock');
    if (panel !== 'high' || res === 'stock') return stock;
    var w = KNOWN.res_default.w, h = KNOWN.res_default.h;
    if (res !== undefined) {
        var m = /^([0-9]+)x([0-9]+)$/.exec(res || '');
        if (!m) die('--res needs WxH (e.g. 1088x480) or "stock"');
        w = parseInt(m[1], 10); h = parseInt(m[2], 10);
        if (w < 16 || w > 1920 || h < 16 || h > 1080 || (w % 2) !== 0 || (h % 2) !== 0)
            die('--res ' + res + ' out of range: width 16..1920, height 16..1080, both even (H.264)');
    }
    /* The default safe area's edges, scaled from the default size. */
    var d = KNOWN.safe_default, dw = KNOWN.res_default.w, dh = KNOWN.res_default.h;
    var x0 = Math.round(d.x * w / dw), x1 = Math.round((d.x + d.w) * w / dw);
    var y0 = Math.round(d.y * h / dh), y1 = Math.round((d.y + d.h) * h / dh);
    var g = { w: w, h: h, mmw: KNOWN.res_default.mmw, mmh: KNOWN.res_default.mmh, safew: x1 - x0, safeh: y1 - y0, safex: x0, safey: y0 };
    if (safe === 'full') {
        g.safew = w; g.safeh = h; g.safex = 0; g.safey = 0;
    } else if (safe !== undefined) {
        var sm = /^([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)$/.exec(safe || '');
        if (!sm) die('--safe needs WxH+X+Y (e.g. 504x368+286+72) or "full"');
        g.safew = parseInt(sm[1], 10); g.safeh = parseInt(sm[2], 10);
        g.safex = parseInt(sm[3], 10); g.safey = parseInt(sm[4], 10);
        if (g.safew < 16 || g.safeh < 16 || g.safex + g.safew > w || g.safey + g.safeh > h)
            die('--safe ' + safe + ' out of range: at least 16x16, inside the ' + w + 'x' + h + ' frame');
    }
    return g;
}

function cmdApply(target, panel, capture, sink, res, safe, yes) {
    if (panel !== 'high' && panel !== 'mid') die('--panel must be high or mid');
    var wantRes = resFor(panel, res, safe);
    var sinkUrl = sinkUrlFor(capture, sink);
    if (sinkUrl !== undefined && Buffer.byteLength(sinkUrl, 'latin1') > KNOWN.sink_slot_len)
        die('sink URL too long: "' + sinkUrl + '" is ' + Buffer.byteLength(sinkUrl, 'latin1') + ' bytes, slot holds ' + KNOWN.sink_slot_len);

    var buf = readTarget(target);
    var hash = sha256(buf);
    var c = classify(buf);
    if (!c.ok) die('refusing: ' + c.reason);
    if (c.variant.state === 'unknown') die('refusing: ' + c.variant.reason);
    if (c.sink.state === 'unknown') die('refusing: ' + c.sink.reason);
    if (c.selfstart.state === 'unknown') die('refusing: ' + c.selfstart.reason);
    if (c.res.state === 'unknown') die('refusing: ' + c.res.reason);

    /* Back up the pristine original before the first edit; require that a
     * pre-existing backup is that same original. */
    var bak = backupPath(target);
    if (!fs.existsSync(bak)) {
        if (hash !== KNOWN.sha256_original) die('first edit requires the pristine build (sha256 ' + KNOWN.sha256_original + '), got ' + hash);
        fs.writeFileSync(bak, buf, { mode: 0o600 });
        fsyncFile(bak);
        if (sha256(fs.readFileSync(bak)) !== hash) { try { fs.unlinkSync(bak); } catch (e) {} die('backup verification failed; no change made'); }
        fs.writeFileSync(metaPath(target), JSON.stringify({ target: path.resolve(target), version: KNOWN.version, sha256_original: hash, savedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    } else if (sha256(fs.readFileSync(bak)) !== KNOWN.sha256_original) {
        die('existing backup ' + bak + ' is not the known original; refusing');
    }

    var out = Buffer.from(buf);
    var changed = [];

    var wantVariant = panel === 'high' ? KNOWN.variant_high : KNOWN.variant_mid;
    if (u32le(out, KNOWN.slot_offset) !== wantVariant) {
        out.writeUInt32LE(wantVariant >>> 0, KNOWN.slot_offset);
        changed.push('variant -> IC_' + panel.toUpperCase());
    }

    /* With a sink URL, redirect the 2nd stream to this tool. Without one, ensure
     * the sink is the stock avb:// endpoint (resetting it if a previous apply
     * redirected it), so `apply --panel X` alone is the AVB test mode: variant
     * patched, stock sink. */
    var sinkWant = Buffer.alloc(KNOWN.sink_slot_len, 0);
    sinkWant.write(sinkUrl !== undefined ? sinkUrl : KNOWN.sink_original, 'latin1');
    if (!out.slice(KNOWN.sink_offset, KNOWN.sink_offset + KNOWN.sink_slot_len).equals(sinkWant)) {
        sinkWant.copy(out, KNOWN.sink_offset);
        changed.push(sinkUrl !== undefined ? 'sink -> ' + sinkUrl : 'sink -> stock AVB');
    }

    /* Self-start is applied in every mode: without it NavController never
     * forwards the start command and the phone never streams, whatever the sink
     * is. Enabling the map therefore always ensures this edit is present. */
    var selfstartWant = Buffer.from(KNOWN.selfstart_patched, 'hex');
    if (!out.slice(KNOWN.selfstart_offset, KNOWN.selfstart_offset + selfstartWant.length).equals(selfstartWant)) {
        selfstartWant.copy(out, KNOWN.selfstart_offset);
        changed.push('self-start -> requestStream');
    }

    /* The advertised IC_HIGH geometry: this tool's display size on the high
     * panel, stock on mid (restoring the immediates if a high apply wrote
     * them, so the binary carries one panel's geometry at a time). */
    var resBefore = Buffer.from(out);
    writeRes(out, wantRes);
    if (!resBefore.equals(out)) {
        changed.push(wantRes.stock
            ? 'resolution -> stock ' + KNOWN.res_stock.w + 'x' + KNOWN.res_stock.h
            : 'resolution -> ' + wantRes.w + 'x' + wantRes.h + ' at ' + wantRes.mmw + 'x' + wantRes.mmh + 'mm, ' + safeText(wantRes));
    }

    if (changed.length === 0) { process.stdout.write('nothing to do; already in the requested state\n'); return; }

    process.stdout.write('About to patch ' + target + ':\n');
    changed.forEach(function (x) { process.stdout.write('  ' + x + '\n'); });
    if (!yes) die('pass --yes to proceed');

    writeInPlace(target, out);

    var after = readTarget(target);
    var cc = classify(after);
    if (!cc.ok) die('post-write verification failed (' + cc.reason + '); restore from ' + bak);
    if (cc.variant.state !== 'patched' || cc.variant.panel !== panel) die('post-write variant verification failed; restore from ' + bak);
    var wantSink = sinkUrl !== undefined ? 'redirected' : 'original';
    if (cc.sink.state !== wantSink) die('post-write sink verification failed (sink ' + cc.sink.state + ', wanted ' + wantSink + '); restore from ' + bak);
    if (cc.selfstart.state !== 'patched') die('post-write self-start verification failed (' + (cc.selfstart.reason || cc.selfstart.state) + '); restore from ' + bak);
    if (cc.res.state === 'unknown' || cc.res.res.w !== wantRes.w || cc.res.res.h !== wantRes.h ||
        cc.res.res.mmw !== wantRes.mmw || cc.res.res.mmh !== wantRes.mmh ||
        cc.res.res.safew !== wantRes.safew || cc.res.res.safeh !== wantRes.safeh ||
        cc.res.res.safex !== wantRes.safex || cc.res.res.safey !== wantRes.safey)
        die('post-write resolution verification failed (' + (cc.res.reason || cc.res.state) + '); restore from ' + bak);
    /* Only the intended regions changed. */
    if (!onlyRegionsDiffer(buf, after, REGIONS)) die('post-write verification failed: bytes outside the patched regions changed; restore from ' + bak);
    process.stdout.write('patched OK. sha256 now ' + sha256(after) + '\n');
    process.stdout.write('revert:  carplay_patch.js revert --target ' + target + ' --yes\n');
}

/* Revert puts the backup's bytes back in the edits' regions; the rest of the
 * target, another tool's changes included, stays as it is. --force writes the
 * whole backup, also over a target it does not recognise. --drop-backup deletes the
 * backup once none of the edits is left in the target, for a removal of the
 * tool: nothing is left to revert. */
function cmdRevert(target, yes, force, dropBackup) {
    function drop() {
        if (!dropBackup) return;
        [bak, metaPath(target)].forEach(function (f) { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') die('dropping ' + f + ': ' + e.message); } });
        process.stdout.write('backup dropped\n');
    }
    var bak = backupPath(target);
    if (!fs.existsSync(bak)) die('no backup at ' + bak + '; cannot revert');
    var orig = fs.readFileSync(bak);
    var origHash = sha256(orig);
    var meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath(target), 'utf8')); } catch (e) {}
    var expect = meta && meta.sha256_original ? meta.sha256_original : KNOWN.sha256_original;
    if (origHash !== expect) die('backup sha256 ' + origHash + ' != expected ' + expect + '; refusing to restore an unrecognised backup');

    var cur = readTarget(target);
    if (sha256(cur) === origHash) { process.stdout.write('already at the original; nothing to do\n'); drop(); return; }
    /* Only restore over a binary we recognise as a patched form of this build.
     * If the current file is some other binary (e.g. a firmware update replaced
     * carplay and left the old backup behind), restoring would downgrade it. */
    var c = classify(cur);
    if ((!c.ok || c.variant.state === 'unknown' || c.sink.state === 'unknown' || c.selfstart.state === 'unknown' || c.res.state === 'unknown') && !force) {
        die('current ' + target + ' is not a recognised patched build of this backup' +
            (c.ok ? ' (' + (c.variant.reason || c.sink.reason || c.selfstart.reason || c.res.reason) + ')' : ' (' + c.reason + ')') +
            '.\n  It may have been replaced (e.g. a firmware update). Refusing to overwrite it.' +
            '\n  Pass --force only if you are sure this backup is the right original for it.');
    }
    var recognised = c.ok && c.variant.state !== 'unknown' && c.sink.state !== 'unknown' && c.selfstart.state !== 'unknown' && c.res.state !== 'unknown';
    var out = Buffer.from(orig);
    if (recognised && !force) {
        out = Buffer.from(cur);
        REGIONS.forEach(function (r) { orig.copy(out, r[0], r[0], r[0] + r[1]); });
        if (out.equals(cur)) { process.stdout.write('nothing to do: none of the edits is in it; other changes kept\n'); drop(); return; }
    }
    process.stdout.write('About to restore ' + (recognised && !force ? 'the edited regions of ' : '') + target + ' from ' + bak + ' (sha256 ' + origHash + ')\n');
    if (!yes) die('pass --yes to proceed');
    writeInPlace(target, out);
    var after = readTarget(target), ca = classify(after);
    if (!after.equals(out) || !ca.ok || ca.variant.state !== 'original' || ca.sink.state !== 'original' ||
        ca.selfstart.state !== 'original' || ca.res.state !== 'original') die('restore verification failed');
    process.stdout.write(sha256(after) === origHash ? 'restored OK. sha256 now ' + origHash + '\n'
        : 'restored the edited regions; changes outside them kept. sha256 now ' + sha256(after) + '\n');
    if (dropBackup) drop();
    else process.stdout.write('You may delete the backup: ' + bak + ' and ' + metaPath(target) + '\n');
}

function cmdVerify(target) {
    var buf = readTarget(target);
    var c = classify(buf);
    if (!c.ok) { process.stderr.write('FAIL: ' + c.reason + '\n'); process.exit(1); }
    if (c.variant.state === 'unknown') { process.stderr.write('FAIL: ' + c.variant.reason + '\n'); process.exit(1); }
    if (c.sink.state === 'unknown') { process.stderr.write('FAIL: ' + c.sink.reason + '\n'); process.exit(1); }
    if (c.selfstart.state === 'unknown') { process.stderr.write('FAIL: ' + c.selfstart.reason + '\n'); process.exit(1); }
    if (c.res.state === 'unknown') { process.stderr.write('FAIL: ' + c.res.reason + '\n'); process.exit(1); }
    /* A patched variant slot must equal the live IC_HIGH/IC_MID target. */
    if (c.variant.state === 'patched') {
        var ref = c.variant.panel === 'high' ? u32le(buf, KNOWN.table_offset + 9 * 4) : u32le(buf, KNOWN.table_offset + 10 * 4);
        if (u32le(buf, KNOWN.slot_offset) !== ref) { process.stderr.write('FAIL: patched variant slot does not match the live IC target\n'); process.exit(1); }
    }
    /* A fully enabled build has every edit its panel needs. A variant/
     * sink-patched build with stock self-start (an Edit-1/2-only binary)
     * would advertise the display but never start the stream; a high-panel
     * build with stock resolution advertises a display size this tool does
     * not show. Verify calls neither enabled. The mid panel keeps the stock
     * geometry by design. */
    var resOk = c.variant.panel !== 'high' || c.res.state === 'patched';
    var enabled = c.variant.state === 'patched' && c.selfstart.state === 'patched' && resOk;
    var partial = (c.variant.state === 'patched' || c.selfstart.state === 'patched' || c.res.state === 'patched') && !enabled;
    if (partial) { process.stderr.write('FAIL: partially patched — variant ' + c.variant.state + ', self-start ' + c.selfstart.state + ', res ' + c.res.state + ' (enable applies all edits)\n'); process.exit(1); }
    process.stdout.write('OK: variant ' + (c.variant.state === 'original' ? 'original' : 'IC_' + c.variant.panel.toUpperCase()) +
        ', sink ' + (c.sink.state === 'original' ? 'original (AVB 15)' : c.sink.url) +
        ', self-start ' + (c.selfstart.state === 'patched' ? 'on' : 'off') +
        ', res ' + (c.res.state === 'patched' ? c.res.res.w + 'x' + c.res.res.h : 'stock') + '\n');
}

/* Write by atomic rename so a crash mid-write cannot leave carplay half
 * patched; fall back to in-place rewrite on a cross-device/busy rename. The
 * caller remounts / read-write around this (deploy's remount window). */
function fsyncFile(path) {
    var fd = fs.openSync(path, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeInPlace(target, buf) {
    var tmp = target + '.woc-tmp';
    var st;
    try { st = fs.statSync(target); } catch (e) { st = { mode: 0o755 }; }
    fs.writeFileSync(tmp, buf, { mode: st.mode & 0o777 });
    fsyncFile(tmp);   /* the bytes must be on disk before the rename */
    try { fs.renameSync(tmp, target); }
    catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) {}
        var fd = fs.openSync(target, 'r+');
        try { fs.writeSync(fd, buf, 0, buf.length, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
}

function onlyRegionsDiffer(a, b, regions) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        var inside = regions.some(function (r) { return i >= r[0] && i < r[0] + r[1]; });
        if (!inside) return false;
    }
    return true;
}

function parseArgs(argv) {
    var a = { _: [] };
    for (var i = 0; i < argv.length; i++) {
        var t = argv[i];
        if (t === '--yes') a.yes = true;
        else if (t === '--force') a.force = true;
        else if (t === '--drop-backup') a.dropBackup = true;
        else if (t === '--target') a.target = argv[++i];
        else if (t === '--panel') a.panel = argv[++i];
        else if (t === '--capture') {
            /* A missing or flag-shaped value is an error, not "no capture". */
            a.capture = (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) ? argv[++i] : null;
        } else if (t === '--sink') {
            a.sink = (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) ? argv[++i] : null;
        } else if (t === '--res') {
            a.res = (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) ? argv[++i] : null;
        } else if (t === '--safe') {
            a.safe = (i + 1 < argv.length && argv[i + 1].indexOf('--') !== 0) ? argv[++i] : null;
        } else a._.push(t);
    }
    return a;
}

function main() {
    var a = parseArgs(process.argv.slice(2));
    var cmd = a._[0];
    var target = a.target || '/usr/bin/carplay';
    selectBuild(target);
    if (cmd === 'status') cmdStatus(target);
    else if (cmd === 'apply') cmdApply(target, a.panel, a.capture, a.sink, a.res, a.safe, a.yes);
    else if (cmd === 'revert') cmdRevert(target, a.yes, a.force, a.dropBackup);
    else if (cmd === 'verify') cmdVerify(target);
    else { process.stderr.write('usage: carplay_patch.js status|apply|revert|verify [--target <file>] [--panel high|mid] [--capture <fifo> | --sink <url>] [--res WxH|stock] [--safe WxH+X+Y|full] [--yes] [--force] [--drop-backup]\n'); process.exit(2); }
}

main();
