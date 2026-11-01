// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* A small synthetic x86-64 ELF holding the structures carplay_locate.js looks
 * for, written from scratch: the variant converter switch and a smaller
 * switch beside it, the sink URL and its next-string anchor, setStreamStatus,
 * requestStream and onSuggestUi with their name strings, and the
 * ICSafeAreaProvider constructor with its IC_HIGH/IC_MID checks and two
 * geometry builders, plus program headers, a build-id note and an
 * .eh_frame_hdr search table. Code and data sit in two segments whose
 * addresses differ from their file offsets by different amounts.
 *
 *   build({ pad, codeVa, dataVa, dataAt, highViaJne, midFirst, twoSinks,
 *           twoConverters, noEhFrame })
 *     -> { buf, at: the offsets and values the locator should report }
 */
'use strict';

var crypto = require('crypto');

var SINK = 'avb://media_transport.avb_streaming.15?mime_type=video/H264';
var STOCK_HIGH = { mmw: 200, mmh: 100, w: 1600, h: 800, safew: 600, safeh: 500, safex: 400, safey: 150 };
var STOCK_MID = { mmw: 200, mmh: 80, w: 1600, h: 640, safew: 500, safeh: 400, safex: 500, safey: 100 };

function build(o) {
    o = o || {};
    var CODE = 0x400, DATA = o.dataAt || 0x2000, SIZE = DATA + 0x1000;
    var codeVa = o.codeVa !== undefined ? o.codeVa : 0x10000;
    var dataVa = o.dataVa !== undefined ? o.dataVa : 0x600000;
    var buf = Buffer.alloc(SIZE), labels = {}, fixes = [], starts = [], pc = CODE + (o.pad || 0), pd = DATA + 8;
    function va(off) { return off < DATA ? codeVa + off : dataVa + (off - DATA); }

    function b() { for (var i = 0; i < arguments.length; i++) buf[pc++] = arguments[i]; }
    function u32(v) { buf.writeUInt32LE(v >>> 0, pc); pc += 4; }
    function fn(name) { pc = (pc + 15) & ~15; labels[name] = pc; starts.push(pc); }
    function label(name) { labels[name] = pc; }
    function rel(target, size) { fixes.push({ at: pc, next: pc + size, target: target, size: size }); pc += size; }
    function call(target) { b(0xe8); rel(target, 4); }
    function lea(rex, modrm, target) { b(rex, 0x8d, modrm); rel(target, 4); }
    function str(name, s) { labels[name] = pd; pd += buf.write(s, pd, 'latin1') + 1; }
    function table(name, targets) {
        pd = (pd + 3) & ~3;
        labels[name] = pd;
        targets.forEach(function (t) { fixes.push({ at: pd, base: name, target: t }); pd += 4; });
    }

    /* a switch: cmp byte [rdi],n-1 ; ja ; movzx ; lea rdx,[rip+table] ; movsxd ; add ; jmp rax,
     * and its handlers: mov dword [rsi],value ; mov eax,1 ; ret */
    function converter(name, kinds) {
        fn(name);
        b(0x80, 0x3f, kinds.length - 1, 0x77); rel(name + '.ret', 1);
        b(0x0f, 0xb6, 0x07); lea(0x48, 0x15, name + '.table');
        b(0x48, 0x63, 0x04, 0x82, 0x48, 0x01, 0xd0, 0xff, 0xe0);
        var handlers = [];
        kinds.forEach(function (k) {
            if (handlers.indexOf(k) >= 0) return;
            handlers.push(k);
            label(name + '.h' + k); b(0xc7, 0x06); u32(k); b(0xb8, 1, 0, 0, 0, 0xc3);
        });
        label(name + '.ret'); b(0x31, 0xc0, 0xc3);
        table(name + '.table', kinds.map(function (k) { return name + '.h' + k; }));
    }
    function builder(name, g) {
        fn(name);
        b(0x48, 0xba); label(name + '.mm'); u32(g.mmw); u32(g.mmh);
        b(0x48, 0x83, 0xec, 0x18, 0x48, 0x89, 0x57, 0x10, 0x48, 0xb8); label(name + '.px'); u32(g.w); u32(g.h);
        b(0x48, 0x89, 0x47, 0x08, 0x48, 0x89, 0x47, 0x18, 0x48, 0xb8); label(name + '.safe1'); u32(0); u32(g.safew);
        b(0x48, 0x89, 0x47, 0x20, 0x48, 0xb8); label(name + '.safe2'); u32(g.safeh);
        buf.writeUInt16LE(g.safex, pc); buf.writeUInt16LE(g.safey, pc + 2); pc += 4;
        b(0x48, 0x89, 0x47, 0x28, 0x48, 0x83, 0xc4, 0x18, 0xc3);
    }

    /* the build-id note */
    var note = 0x200;
    buf.writeUInt32LE(4, note); buf.writeUInt32LE(20, note + 4); buf.writeUInt32LE(3, note + 8); buf.write('GNU\0', note + 12, 'latin1');
    crypto.createHash('sha1').update(JSON.stringify(o)).digest().copy(buf, note + 16);

    converter('small', [2, 2, 0, 1, 3]);
    var kinds = [3, 2, 2, 2, 2, 2, 2, 2, 2, 0, 1, 2];
    converter('conv', kinds);
    if (o.twoConverters) converter('conv2', kinds);

    fn('ss'); lea(0x48, 0x0d, 's.ss'); b(0xc3);
    fn('rs'); lea(0x4c, 0x05, 's.rs'); lea(0x48, 0x35, 's.show'); lea(0x48, 0x35, 's.kf'); call('ss'); b(0xc3);
    fn('osu'); lea(0x48, 0x0d, 's.osu');
    b(0xc7, 0x44, 0x24, 0x08, 0x01, 0x00, 0x00, 0x00, 0x48, 0x83, 0xc0, 0x10, 0x48, 0x89, 0x04, 0x24);
    label('call'); call('ss'); b(0x48, 0x8b, 0x44, 0x24, 0x18, 0xc3);

    fn('isHigh'); b(0x8b, 0x07, 0x85, 0xc0, 0x0f, 0x94, 0xc0, 0xc3);
    fn('isMid'); b(0x83, 0x3f, 0x01, 0x0f, 0x94, 0xc0, 0xc3);
    if (o.midFirst) { builder('mid', STOCK_MID); builder('high', STOCK_HIGH); }
    else { builder('high', STOCK_HIGH); builder('mid', STOCK_MID); }
    fn('ctor'); lea(0x48, 0x0d, 's.ctor');
    if (o.highViaJne) {
        call('isHigh'); b(0x84, 0xc0, 0x75); rel('ctor.high', 1);
        call('isMid'); b(0x48, 0x89, 0xef, 0x84, 0xc0, 0x0f, 0x84); rel('ctor.end', 4);
        call('mid'); b(0xc3);
        label('ctor.high'); b(0x48, 0x89, 0xef); call('high');
        label('ctor.end'); b(0xc3);
    } else {
        call('isHigh'); b(0x84, 0xc0, 0x0f, 0x84); rel('ctor.mid', 4);
        b(0x48, 0x89, 0xef); call('high'); b(0xc3);
        label('ctor.mid'); call('isMid'); b(0x48, 0x89, 0xef, 0x84, 0xc0, 0x75); rel('ctor.callmid', 1); b(0xc3);
        label('ctor.callmid'); call('mid'); b(0xc3);
    }
    if (pc > DATA) throw new Error('synthetic code overruns its segment');

    str('s.ss', 'void carplay::navi_handler::AlternateDisplays::setStreamStatus(const StreamStatus&)');
    str('s.osu', 'void carplay::navi_handler::AlternateDisplays::onSuggestUi()');
    str('s.rs', 'void carplay::navi_handler::AlternateDisplays::requestStream()');
    str('s.show', 'mCinemoCarPlay->ShowUI( url, uuid)');
    str('s.kf', 'mCinemoCarPlay->ForceKeyframe( uuid)');
    str('s.ctor', 'base::config::ICSafeAreaProvider::ICSafeAreaProvider(const KombiVariant&)');
    str('s.other', 'source');
    str('s.decoy', 'mCarPlay->GetDisplaySource(videoSource, uiid)');
    for (var n = 0; n < (o.twoSinks ? 2 : 1); n++) {
        str('s.before' + n, 'checkError().');
        str('sink' + n, SINK);
        pd += 4;
        str('s.next' + n, 'mCarPlay->GetDisplaySource( videoSource, uuid)');
    }

    /* .eh_frame_hdr: version 1, pcrel sdata4, udata4, datarel sdata4 */
    if (!o.noEhFrame) {
        pd = (pd + 3) & ~3;
        labels.eh = pd;
        buf.writeUInt32BE(0x011b033b, pd); buf.writeUInt32LE(starts.length, pd + 8);
        starts.forEach(function (s, i) { buf.writeInt32LE(va(s) - va(labels.eh), pd + 12 + i * 8); });
        pd += 12 + starts.length * 8;
    }
    if (pd > SIZE) throw new Error('synthetic data overruns its segment');

    fixes.forEach(function (f) {
        var v = f.base ? va(labels[f.target]) - va(labels[f.base]) : va(labels[f.target]) - va(f.next);
        if (f.size === 1) buf.writeInt8(v, f.at); else buf.writeInt32LE(v, f.at);
    });

    /* ELF header and program headers: code LOAD r-x, data LOAD r--, EH_FRAME, NOTE */
    buf.writeUInt32BE(0x7f454c46, 0); buf[4] = 2; buf[5] = 1; buf[6] = 1;
    buf.writeUInt16LE(3, 16); buf.writeUInt16LE(62, 18); buf.writeUInt32LE(1, 20);
    buf.writeUInt32LE(64, 32); buf.writeUInt16LE(64, 52); buf.writeUInt16LE(56, 54);
    var ph = [[1, 5, 0, codeVa, DATA], [1, 4, DATA, dataVa, SIZE - DATA], [4, 4, note, va(note), 36]];
    if (!o.noEhFrame) ph.push([0x6474e550, 4, labels.eh, va(labels.eh), 12 + starts.length * 8]);
    buf.writeUInt16LE(ph.length, 56);
    ph.forEach(function (p, i) {
        var at = 64 + i * 56;
        buf.writeUInt32LE(p[0], at); buf.writeUInt32LE(p[1], at + 4);
        buf.writeUInt32LE(p[2], at + 8); buf.writeUInt32LE(p[3], at + 16); buf.writeUInt32LE(p[3], at + 24);
        buf.writeUInt32LE(p[4], at + 32); buf.writeUInt32LE(p[4], at + 40);
    });

    function slot(i) { return buf.readUInt32LE(labels['conv.table'] + i * 4); }
    function callTo(t) { var r = Buffer.alloc(4); r.writeInt32LE(va(labels[t]) - va(labels.call + 5), 0); return 'e8' + r.toString('hex'); }
    return {
        buf: buf,
        at: {
            buildId: buf.toString('hex', note + 16, note + 36),
            table: labels['conv.table'], slot: labels['conv.table'] + 28, original: slot(1), high: slot(9), mid: slot(10),
            highHandler: labels['conv.h0'],
            sink: labels.sink0,
            call: labels.call, setStreamStatus: labels.ss, requestStream: labels.rs, onSuggestUi: labels.osu,
            callOriginal: callTo('ss'), callPatched: callTo('rs'),
            builder: labels.high, mm: labels['high.mm'], px: labels['high.px'], safe1: labels['high.safe1'], safe2: labels['high.safe2'],
            stock: STOCK_HIGH,
        },
    };
}

module.exports = { build: build };
