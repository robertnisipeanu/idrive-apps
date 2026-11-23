// SPDX-License-Identifier: GPL-3.0-or-later
// The global CarPlay guidance-area choice. Node 8, no dependencies.
'use strict';
var fs = require('fs');
var path = require('path');
var AREAS = { standard: '504x368+286+72', yandex: '504x368+433+72' };
function file(dir) { return path.join(dir, 'carplay-safearea'); }
function read(dir) {
    try { return fs.readFileSync(file(dir), 'utf8').trim() === 'yandex' ? 'yandex' : 'standard'; }
    catch (e) { return 'standard'; }
}
function supported(args) {
    if (!Array.isArray(args)) return false;
    var panel = args.indexOf('--panel'), res = args.indexOf('--res');
    return panel >= 0 && args[panel + 1] === 'high' && (res < 0 || args[res + 1] === '1088x480');
}
/* Preserve all other arguments, including the sink and trial/coding flags. */
function withArea(args, area) {
    var out = [];
    for (var i = 0; i < args.length; i++) {
        if (args[i] === '--safe') { i++; continue; }
        out.push(args[i]);
    }
    return out.concat(['--safe', AREAS[area]]);
}
/* An explicit saved choice wins over an older plan. Without a saved choice,
 * leave custom CLI geometries and old installations exactly as they are. */
function reconcile(dir, args) {
    return fs.existsSync(file(dir)) && supported(args) ? withArea(args, read(dir)) : args;
}
module.exports = { file: file, read: read, supported: supported, withArea: withArea, reconcile: reconcile };
