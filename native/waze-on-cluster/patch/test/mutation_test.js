#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Mutation test of carplay_locate.js on the reference build (CARPLAY_BIN,
 * carplay 22.28.3, checked by SHA-256): each case perturbs a copy of the
 * build in memory the way another build could differ (code at other
 * addresses, a function or string duplicated, a check byte changed, a decoy
 * switch, a third geometry builder, inlining, a changed field layout, a
 * relocation or a merged string over an edit site) and the locator must
 * either find every site where it really is or refuse the build. A located
 * build with any site elsewhere is a failure. Nothing is written to disk.
 *
 *   CARPLAY_BIN=<copy of /usr/bin/carplay> node mutation_test.js
 */
'use strict';

var fs = require('fs');
var crypto = require('crypto');
var locator = require('../carplay_locate.js');

var REF_SHA = 'ddb33e33161387c6479c391684b3d019b0de54ecfcee8d6877eca94aa62f3e50';
var SRC = process.env.CARPLAY_BIN || '';
if (!fs.existsSync(SRC)) { process.stdout.write('SKIP: set CARPLAY_BIN to a copy of the unit\'s /usr/bin/carplay (carplay 22.28.3)\n'); process.exit(0); }
var REF = fs.readFileSync(SRC);
if (crypto.createHash('sha256').update(REF).digest('hex') !== REF_SHA) { process.stdout.write('SKIP: CARPLAY_BIN is not carplay 22.28.3\n'); process.exit(0); }

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
function json(x) { return JSON.stringify(x); }

/* ---- ELF helpers (program headers, .eh_frame_hdr, rel32) ---------------- */

function phdrs(buf) {
    var phoff = buf.readUInt32LE(0x20), n = buf.readUInt16LE(0x38), out = [];
    for (var i = 0; i < n; i++) {
        var o = phoff + i * 56;
        out.push({ hdr: o, type: buf.readUInt32LE(o), off: buf.readUInt32LE(o + 8), va: buf.readUInt32LE(o + 16), size: buf.readUInt32LE(o + 32) });
    }
    return out;
}
function vaOf(buf, off) {
    var l = phdrs(buf).filter(function (p) { return p.type === 1 && off >= p.off && off < p.off + p.size; })[0];
    return l ? l.va + off - l.off : null;
}
function offOf(buf, va) {
    var l = phdrs(buf).filter(function (p) { return p.type === 1 && va >= p.va && va < p.va + p.size; })[0];
    return l ? l.off + va - l.va : null;
}
function starts(buf) {
    var eh = phdrs(buf).filter(function (p) { return p.type === 0x6474e550; })[0], n = buf.readUInt32LE(eh.off + 8), s = [];
    for (var i = 0; i < n; i++) s.push(offOf(buf, (eh.va + buf.readInt32LE(eh.off + 12 + i * 8)) >>> 0));
    return s.sort(function (a, b) { return a - b; });
}
var STARTS = starts(REF);
function func(off) {
    for (var i = STARTS.length - 1; i >= 0; i--) if (STARTS[i] <= off) return { off: STARTS[i], end: STARTS[i + 1] };
    return null;
}
/* The target of the rel32 at `pos` whose instruction ends at `next`. */
function relTo(buf, pos, next) { return offOf(buf, (vaOf(buf, next) + buf.readInt32LE(pos)) >>> 0); }
function setRel(buf, pos, next, to) { buf.writeInt32LE(vaOf(buf, to) - vaOf(buf, next), pos); }
function callsIn(buf, f) {
    var out = [];
    for (var p = f.off; p + 5 <= f.end; p++) if (buf[p] === 0xe8) out.push({ at: p, to: relTo(buf, p + 1, p + 5) });
    return out;
}
/* rip-relative lea r64 in f: [{ at (REX byte), to }] */
function leasIn(buf, f) {
    var out = [];
    for (var p = f.off + 1; p + 6 <= f.end; p++) {
        if (buf[p] === 0x8d && (buf[p - 1] & 0xfb) === 0x48 && (buf[p + 1] & 0xc7) === 0x05) out.push({ at: p - 1, to: relTo(buf, p + 2, p + 6) });
    }
    return out;
}
function cstr(buf, off) { return buf.toString('latin1', off, buf.indexOf(0, off)); }
function strOff(buf, s) { var i = buf.indexOf(Buffer.from(s + '\0', 'latin1')); return i; }

/* ---- the reference's sites ---------------------------------------------- */

var LOC = locator.locate(REF);
ok('reference build located', LOC.ok, json(LOC));
if (!LOC.ok) { process.exit(1); }

function sites(loc) {
    return {
        slot: loc.variant.slot, high: loc.variant.high, sink: loc.sink.offset, call: loc.selfstart.offset,
        callPatched: loc.selfstart.patched, requestStream: loc.selfstart.requestStream,
        mm: loc.res.mm, px: loc.res.px, safe1: loc.res.safe1, safe2: loc.res.safe2,
    };
}
var EXPECT = sites(LOC);
function shifted(d) { var e = {}; Object.keys(EXPECT).forEach(function (k) { e[k] = /^(high|callPatched)$/.test(k) ? EXPECT[k] : EXPECT[k] + d; }); return e; }

var SS = LOC.selfstart.setStreamStatus, RS = LOC.selfstart.requestStream, OSU = LOC.selfstart.onSuggestUi;
var BUILDER = LOC.res.builder;

/* The converter switch (the jump through the table the variant site is in). */
var SWITCH = (function () {
    for (var p = 0; p + 24 <= REF.length; p++) {
        if (REF[p] === 0x80 && REF[p + 1] === 0x3f && REF[p + 3] === 0x77 && REF[p + 8] === 0x48 && REF[p + 9] === 0x8d && REF[p + 10] === 0x15 &&
            relTo(REF, p + 11, p + 15) === LOC.variant.table) return p;
    }
    return null;
})();
var CONV = func(SWITCH);
/* The ICSafeAreaProvider constructor: the caller of the IC_HIGH builder. */
var CTOR_CALL_HIGH = (function () {
    for (var p = 0; p + 5 <= REF.length; p++) if (REF[p] === 0xe8 && relTo(REF, p + 1, p + 5) === BUILDER) return p;
    return null;
})();
var CTOR = func(CTOR_CALL_HIGH);
var CTOR_CALLS = callsIn(REF, CTOR);
function isBuilder(to) { return to !== null && REF[to] === 0x48 && REF[to + 1] === 0xba; }
var MID_BUILDER = CTOR_CALLS.filter(function (c) { return isBuilder(c.to) && c.to !== BUILDER; })[0].to;
/* The two variant checks the constructor calls: 64-byte functions comparing [rdi]. */
function checkKind(f) {
    var fn = func(f); if (!fn || fn.off !== f || fn.end - fn.off > 128) return null;
    var b = REF.slice(fn.off, fn.end);
    return b.indexOf(Buffer.from('8b0785c00f94c0', 'hex')) >= 0 ? 'high' : b.indexOf(Buffer.from('833f010f94c0', 'hex')) >= 0 ? 'mid' : null;
}
var CHECK_HIGH = CTOR_CALLS.filter(function (c) { return checkKind(c.to) === 'high'; })[0];
var CHECK_MID = CTOR_CALLS.filter(function (c) { return checkKind(c.to) === 'mid'; })[0];

/* A function far from every site, overwritten to plant code (the locator
 * reads code; nothing runs). */
var VICTIM = (function () {
    for (var i = 0; i < STARTS.length - 1; i++) {
        var s = STARTS[i], e = STARTS[i + 1];
        if (s >= 0x100000 && s < 0x170000 && e - s >= 0x400) return { off: s, end: e };
    }
    return null;
})();
var VICTIM2 = (function () {
    for (var i = 0; i < STARTS.length - 1; i++) {
        var s = STARTS[i], e = STARTS[i + 1];
        if (s >= 0x170000 && s < 0x180000 && e - s >= 0x100) return { off: s, end: e };
    }
    return null;
})();
/* A short function, the size of a builder. */
var SHORT = (function () {
    for (var i = 0; i < STARTS.length - 1; i++) {
        var s = STARTS[i], e = STARTS[i + 1];
        if (s >= 0x100000 && s < 0x170000 && e - s >= 0x70 && e - s <= 0x80) return { off: s, end: e };
    }
    return null;
})();
ok('mutation anchors found in the reference', SWITCH !== null && CONV && CTOR && MID_BUILDER && CHECK_HIGH && CHECK_MID && VICTIM && VICTIM2 && SHORT,
    json({ SWITCH: SWITCH, CTOR: CTOR, MID_BUILDER: MID_BUILDER, VICTIM: VICTIM }));

/* Copy [from, from+len) to `to`, fixing every call/rip-lea rel32 so it keeps
 * its target. Returns nothing; the caller fixes what should change. */
function plant(b, from, len, to) {
    REF.copy(b, to, from, from + len);
    var f = { off: from, end: from + len };
    callsIn(REF, f).forEach(function (c) { if (c.to !== null) setRel(b, c.at - from + to + 1, c.at - from + to + 5, c.to); });
    leasIn(REF, f).forEach(function (l) { if (l.to !== null) setRel(b, l.at - from + to + 3, l.at - from + to + 7, l.to); });
}

/* ---- the cases -------------------------------------------------------- */

/* Each: [name, mutate(b) -> b' (or nothing: b changed in place), allowed outcomes,
 *        expected sites when located (default the reference's)] */
var CASES = [
    ['code and data at other file offsets and addresses', function (b) {
        var pad = 0x1000, out = Buffer.concat([Buffer.alloc(pad), b]);
        b.copy(out, 0, 0, 0x40 + 56 * b.readUInt16LE(0x38));
        phdrs(out).forEach(function (p) {
            out.writeUInt32LE(p.off + pad, p.hdr + 8);
            if (p.type !== 6) { out.writeUInt32LE(p.va + 0x400000, p.hdr + 16); out.writeUInt32LE(p.va + 0x400000, p.hdr + 24); }
        });
        return out;
    }, ['correct'], shifted(0x1000)],

    ['requestStream\'s name string duplicated', function (b) {
        return Buffer.concat([b, Buffer.from('\0' + cstr(b, strOff(b, 'void carplay::navi_handler::AlternateDisplays::requestStream()')) + '\0', 'latin1')]);
    }, ['refused']],

    ['the converter\'s name string duplicated', function (b) {
        var s = b.indexOf('codingToInternal(const CodingKOMBI_HUD::eKI_KOMBI_VARIANT&');
        while (b[s - 1] !== 0) s--;
        return Buffer.concat([b, Buffer.from('\0' + cstr(b, s) + '\0', 'latin1')]);
    }, ['correct', 'refused']],

    ['a copy of the converter sharing its table', function (b) {
        plant(b, CONV.off, CONV.end - CONV.off, VICTIM.off);
    }, ['correct', 'refused']],

    ['a decoy converter with its own table, the real one compiled differently', function (b) {
        var n = b[SWITCH + 2] + 1, table = LOC.variant.table, len = CONV.end - CONV.off;
        plant(b, CONV.off, len, VICTIM.off);
        var name = leasIn(b, { off: VICTIM.off, end: VICTIM.off + len }).filter(function (l) { return /codingToInternal/.test(cstr(b, l.to)); });
        name.forEach(function (l) { setRel(b, l.at + 3, l.at + 7, VICTIM2.off); });   /* the decoy logs no name */
        var copy = VICTIM.off + ((len + 15) & ~15);
        for (var i = 0; i < n; i++) b.writeInt32LE(vaOf(b, relTo(REF, table + i * 4, table)) - vaOf(b, copy), copy + i * 4);   /* entries rebased onto the copy */
        var sw = SWITCH - CONV.off + VICTIM.off;
        setRel(b, sw + 11, sw + 15, copy);
        b[SWITCH + 7] = 0x0f;   /* the real one: movzx ecx,byte [rdi] */
    }, ['refused']],

    ['IC_HIGH and IC_MID swapped in the converter', function (b) {
        var t = LOC.variant.table, s9 = b.readUInt32LE(t + 36);
        b.writeUInt32LE(b.readUInt32LE(t + 40), t + 36); b.writeUInt32LE(s9, t + 40);
    }, ['refused']],

    ['a new internal value for IC_HIGH', function (b) {
        var h = relTo(b, LOC.variant.table + 36, LOC.variant.table); b.writeUInt32LE(4, h + 2);
    }, ['refused']],

    ['the IC_HIGH check inverted (setne)', function (b) {
        var f = func(CHECK_HIGH.to), i = b.indexOf(Buffer.from('0f94c0', 'hex'), f.off); b[i + 1] = 0x95;
    }, ['refused']],

    ['the constructor\'s two builder calls swapped', function (b) {
        var mid = CTOR_CALLS.filter(function (c) { return c.to === MID_BUILDER; })[0];
        setRel(b, CTOR_CALL_HIGH + 1, CTOR_CALL_HIGH + 5, MID_BUILDER);
        setRel(b, mid.at + 1, mid.at + 5, BUILDER);
    }, ['correct', 'refused'], (function () {
        var e = JSON.parse(json(EXPECT)), d = MID_BUILDER - BUILDER;
        e.mm += d; e.px += d; e.safe1 += d; e.safe2 += d; return e;
    })()],

    ['the constructor\'s IC_HIGH and IC_MID check calls swapped', function (b) {
        setRel(b, CHECK_HIGH.at + 1, CHECK_HIGH.at + 5, CHECK_MID.to);
        setRel(b, CHECK_MID.at + 1, CHECK_MID.at + 5, CHECK_HIGH.to);
    }, ['correct', 'refused'], (function () {
        var e = JSON.parse(json(EXPECT)), d = MID_BUILDER - BUILDER;
        e.mm += d; e.px += d; e.safe1 += d; e.safe2 += d; return e;
    })()],

    ['a third geometry builder called by the constructor', function (b) {
        plant(b, BUILDER, 0x70, SHORT.off);
        var other = CTOR_CALLS.filter(function (c) { var f = func(c.to); return f && f.off === c.to && !isBuilder(c.to) && !checkKind(c.to) && f.end - f.off > 0x100; })[0];
        setRel(b, other.at + 1, other.at + 5, SHORT.off);
    }, ['refused']],

    ['the mm pair loaded from memory, 48 ba inside the displacement', function (b) {
        /* mov rdx,[rip+0xba48] ; nop3 in place of movabs rdx,imm64 */
        Buffer.from('488b1548ba00000f1f00', 'hex').copy(b, BUILDER);
    }, ['refused']],

    ['a getter reads another field', function (b) {
        var i = b.indexOf(Buffer.from('0fb7472c', 'hex'), BUILDER); b[i + 3] = 0x2a;
    }, ['refused']],

    ['AVAILABLE changed to another status', function (b) { b[LOC.selfstart.offset - 12] = 0x03; }, ['refused']],

    ['onSuggestUi calls setStreamStatus twice', function (b) {
        var c = callsIn(REF, { off: OSU, end: LOC.selfstart.offset }).filter(function (x) { return x.to !== null && x.to !== SS; });
        setRel(b, c[c.length - 1].at + 1, c[c.length - 1].at + 5, SS);
    }, ['refused']],

    ['requestStream inlined into its caller', function (b) {
        var caller = null;
        for (var p = 0; p + 5 <= 0x338000; p++) if (b[p] === 0xe8 && relTo(b, p + 1, p + 5) === RS) { caller = func(p); break; }
        var cl = leasIn(REF, caller), rl = leasIn(REF, { off: RS, end: func(RS).end });
        var rsName = strOff(REF, 'void carplay::navi_handler::AlternateDisplays::requestStream()');
        var named = cl.filter(function (l) { return / carplay::navi_handler::AlternateDisplays::/.test(cstr(REF, l.to)); });
        var others = cl.filter(function (l) { return named.indexOf(l) < 0; });
        /* the caller loads requestStream's name and the two check strings; requestStream loads the caller's name */
        named.forEach(function (l) { setRel(b, l.at + 3, l.at + 7, rsName); });
        rl.filter(function (l) { return l.to === rsName; }).forEach(function (l) { setRel(b, l.at + 3, l.at + 7, named[0].to); });
        setRel(b, others[0].at + 3, others[0].at + 7, b.indexOf('mCinemoCarPlay->ShowUI('));
        setRel(b, others[1].at + 3, others[1].at + 7, b.indexOf('mCinemoCarPlay->ForceKeyframe('));
        if (!callsIn(REF, caller).some(function (c) { return c.to === SS; })) throw new Error('caller does not call setStreamStatus');
    }, ['refused']],

    ['requestStream\'s name loaded only deep inside it (a split-off part)', function (b) {
        var rsName = strOff(REF, 'void carplay::navi_handler::AlternateDisplays::requestStream()');
        var l = leasIn(REF, { off: RS, end: func(RS).end }).filter(function (x) { return x.to === rsName; })[0];
        setRel(b, l.at + 3, l.at + 7, strOff(REF, 'void carplay::navi_handler::AlternateDisplays::stopStream()'));
    }, ['refused']],

    ['a second sink URL slot', function (b) {
        return Buffer.concat([b, Buffer.from('\0' + locator.SINK_STOCK + '\0\0\0\0\0mCarPlay->GetDisplaySource( src, uuid)\0', 'latin1')]);
    }, ['refused']],

    ['a string merged into the tail of the sink slot', function (b) {
        var l = leasIn(REF, VICTIM2)[0];
        setRel(b, l.at + 3, l.at + 7, LOC.sink.offset + locator.SINK_STOCK.indexOf('mime_type'));
    }, ['refused']],

    ['a dynamic relocation over the sink slot', function (b) {
        var shoff = b.readUInt32LE(0x28), n = b.readUInt16LE(0x3c);
        for (var i = 0; i < n; i++) {
            var o = shoff + i * 64;
            if (b.readUInt32LE(o + 4) === 4) { b.writeUInt32LE(vaOf(b, LOC.sink.offset), b.readUInt32LE(o + 24)); return; }
        }
        throw new Error('no .rela section');
    }, ['refused']],
];

var tally = { correct: 0, refused: 0, WRONG: 0 };
CASES.forEach(function (t) {
    var b = Buffer.from(REF), out;
    try { out = t[1](b) || b; } catch (e) { ok(t[0] + ': mutation built', false, e.message); return; }
    var loc = locator.locate(out), want = t[3] || EXPECT, got = loc.ok ? sites(loc) : null;
    var outcome = !loc.ok ? 'refused' : json(got) === json(want) ? 'correct' : 'WRONG';
    tally[outcome]++;
    ok(t[0] + ': ' + outcome + (outcome === 'refused' ? ' (' + loc.reason + ')' : ''), t[2].indexOf(outcome) >= 0,
        'allowed ' + t[2].join('/') + (got ? '; got ' + json(got) + ', want ' + json(want) : ''));
});
process.stdout.write('\n' + CASES.length + ' mutations: ' + tally.correct + ' located correctly, ' + tally.refused + ' refused, ' + tally.WRONG + ' located wrongly\n');
process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
process.exit(fails ? 1 : 0);
