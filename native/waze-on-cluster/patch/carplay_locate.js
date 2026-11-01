// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* carplay_locate.js — finds the four carplay-patch edit sites (PATCH.md) in a
 * carplay build by code and data structure. Each site has to be found exactly
 * once and pass its semantic checks; otherwise that edit carries ok:false and
 * a short reason naming what was not found. File offsets and virtual
 * addresses are converted through the ELF program headers, and function
 * bounds come from the .eh_frame_hdr search table. It only reads the buffer.
 *
 * Node 8 on the unit, no dependencies.
 */
'use strict';

var SINK_STOCK = 'avb://media_transport.avb_streaming.15?mime_type=video/H264';
var SINK_NEXT = 'mCarPlay->GetDisplaySource(';
var REDIRECT = /^(file|udp|tcp):\/\/[^\0]+$/;
var IC_HIGH = 0, IC_MID = 1, OTHER = 2, NOT_ACTIVE = 3, SLOT = 7;

/* A 64-bit field of a file under 4 GiB, else null. */
function u64(buf, off) { return buf.readUInt32LE(off + 4) === 0 ? buf.readUInt32LE(off) >>> 0 : null; }

function parseElf(buf) {
    if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) return { reason: 'not an ELF file' };
    if (buf[4] !== 2 || buf[5] !== 1 || buf.readUInt16LE(18) !== 62) return { reason: 'not a 64-bit little-endian x86-64 ELF' };
    var phoff = u64(buf, 0x20), phentsize = buf.readUInt16LE(0x36), phnum = buf.readUInt16LE(0x38);
    if (phoff === null || phoff + phnum * phentsize > buf.length) return { reason: 'ELF program headers out of range' };
    var elf = { load: [], exec: null, eh: null, notes: [] };
    for (var i = 0; i < phnum; i++) {
        var o = phoff + i * phentsize, type = buf.readUInt32LE(o);
        var seg = { off: u64(buf, o + 8), va: u64(buf, o + 16), size: u64(buf, o + 32) };
        if (seg.off === null || seg.va === null || seg.size === null || seg.off + seg.size > buf.length) continue;
        if (type === 1) {                               /* PT_LOAD; PF_X marks the code */
            elf.load.push(seg);
            if ((buf.readUInt32LE(o + 4) & 1) && !elf.exec) elf.exec = { off: seg.off, end: seg.off + seg.size };
        } else if (type === 0x6474e550) elf.eh = seg;   /* PT_GNU_EH_FRAME */
        else if (type === 4) elf.notes.push(seg);       /* PT_NOTE */
    }
    if (!elf.exec) return { reason: 'no executable ELF segment' };
    return elf;
}

/* The GNU build-id note as hex, or null. */
function buildId(buf, notes) {
    for (var n = 0; n < notes.length; n++) {
        for (var o = notes[n].off, end = o + notes[n].size; o + 12 <= end;) {
            var namesz = buf.readUInt32LE(o), descsz = buf.readUInt32LE(o + 4);
            var desc = o + 12 + ((namesz + 3) & ~3);
            if (desc + descsz > end) break;
            if (buf.readUInt32LE(o + 8) === 3 && namesz === 4 && buf.toString('latin1', o + 12, o + 16) === 'GNU\0')
                return buf.toString('hex', desc, desc + descsz);
            o = desc + ((descsz + 3) & ~3);
        }
    }
    return null;
}

/* The image: offset/address conversion, function bounds and code scans. */
function Image(buf, elf) {
    this.buf = buf;
    this.load = elf.load;
    this.exec = elf.exec;
    this.starts = funcStarts(buf, elf.eh);
}
Image.prototype.va = function (off) {
    for (var i = 0; i < this.load.length; i++) {
        var s = this.load[i];
        if (off >= s.off && off < s.off + s.size) return s.va + (off - s.off);
    }
    return null;
};
Image.prototype.off = function (va) {
    for (var i = 0; i < this.load.length; i++) {
        var s = this.load[i];
        if (va >= s.va && va < s.va + s.size) return s.off + (va - s.va);
    }
    return null;
};
/* The function holding `off`, as file offsets { off, end }, or null. */
Image.prototype.func = function (off) {
    var va = this.va(off), s = this.starts, lo = 0, hi = s.length - 1, at = -1;
    while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (s[mid] <= va) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (at < 0) return null;
    var start = this.off(s[at]);
    var end = at + 1 < s.length ? this.off(s[at + 1]) : this.exec.end;
    return start === null || end === null || end > this.exec.end ? null : { off: start, end: end };
};
/* The target (file offset) of a rel32 branch whose 4-byte displacement is
 * at `pos` and whose next instruction starts at `next`. */
Image.prototype.rel = function (pos, next) {
    var va = this.va(next);
    return va === null ? null : this.off((va + this.buf.readInt32LE(pos)) >>> 0);
};
/* The `call rel32` instructions in [start, end): [{ at, to }]. */
Image.prototype.calls = function (start, end) {
    var out = [];
    for (var p = start; p + 5 <= end; p++) {
        if (this.buf[p] === 0xe8) { var to = this.rel(p + 1, p + 5); if (to !== null) out.push({ at: p, to: to }); }
    }
    return out;
};

/* Function start addresses from .eh_frame_hdr's search table (version 1,
 * eh_frame_ptr pcrel sdata4, fde_count udata4, table datarel sdata4: the GCC
 * encoding), sorted; empty when the build has no such table. */
function funcStarts(buf, eh) {
    if (!eh || eh.size < 12 || buf.readUInt32BE(eh.off) !== 0x011b033b) return [];
    var count = buf.readUInt32LE(eh.off + 8), table = eh.off + 12;
    if (table + count * 8 > eh.off + eh.size) return [];
    var starts = [];
    for (var i = 0; i < count; i++) starts.push((eh.va + buf.readInt32LE(table + i * 8)) >>> 0);
    return starts.sort(function (a, b) { return a - b; });
}

/* Offsets matching `pat` (bytes, null = any) in [start, end). */
function scan(buf, start, end, pat) {
    var out = [];
    for (var i = start; i + pat.length <= end; i++) {
        if (buf[i] !== pat[0]) continue;
        for (var j = 1; j < pat.length && (pat[j] === null || buf[i + j] === pat[j]); j++);
        if (j === pat.length) out.push(i);
    }
    return out;
}
function any(n) { var a = []; while (n--) a.push(null); return a; }

/* The NUL-terminated string at `off`. */
function stringAt(buf, off) { var end = buf.indexOf(0, off); return buf.toString('latin1', off, end < 0 ? buf.length : end); }

/* The one string that contains `key` and matches `re`: { off } or { err }. A
 * string starts after the last byte before it that is not printable ASCII. */
function namedString(buf, key, re, label) {
    var found = [], k = Buffer.from(key, 'latin1');
    for (var i = buf.indexOf(k); i >= 0; i = buf.indexOf(k, i + 1)) {
        var s = i;
        while (s > 0 && buf[s - 1] >= 0x20 && buf[s - 1] < 0x7f) s--;
        if (found.indexOf(s) < 0 && re.test(stringAt(buf, s))) found.push(s);
    }
    if (found.length === 1) return { off: found[0] };
    return { err: label + (found.length ? ' string found ' + found.length + ' times' : ' string not found') };
}

/* The rip-relative lea instructions (REX.W 8d, mod 00 rm 101) whose target is
 * one of `offs`: { off: [lea offsets] }. */
function leaRefs(im, offs) {
    var want = {}, out = {}, buf = im.buf;
    offs.forEach(function (o) { var va = im.va(o); if (va !== null) { want[va] = o; out[o] = []; } });
    for (var p = im.exec.off + 1; p + 6 <= im.exec.end; p++) {
        if (buf[p] !== 0x8d || (buf[p - 1] & 0xfb) !== 0x48 || (buf[p + 1] & 0xc7) !== 0x05) continue;
        var va = im.va(p + 6);
        var t = va === null ? null : want[(va + buf.readInt32LE(p + 2)) >>> 0];
        if (t !== undefined && t !== null) out[t].push(p - 1);
    }
    return out;
}

/* The one function referencing a string: { off, end } or { err }. */
function funcOfString(im, refs, str, label) {
    if (str.err) return str;
    var sites = refs[str.off] || [];
    if (!sites.length) return { err: label + ' string not referenced' };
    var f = im.func(sites[0]);
    for (var i = 1; f && i < sites.length; i++) {
        var g = im.func(sites[i]);
        if (!g || g.off !== f.off) return { err: label + ' used by several functions' };
    }
    return f || { err: label + ' outside the function table' };
}

function hex32(n) { return Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]).toString('hex'); }

/* ---- Edit 1: the KI_KOMBI_VARIANT converter switch ---------------------- */

/* cmp byte [rdi],imm8 ; ja ; movzx eax,byte [rdi] ; lea rdx,[rip+table] ;
 * movsxd rax,[rdx+rax*4] ; add rax,rdx ; jmp rax. Several switches share the
 * shape; the converter is the one whose table decodes to the variant mapping. */
var SWITCH = [0x80, 0x3f, null, 0x77, null, 0x0f, 0xb6, 0x07, 0x48, 0x8d, 0x15, null, null, null, null,
    0x48, 0x63, 0x04, 0x82, 0x48, 0x01, 0xd0, 0xff, 0xe0];

function locateVariant(im) {
    var tried = scan(im.buf, im.exec.off, im.exec.end, SWITCH).map(function (m) { return decodeSwitch(im, m); });
    var good = tried.filter(function (t) { return t.ok; });
    if (good.length === 1) return good[0];
    if (good.length > 1) return { ok: false, reason: 'variant: converter switch found ' + good.length + ' times' };
    /* None decodes: a table large enough for the variant values is the
     * converter's, and its reason says what is wrong with it. */
    var sized = tried.filter(function (t) { return !t.small; });
    return sized.length === 1 ? sized[0] : { ok: false, reason: 'variant: converter switch not found' };
}

/* The switch at `m`: raw 9 -> IC_HIGH, 10 -> IC_MID, 0 -> NOT_ACTIVE, every
 * other raw value -> OTHER through one shared table value, and slot 7 that
 * OTHER value (stock) or slot 9's or 10's (patched). */
function decodeSwitch(im, m) {
    var buf = im.buf, n = buf[m + 2] + 1;
    if (n < 11) return { ok: false, small: true, reason: 'variant: converter table too small (' + n + ')' };
    var tableVa = im.va(m + 15);
    var table = tableVa === null ? null : im.off((tableVa + buf.readInt32LE(m + 11)) >>> 0);
    if (table === null || table + n * 4 > buf.length) return { ok: false, reason: 'variant: converter table out of range' };
    var vals = [], kinds = [];
    for (var i = 0; i < n; i++) {
        vals.push(buf.readUInt32LE(table + i * 4));
        var h = im.off((im.va(table) + buf.readInt32LE(table + i * 4)) >>> 0);
        /* each handler stores the internal value: mov dword [rsi],imm32 */
        if (h === null || h + 6 > buf.length || buf[h] !== 0xc7 || buf[h + 1] !== 0x06)
            return { ok: false, reason: 'variant: slot ' + i + ' handler not a store' };
        kinds.push(buf.readUInt32LE(h + 2));
    }
    if (kinds[9] !== IC_HIGH) return { ok: false, reason: 'variant: slot 9 is not IC_HIGH' };
    if (kinds[10] !== IC_MID) return { ok: false, reason: 'variant: slot 10 is not IC_MID' };
    if (kinds[0] !== NOT_ACTIVE) return { ok: false, reason: 'variant: slot 0 is not NOT_ACTIVE' };
    var other = null;
    for (var k = 1; k < n; k++) {
        if (k === 9 || k === 10 || k === SLOT) continue;
        if (kinds[k] !== OTHER) return { ok: false, reason: 'variant: slot ' + k + ' is not OTHER' };
        if (other !== null && vals[k] !== other) return { ok: false, reason: 'variant: OTHER slots differ' };
        other = vals[k];
    }
    if ([other, vals[9], vals[10]].indexOf(vals[SLOT]) < 0) return { ok: false, reason: 'variant: slot 7 not OTHER/IC_HIGH/IC_MID' };
    return { ok: true, table: table, slots: n, slot: table + SLOT * 4, original: other, high: vals[9], mid: vals[10] };
}

/* ---- Edit 2: the second-stream sink URL --------------------------------- */

/* The URL is its own string, followed after a NUL run by the string
 * `mCarPlay->GetDisplaySource( …`: the stock URL, or a redirect NUL-padded to
 * the stock URL's length. The slot ends at least one NUL and at most 16
 * alignment NULs before that string. */
function locateSink(buf) {
    var found = [], next = Buffer.from(SINK_NEXT, 'latin1'), len = SINK_STOCK.length;
    for (var i = buf.indexOf(next); i >= 0; i = buf.indexOf(next, i + 1)) {
        var e = i, s;
        while (e > 0 && buf[e - 1] === 0) e--;
        for (s = e; s > 0 && buf[s - 1] !== 0; s--);
        var url = buf.toString('latin1', s, e);
        if (s > 0 && i - s > len && i - s <= len + 16 && (url === SINK_STOCK || (REDIRECT.test(url) && url.length <= len))) found.push(s);
    }
    if (found.length === 0) return { ok: false, reason: 'sink: URL slot not found' };
    if (found.length > 1) return { ok: false, reason: 'sink: URL slot found ' + found.length + ' times' };
    return { ok: true, offset: found[0], len: len };
}

/* ---- Edit 3: the self-start call retarget ------------------------------- */

var NAMES = {
    ss: ['AlternateDisplays::setStreamStatus(', /^void [\w:]*AlternateDisplays::setStreamStatus\(/, 'self-start: setStreamStatus'],
    osu: ['AlternateDisplays::onSuggestUi()', /^void [\w:]*AlternateDisplays::onSuggestUi\(\)$/, 'self-start: onSuggestUi'],
    rs: ['AlternateDisplays::requestStream()', /^void [\w:]*AlternateDisplays::requestStream\(\)$/, 'self-start: requestStream'],
    showUi: ['mCinemoCarPlay->ShowUI(', /^mCinemoCarPlay->ShowUI\(/, 'self-start: ShowUI'],
    keyframe: ['mCinemoCarPlay->ForceKeyframe(', /^mCinemoCarPlay->ForceKeyframe\(/, 'self-start: ForceKeyframe'],
    ctor: ['ICSafeAreaProvider::ICSafeAreaProvider(', /^[\w:]*ICSafeAreaProvider::ICSafeAreaProvider\(/, 'resolution: ICSafeAreaProvider'],
};

/* setStreamStatus, requestStream and onSuggestUi by their own function-name
 * strings. requestStream must reference the ShowUI and ForceKeyframe checks
 * and call setStreamStatus. The site is onSuggestUi's one call to either,
 * with AVAILABLE (1) stored as its argument just before it. */
function locateSelfstart(im, str, refs) {
    if (!im.starts.length) return { ok: false, reason: 'self-start: no function table' };
    var ss = funcOfString(im, refs, str.ss, NAMES.ss[2]);
    var rs = funcOfString(im, refs, str.rs, NAMES.rs[2]);
    var osu = funcOfString(im, refs, str.osu, NAMES.osu[2]);
    var err = ss.err || rs.err || osu.err || str.showUi.err || str.keyframe.err;
    if (err) return { ok: false, reason: err };
    function inRs(o) { return refs[o].some(function (p) { return p >= rs.off && p < rs.end; }); }
    if (!inRs(str.showUi.off) || !inRs(str.keyframe.off)) return { ok: false, reason: 'self-start: requestStream lacks ShowUI/keyframe' };
    if (!im.calls(rs.off, rs.end).some(function (c) { return c.to === ss.off; }))
        return { ok: false, reason: 'self-start: requestStream lacks setStreamStatus' };
    var sites = im.calls(osu.off, osu.end).filter(function (c) { return c.to === ss.off || c.to === rs.off; });
    if (sites.length !== 1) return { ok: false, reason: 'self-start: onSuggestUi call ' + (sites.length ? 'found ' + sites.length + ' times' : 'not found') };
    var at = sites[0].at;
    /* mov dword [rsp+disp8],1 */
    if (!scan(im.buf, Math.max(osu.off, at - 24), at, [0xc7, 0x44, 0x24, null, 0x01, 0x00, 0x00, 0x00]).length)
        return { ok: false, reason: 'self-start: call has no AVAILABLE argument' };
    var next = im.va(at + 5);
    return {
        ok: true, offset: at, setStreamStatus: ss.off, requestStream: rs.off, onSuggestUi: osu.off,
        original: 'e8' + hex32(im.va(ss.off) - next), patched: 'e8' + hex32(im.va(rs.off) - next)
    };
}

/* ---- Edit 4: the IC_HIGH geometry builder ------------------------------- */

/* mov [rdi+0x10],rdx (the mm pair, loaded earlier by movabs rdx) ;
 * movabs rax,px ; mov [rdi+8],rax ; mov [rdi+0x18],rax ;
 * movabs rax,safe1 ; mov [rdi+0x20],rax ; movabs rax,safe2 ; mov [rdi+0x28],rax */
var STORES = [0x48, 0x89, 0x57, 0x10, 0x48, 0xb8].concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x08, 0x48, 0x89, 0x47, 0x18, 0x48, 0xb8]).concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x20, 0x48, 0xb8]).concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x28]);

/* A geometry builder at `f`: its four immediates' offsets, or null. */
function builder(im, f) {
    var fn = im.func(f);
    if (!fn || fn.off !== f) return null;
    var st = scan(im.buf, f, fn.end, STORES);
    if (st.length !== 1) return null;
    var mm = scan(im.buf, f, st[0] - 8, [0x48, 0xba]);
    return mm.length === 1 ? { builder: f, mm: mm[0] + 2, px: st[0] + 6, safe1: st[0] + 24, safe2: st[0] + 38 } : null;
}

/* The start of the code run when the bool returned by the call at `at` is
 * true: test al,al within 8 bytes, then je (true falls through) or jne (true
 * jumps). */
function trueBranch(im, at, end) {
    var buf = im.buf, t = at + 5, j;
    while (t < Math.min(at + 13, end) && !(buf[t] === 0x84 && buf[t + 1] === 0xc0)) t++;
    if (buf[t] !== 0x84 || buf[t + 1] !== 0xc0) return null;
    j = t + 2;
    if (buf[j] === 0x74) return j + 2;
    if (buf[j] === 0x75) return j + 2 + buf.readInt8(j + 1);
    if (buf[j] === 0x0f && buf[j + 1] === 0x84) return j + 6;
    if (buf[j] === 0x0f && buf[j + 1] === 0x85) return im.rel(j + 2, j + 6);
    return null;
}

/* The ICSafeAreaProvider constructor calls two geometry builders; the IC_HIGH
 * one is the builder called on the true branch of the constructor's call to
 * its `variant == IC_HIGH` check, a small function doing
 * mov eax,[rdi] ; test eax,eax ; sete al (or cmp dword [rdi],0 ; sete al). */
function locateRes(im, str, refs) {
    if (!im.starts.length) return { ok: false, reason: 'resolution: no function table' };
    var ctor = funcOfString(im, refs, str.ctor, NAMES.ctor[2]);
    if (ctor.err) return { ok: false, reason: ctor.err };
    var buf = im.buf, calls = im.calls(ctor.off, ctor.end), builders = {}, isHigh = [];
    calls.forEach(function (c) {
        if (builders[c.to] === undefined) builders[c.to] = builder(im, c.to);
        var fn = im.func(c.to);
        if (fn && fn.off === c.to && fn.end - fn.off <= 128 &&(scan(buf, fn.off, fn.end, [0x8b, 0x07, 0x85, 0xc0, 0x0f, 0x94, 0xc0]).length ||
            scan(buf, fn.off, fn.end, [0x83, 0x3f, 0x00, 0x0f, 0x94, 0xc0]).length)) isHigh.push(c);
    });
    var found = Object.keys(builders).filter(function (k) { return builders[k]; });
    if (found.length !== 2) return { ok: false, reason: 'resolution: ' + found.length + ' geometry builders (want 2)' };
    if (isHigh.length !== 1) return { ok: false, reason: 'resolution: IC_HIGH check ' + (isHigh.length ? 'called ' + isHigh.length + ' times' : 'not found') };
    var branch = trueBranch(im, isHigh[0].at, ctor.end);
    var high = calls.filter(function (c) { return branch !== null && c.at >= branch && c.at < branch + 16 && builders[c.to]; })[0];
    if (!high) return { ok: false, reason: 'resolution: IC_HIGH builder not found' };
    return { ok: true, builder: high.to, mm: builders[high.to].mm, px: builders[high.to].px, safe1: builders[high.to].safe1, safe2: builders[high.to].safe2 };
}

/* All four sites: { elf: true|false, reason (not an ELF / why), buildId,
 * variant, sink, selfstart, res }, each edit { ok, reason } plus its
 * offsets and stock/patched values. ok is true when every edit was found. */
function locate(buf) {
    var elf = parseElf(buf);
    var none = { ok: false, reason: 'not located' };
    if (!elf.load) return { ok: false, elf: false, reason: elf.reason, buildId: null, variant: none, sink: none, selfstart: none, res: none };
    var im = new Image(buf, elf), str = {}, offs = [];
    Object.keys(NAMES).forEach(function (k) {
        str[k] = namedString(buf, NAMES[k][0], NAMES[k][1], NAMES[k][2]);
        if (!str[k].err) offs.push(str[k].off);
    });
    var refs = leaRefs(im, offs);
    var out = { elf: true, buildId: buildId(buf, elf.notes), variant: locateVariant(im), sink: locateSink(buf),
                selfstart: locateSelfstart(im, str, refs), res: locateRes(im, str, refs) };
    var failed = [out.variant, out.sink, out.selfstart, out.res].filter(function (e) { return !e.ok; });
    out.ok = failed.length === 0;
    if (failed.length) out.reason = failed.map(function (e) { return e.reason; }).join('; ');
    return out;
}

module.exports = { locate: locate, SINK_STOCK: SINK_STOCK };
