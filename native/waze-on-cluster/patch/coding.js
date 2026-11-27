// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* coding.js — cluster coding reader (/dev/shm/rawcodingdata) shared by
 * carplay_patch.js, aapd_patch.js, recovery.js, patchd.js and logs_extra.js.
 *
 * /dev/shm/rawcodingdata, published by CodingShmApp: a 0x2c byte header
 * (flags at 0x28, 0x09 = valid coding) and the coding blocks. CodingKOMBI_HUD
 * is the 150 bytes at block offset 0x75a; KI_KOMBI_VARIANT is
 * getBits(0, 0x7e, 1) of it.
 *
 * Node 8 on the unit, no dependencies. */
'use strict';

var fs = require('fs');

var CODING = { size: 0x1030, flags: 0x28, valid: 0x09, at: 0x2c + 0x75a, mask: 0x7e, shift: 1, want: 7 };
var BUILT_IN = [9, 10];

/* {variant} or {err}. */
function readCoding(p) {
    var b = null;
    try { b = fs.readFileSync(p); } catch (e) {}
    if (!b) return { err: p + ' unreadable' };
    if (b.length !== CODING.size) return { err: p + ' is ' + b.length + ' bytes, not ' + CODING.size };
    if ((b[CODING.flags] & 0x0f) !== CODING.valid) return { err: 'coding not valid (flags 0x' + b[CODING.flags].toString(16) + ')' };
    return { variant: (b[CODING.at] & CODING.mask) >> CODING.shift };
}

/* Why the patch is not for a coding readCoding read ({variant} or {err}),
 * or null. KI_KOMBI_VARIANT 7 is the supported cluster; 9 and 10 stream the
 * map natively; 0 codes no cluster display; an unreadable coding is planned
 * as 7 on trial. */
function codingRefusal(cd) {
    if (cd.err || cd.variant === CODING.want) return null;
    return cd.variant === 0 ? 'not supported on this car (KI_KOMBI_VARIANT 0: no cluster display is coded)'
        : BUILT_IN.indexOf(cd.variant) >= 0 ? 'built in on this cluster (KI_KOMBI_VARIANT ' + cd.variant + ': CarPlay and Android Auto stream the cluster map themselves)'
        : 'not supported on this cluster (KI_KOMBI_VARIANT ' + cd.variant + '; the map is made for KI_KOMBI_VARIANT ' + CODING.want + ')';
}

module.exports = { CODING: CODING, BUILT_IN: BUILT_IN, readCoding: readCoding, codingRefusal: codingRefusal };
