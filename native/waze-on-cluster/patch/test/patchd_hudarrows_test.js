#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* patchd's HUD arrows option ({"cmd":"hud-arrows"}, README.md "HUD arrows",
 * experimental): off by default, nothing on disk and no safe area of its
 * own; on writes its file and reports the option's safe area, off removes
 * it; the hudguide service is started or stopped only once recmgr loaded
 * its entry this boot; on is refused on a cluster not coded
 * KI_KOMBI_VARIANT 7 (the file not written), off never. With CARPLAY_BIN (a
 * copy of the unit's /usr/bin/carplay): Patch writes the patcher's safe area
 * while the option is off and the option's while it is on, and the option
 * changed while patched writes the patch again with the other, for the next
 * head-unit start (carplay not in recmgr's list: never restarted).
 *
 *   node patchd_hudarrows_test.js
 */
'use strict';

require('./head_unit_env.js');   /* a HIGH head unit */

var cp = require('child_process');
var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');
var ap = require('../aapd_patch.js');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var SRC = process.env.CARPLAY_BIN || '';
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-hudarrows-'));
var children = [];
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    try { cp.execFileSync('rm', ['-rf', dir]); } catch (e) {}
});

var SOCK = path.join(dir, 'sock', 'patch.sock');
var STATE = path.join(dir, 'var');
var FILE = path.join(STATE, 'hud-arrows');
var CODING = path.join(dir, 'coding');
var RECMGR = path.join(dir, 'recmgr.conf');
var CALLS = path.join(dir, 'calls');
var TGT = path.join(dir, 'carplay');
var MOUNTS = path.join(dir, 'mounts');
var MOUNT = path.join(dir, 'mount');
var BIN = path.join(dir, 'bin');
var SAFE_ON = '504x228+286+72', SAFE_OFF = '504x368+286+72';
var BOOT_S = Math.floor(Date.now() / 1000) - 60;

fs.mkdirSync(BIN);
fs.mkdirSync(STATE);
fs.mkdirSync(path.join(dir, 'proc'));
fs.writeFileSync(CALLS, '');
fs.writeFileSync(path.join(dir, 'stat'), 'btime ' + BOOT_S + '\n');
fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
fs.writeFileSync(MOUNT, '#!' + process.execPath + '\n' + [
    "var fs = require('fs'), a = process.argv.slice(2).join(' '), M = " + JSON.stringify(MOUNTS) + ";",
    "fs.writeFileSync(M, '/dev/root / ext4 ' + (/remount,rw/.test(a) ? 'rw' : 'ro') + ' 0 0\\n');",
].join('\n') + '\n');
fs.chmodSync(MOUNT, 0o755);
/* systemctl: every call recorded; show reports carplay without our drop-in */
fs.writeFileSync(path.join(BIN, 'systemctl'), '#!' + process.execPath + '\n' + [
    "var fs = require('fs'), a = process.argv.slice(2);",
    "fs.appendFileSync(" + JSON.stringify(CALLS) + ", a.join(' ') + '\\n');",
    "if (a[0] === 'show') process.stdout.write('MainPID=0\\nInvocationID=\\nExecMainStartTimestampMonotonic=0\\nDropInPaths=\\n');",
].join('\n') + '\n');
fs.chmodSync(path.join(BIN, 'systemctl'), 0o755);
fs.writeFileSync(path.join(BIN, 'journalctl'), '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(BIN, 'journalctl'), 0o755);
if (fs.existsSync(SRC)) fs.writeFileSync(TGT, fs.readFileSync(SRC), { mode: 0o755 });

/* A coding image with KI_KOMBI_VARIANT v (flags 0x09: valid). */
function coding(v) {
    var b = Buffer.alloc(ap.CODING.size);
    b[ap.CODING.flags] = 0x09;
    b[ap.CODING.at] = (v << ap.CODING.shift) | 0x01;
    fs.writeFileSync(CODING, b);
}
/* recmgr's restart list; loaded: dated before the boot, as recmgr read it. */
function recmgr(names, loaded) {
    fs.writeFileSync(RECMGR, '[Whitelist]\n' + names.join('\n') + '\n[WhitelistExitSuccess]\n' + names.join('\n') + '\n');
    var at = loaded ? BOOT_S - 3600 : BOOT_S + 30;
    fs.utimesSync(RECMGR, at, at);
}
var seen = 0;
function newCalls() {
    var all = fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean);
    var fresh = all.slice(seen);
    seen = all.length;
    return fresh.filter(function (l) { return /hudguide/.test(l); });
}

coding(7);
recmgr(['carplay-not-listed'], true);
var out = '';
var p = cp.spawn(process.execPath, [PATCHD], {
    env: Object.assign({}, process.env, {
        PATH: BIN + path.delimiter + process.env.PATH,
        WOC_PATCH_SOCK: SOCK,
        WOC_PATCH_GROUP: '',
        WOC_STATE_DIR: STATE,
        WOC_CODING: CODING,
        WOC_CARPLAY: TGT,
        WOC_MOUNT: MOUNT,
        WOC_PROC_MOUNTS: MOUNTS,
        WOC_PROC: path.join(dir, 'proc'),
        WOC_RECMGR_CONF: RECMGR,
        WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
        WOC_PROC_STAT: path.join(dir, 'stat'),
        WOC_BOOT_ID: path.join(dir, 'no-boot-id'),
        WOC_CARPLAY_DROPIN: path.join(dir, 'dropin.conf'),
        WOC_STREAM_STATE: path.join(dir, 'no-stream.json'),
        WOC_RESYNC_FILE: path.join(dir, 'resync.json'),
        WOC_LOCAL_CONF: path.join(dir, 'local.conf'),
        WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
        WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'),
        WOC_DLT_RETRY_MS: '600000',
        WOC_REMOUNT_LOCK: path.join(dir, 'sock', 'remount.lock'),
        WOC_REBOOT_CMD: path.join(dir, 'no-reboot'),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(p);
p.stdout.on('data', function (d) { out += d; });
p.stderr.on('data', function (d) { out += d; });

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* Connects, sends cmd once the first status came (none: only that status),
 * resolves to the first status or refusal done(msg) accepts. */
function session(cmd, done) {
    return new Promise(function (resolve, reject) {
        var c = net.connect(SOCK), buf = '', sent = !cmd;
        var timer = setTimeout(function () { c.destroy(); reject(new Error('timed out on ' + JSON.stringify(cmd))); }, 30000);
        c.setEncoding('utf8');
        c.on('error', reject);
        c.on('data', function (d) {
            buf += d;
            var i;
            while ((i = buf.indexOf('\n')) >= 0) {
                var m = JSON.parse(buf.slice(0, i));
                buf = buf.slice(i + 1);
                if (m.ev !== 'status' && m.ev !== 'refused') continue;
                if (!sent) { sent = true; c.write(JSON.stringify(cmd) + '\n'); continue; }
                if (done(m)) { clearTimeout(timer); c.destroy(); resolve(m); return; }
            }
        });
    });
}
function status() { return session(null, function (m) { return m.ev === 'status' && m.state !== 'busy' && !m.busy; }); }
function arrows(on) { return session({ cmd: 'hud-arrows', on: on }, function (m) { return m.ev === 'refused' || (m.state !== 'busy' && !m.busy); }); }
function apply() { return session({ cmd: 'apply', panel: 'high', mode: 'avb' }, function (m) { return m.state === 'error' || m.carplay === 'deferred' || m.carplay === 'restarted'; }); }

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (cond || detail === undefined ? '' : '  — ' + detail) + '\n');
    if (!cond) fails++;
}

async function main() {
    for (var t = 0; t < 5000 && !fs.existsSync(SOCK); t += 50) await sleep(50);
    var r = await status();
    ok('off by default: no file, no safe area of its own, nothing refused', !fs.existsSync(FILE) &&
        JSON.stringify(r.hudArrows) === JSON.stringify({ on: false, safe: null, conflict: null }), JSON.stringify(r.hudArrows));

    r = await arrows(1);
    ok('on: the file written, the option\'s safe area reported', fs.existsSync(FILE) && r.hudArrows.on === true &&
        r.hudArrows.safe === SAFE_ON, JSON.stringify(r));
    ok('on, recmgr without its entry: hudguide not started now', newCalls().length === 0 &&
        /hudguide\.service starts at the next head-unit start/.test(out));
    r = await arrows(0);
    ok('off: the file removed, no safe area', !fs.existsSync(FILE) && r.hudArrows.on === false && r.hudArrows.safe === null, JSON.stringify(r));

    recmgr(['waze-on-cluster-hudguide'], true);
    await arrows(1);
    for (var i = 0; i < 40 && !/started/.test(out); i++) await sleep(50);
    ok('on, recmgr loaded its entry: hudguide started', JSON.stringify(newCalls()) === JSON.stringify(['start waze-on-cluster-hudguide.service']));
    await arrows(0);
    for (i = 0; i < 40 && !/stopped/.test(out); i++) await sleep(50);
    ok('off: hudguide stopped', JSON.stringify(newCalls()) === JSON.stringify(['stop waze-on-cluster-hudguide.service']));
    recmgr(['waze-on-cluster-hudguide'], false);
    await arrows(1);
    await arrows(0);
    await sleep(200);
    ok('recmgr\'s list written after the boot: hudguide neither started nor stopped', newCalls().length === 0);

    r = await arrows(2);
    ok('an on that is not 0 or 1 is refused', r.ev === 'refused' && /0 or 1/.test(r.reason), JSON.stringify(r));

    coding(9);
    r = await status();
    ok('KI_KOMBI_VARIANT 9: the conflict reported', r.hudArrows.conflict === 'not supported on this car (KI_KOMBI_VARIANT 9)' &&
        r.hudArrows.on === false, JSON.stringify(r.hudArrows));
    r = await arrows(1);
    ok('KI_KOMBI_VARIANT 9: on refused, no file', r.ev === 'refused' && /KI_KOMBI_VARIANT 9/.test(r.reason) && !fs.existsSync(FILE), JSON.stringify(r));
    fs.writeFileSync(FILE, 'on\n');
    r = await status();
    ok('KI_KOMBI_VARIANT 9 with the file left on: no safe area of its own', r.hudArrows.on === true && r.hudArrows.safe === null, JSON.stringify(r.hudArrows));
    r = await arrows(0);
    ok('KI_KOMBI_VARIANT 9: off taken', r.ev === 'status' && !fs.existsSync(FILE), JSON.stringify(r));
    fs.unlinkSync(CODING);
    r = await status();
    ok('the coding unreadable: refused as not supported', /^not supported on this car \(the cluster coding cannot be read/.test(r.hudArrows.conflict || ''),
        JSON.stringify(r.hudArrows));
    coding(7);

    if (!fs.existsSync(SRC)) {
        process.stdout.write('SKIP the patch\'s safe area: set CARPLAY_BIN to a copy of the unit\'s /usr/bin/carplay (carplay 22.28.3)\n');
    } else {
        r = await apply();
        r = await status();
        ok('Patch with the option off: the patcher\'s safe area, for the next head-unit start', r.pending === 'apply' && r.safe === SAFE_OFF,
            JSON.stringify(r));
        r = await arrows(1);
        r = await status();
        ok('on while patched: written again with the option\'s, for the next head-unit start', r.safe === SAFE_ON && r.pending === 'apply' &&
            /--safe 504x228\+286\+72|safe area 504x228\+286\+72/.test(out), JSON.stringify(r));
        r = await arrows(0);
        r = await status();
        ok('off while patched: back to the patcher\'s', r.safe === SAFE_OFF, JSON.stringify(r));
        ok('carplay never started, stopped or restarted', !/(start|stop|restart) carplay/.test(fs.readFileSync(CALLS, 'utf8')));
    }
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
}
main().catch(function (e) { process.stdout.write('FAIL ' + e.stack + '\n' + out); process.exit(1); });
