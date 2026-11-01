#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Proves carplay_locate.js and carplay_patch.js on synthetic builds
 * (synthetic_carplay.js): every site found where the build put it, also with
 * other offsets, addresses and code order, and in its patched state; a
 * signature found twice refused as ambiguous; a damaged site refused with the
 * reason; apply, verify, probe and revert on a build outside the proven list,
 * byte-exact. With CARPLAY_BIN, the reference build's sites are the documented
 * offsets.
 *
 *   node locate_test.js
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var locator = require('../carplay_locate.js');
var synthetic = require('./synthetic_carplay.js');

var SCRIPT = path.join(__dirname, '..', 'carplay_patch.js');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
function run(args) {
    var r = cp.spawnSync(process.execPath, [SCRIPT].concat(args), { encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function json(x) { return JSON.stringify(x); }

/* The sites the locator reports, in the fixture's terms. */
function sites(loc) {
    return {
        buildId: loc.buildId, table: loc.variant.table, slot: loc.variant.slot,
        original: loc.variant.original, high: loc.variant.high, mid: loc.variant.mid, sink: loc.sink.offset,
        call: loc.selfstart.offset, setStreamStatus: loc.selfstart.setStreamStatus, requestStream: loc.selfstart.requestStream,
        onSuggestUi: loc.selfstart.onSuggestUi, callOriginal: loc.selfstart.original, callPatched: loc.selfstart.patched,
        builder: loc.res.builder, mm: loc.res.mm, px: loc.res.px, safe1: loc.res.safe1, safe2: loc.res.safe2,
    };
}
function expected(at) { var e = {}; Object.keys(sites({ variant: {}, sink: {}, selfstart: {}, res: {} })).forEach(function (k) { e[k] = at[k]; }); return e; }
function reasons(loc) { return ['variant', 'sink', 'selfstart', 'res'].filter(function (e) { return !loc[e].ok; }).map(function (e) { return loc[e].reason; }); }

var SHIFTED = { pad: 0x123, codeVa: 0x7a000, dataVa: 0x1234000, dataAt: 0x2800, highViaJne: true, midFirst: true };

/* Found where the build put them. */
[['synthetic build', {}], ['shifted build (other offsets, addresses, code order, jne branch)', SHIFTED]].forEach(function (t) {
    var s = synthetic.build(t[1]), loc = locator.locate(s.buf);
    ok(t[0] + ': every site found where it is', loc.ok && json(sites(loc)) === json(expected(s.at)), json(loc));
});
var plain = synthetic.build({}), shifted = synthetic.build(SHIFTED);
ok('the shifted build moves every site', ['slot', 'sink', 'call', 'mm'].every(function (k) { return plain.at[k] !== shifted.at[k]; }));

/* The patched state is found at the same sites. */
(function () {
    var s = synthetic.build(SHIFTED), b = Buffer.from(s.buf);
    b.writeUInt32LE(s.at.high, s.at.slot);
    Buffer.alloc(59).copy(b, s.at.sink); b.write('udp://127.0.0.1:20557?mime_type=video/H264', s.at.sink, 'latin1');
    Buffer.from(s.at.callPatched, 'hex').copy(b, s.at.call);
    b.writeUInt32LE(138, s.at.mm); b.writeUInt32LE(1088, s.at.px);
    var loc = locator.locate(b);
    ok('patched build: the same sites', loc.ok && json(sites(loc)) === json(expected(s.at)), json(loc));
    b.writeUInt32LE(s.at.mid, s.at.slot);
    ok('slot 7 set to slot 10\'s value: found', locator.locate(b).variant.ok);
})();

/* A signature found twice is ambiguous. */
[['two sink URL slots', { twoSinks: true }, 'sink: URL slot found 2 times'],
 ['two converter switches', { twoConverters: true }, 'variant: converter switch found 2 times']].forEach(function (t) {
    var loc = locator.locate(synthetic.build(t[1]).buf);
    ok(t[0] + ': refused as ambiguous, the other edits found', !loc.ok && json(reasons(loc)) === json([t[2]]), json(reasons(loc)));
});

/* A damaged site is refused with what is wrong. */
[
    ['the IC_HIGH handler stores OTHER', function (b, at) { b.writeUInt32LE(2, at.highHandler + 2); }, 'variant: slot 9 is not IC_HIGH'],
    ['slot 7 points at the NOT_ACTIVE handler', function (b, at) { b.writeUInt32LE(b.readUInt32LE(at.table), at.slot); }, 'variant: slot 7 not OTHER/IC_HIGH/IC_MID'],
    ['another sink URL', function (b, at) { b.write('ws://', at.sink, 'latin1'); }, 'sink: URL slot not found'],
    ['no AVAILABLE argument', function (b, at) { b[at.call - 12] = 2; }, 'self-start: call has no AVAILABLE argument'],
    ['onSuggestUi calls something else', function (b, at) { b.writeInt32LE(b.readInt32LE(at.call + 1) + 0x40, at.call + 1); }, 'self-start: onSuggestUi call not found'],
    ['no ForceKeyframe check', function (b) { var i = b.indexOf('ForceKeyframe'); b.write('ForceKeyFrame', i, 'latin1'); }, 'self-start: ForceKeyframe string not found'],
    ['a geometry store broken', function (b, at) { b[at.px + 8] = 0x90; }, 'resolution: 1 geometry builders (want 2)'],
].forEach(function (t) {
    var s = synthetic.build({}), b = Buffer.from(s.buf);
    t[1](b, s.at);
    var loc = locator.locate(b);
    ok('damaged (' + t[0] + '): ' + t[2], json(reasons(loc)) === json([t[2]]), json(reasons(loc)));
});
(function () {
    var loc = locator.locate(synthetic.build({ noEhFrame: true }).buf);
    ok('no function table: self-start and resolution say so', json(reasons(loc)) === json(['self-start: no function table', 'resolution: no function table']), json(reasons(loc)));
    loc = locator.locate(Buffer.from('#!/bin/sh\nexec carplay "$@"\n'));
    ok('not an ELF', loc.elf === false && loc.reason === 'not an ELF file' && !loc.ok, json(loc));
})();

/* The patcher on a build outside the proven list. */
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-locate-'));
try {
    var tgt = path.join(dir, 'carplay'), orig = shifted.buf, at = shifted.at, r;
    fs.writeFileSync(tgt, orig, { mode: 0o755 });
    function hx(n) { return '0x' + n.toString(16); }

    r = run(['status', '--target', tgt]);
    ok('status: pristine by its stock sites, every edit ORIGINAL', /known:\s+yes, pristine build [0-9a-f]{40}/.test(r.out) &&
        /variant:\s+ORIGINAL/.test(r.out) && /sink:\s+ORIGINAL/.test(r.out) && /selfstart:\s+ORIGINAL/.test(r.out) &&
        /res:\s+ORIGINAL \(IC_HIGH advertises 1600x800\)/.test(r.out), r.out);
    r = run(['probe', tgt]);
    ok('probe: the sites, not proven, patchable', r.code === 0 && /proven:\s+no/.test(r.out) && /patchable:\s+yes/.test(r.out) &&
        r.out.indexOf('slot ' + hx(at.slot) + ' (table ' + hx(at.table) + ', 12 slots)') >= 0 && r.out.indexOf('slot ' + hx(at.sink) + ' (59 bytes)') >= 0 &&
        r.out.indexOf('call ' + hx(at.call) + ' in onSuggestUi ' + hx(at.onSuggestUi)) >= 0 &&
        r.out.indexOf('immediates ' + [at.mm, at.px, at.safe1, at.safe2].map(hx).join(' ')) >= 0 &&
        r.out.indexOf('build-id:  ' + at.buildId) >= 0, r.out);

    r = run(['apply', '--target', tgt, '--panel', 'high', '--sink', 'udp://127.0.0.1:20557?mime_type=video/H264', '--yes']);
    var b = fs.readFileSync(tgt);
    ok('apply high: all four edits written', r.code === 0 && /patched OK/.test(r.out) && b.readUInt32LE(at.slot) === at.high &&
        b.toString('hex', at.call, at.call + 5) === at.callPatched && b.toString('latin1', at.sink, at.sink + 9) === 'udp://127' &&
        b.readUInt32LE(at.mm) === 138 && b.readUInt32LE(at.px) === 1088, r.out);
    ok('apply high: the backup is the original', fs.readFileSync(tgt + '.woc-orig').equals(orig));
    r = run(['verify', '--target', tgt]);
    ok('verify: enabled', r.code === 0 && /OK: variant IC_HIGH, sink udp:\/\/127\.0\.0\.1:20557\?mime_type=video\/H264, self-start on, res 1088x480/.test(r.out), r.out);
    r = run(['apply', '--target', tgt, '--panel', 'mid', '--yes']);
    b = fs.readFileSync(tgt);
    ok('apply mid: the stock geometry back from the backup, the stock sink', r.code === 0 && /resolution -> stock 1600x800/.test(r.out) &&
        b.slice(at.mm, at.safe2 + 8).equals(orig.slice(at.mm, at.safe2 + 8)) && b.slice(at.sink, at.sink + 59).equals(orig.slice(at.sink, at.sink + 59)) &&
        b.readUInt32LE(at.slot) === at.mid, r.out);
    r = run(['revert', '--target', tgt, '--yes']);
    ok('revert: byte-exact original', r.code === 0 && fs.readFileSync(tgt).equals(orig), r.out);

    var amb = synthetic.build({ twoSinks: true }).buf;
    fs.writeFileSync(tgt, amb);
    r = run(['probe', tgt]);
    ok('probe of an ambiguous build: not patchable, with the reason', /patchable:\s+no — sink: URL slot found 2 times/.test(r.out), r.out);
    r = run(['status', '--target', tgt]);
    ok('status of an ambiguous build: known NO with the reason', /known:\s+NO — sink: URL slot found 2 times/.test(r.out), r.out);
    r = run(['apply', '--target', tgt, '--panel', 'high', '--yes']);
    ok('apply refuses it, no write', r.code !== 0 && /refusing: sink: URL slot found 2 times/.test(r.out) && fs.readFileSync(tgt).equals(amb), r.out);
} finally {
    cp.execFileSync('rm', ['-rf', dir]);
}

/* The reference build: the documented offsets. */
var SRC = process.env.CARPLAY_BIN || '';
if (fs.existsSync(SRC)) {
    var loc = locator.locate(fs.readFileSync(SRC));
    ok('reference build: the documented sites', loc.ok && loc.variant.table === 0x2ba4d4 && loc.variant.slot === 0x2ba4f0 &&
        loc.variant.original === 0xfff7f2ec && loc.variant.high === 0xfff7f2bc && loc.variant.mid === 0xfff7f30c &&
        loc.sink.offset === 0x2a20b0 && loc.sink.len === 59 &&
        loc.selfstart.offset === 0x18176c && loc.selfstart.original === 'e8effdffff' && loc.selfstart.patched === 'e89f000000' &&
        loc.selfstart.setStreamStatus === 0x181560 && loc.selfstart.requestStream === 0x181810 && loc.selfstart.onSuggestUi === 0x1816f0 &&
        loc.res.builder === 0x20ca30 && json([loc.res.mm, loc.res.px, loc.res.safe1, loc.res.safe2]) === json([0x20ca32, 0x20ca54, 0x20ca66, 0x20ca74]), json(loc));
} else {
    process.stdout.write('skip reference build: set CARPLAY_BIN to a copy of the unit\'s /usr/bin/carplay (carplay 22.28.3)\n');
}

process.stdout.write(fails ? ('\n' + fails + ' check(s) failed\n') : '\nall checks passed\n');
process.exit(fails ? 1 : 0);
