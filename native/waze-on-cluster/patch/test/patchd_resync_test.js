#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Proves patchd's stream resync (PATCH.md "Stream resync") against a fake
 * systemctl and a dummy carplay process: no restart while the render's
 * keyframe wait is under the threshold, while its report is stale, a link or
 * a FIFO, or while recmgr did not load a carplay restart entry; past it,
 * SIGKILL the main PID and systemctl start (never restart/stop), without the
 * app seeing a busy patch state; later attempts spaced by the configured
 * steps, the counts surviving a patchd restart, the spacing reset after a
 * calm spell, and no attempt past the per-boot limit.
 *
 *   node patchd_resync_test.js
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var net = require('net');
var cp = require('child_process');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-resync-'));
var children = [];
process.on('exit', function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    try { cp.execFileSync('rm', ['-rf', dir]); } catch (e) {}
});

var BIN = path.join(dir, 'bin');
fs.mkdirSync(BIN);
var SYSTEMD = path.join(dir, 'systemd.json');
var CALLS = path.join(dir, 'systemctl.calls');
fs.writeFileSync(CALLS, '');
fs.writeFileSync(path.join(BIN, 'systemctl'), '#!' + process.execPath + '\n' + [
    "var fs = require('fs');",
    "var ST = " + JSON.stringify(SYSTEMD) + ";",
    "var st = JSON.parse(fs.readFileSync(ST, 'utf8'));",
    "var a = process.argv.slice(2);",
    "fs.appendFileSync(" + JSON.stringify(CALLS) + ", a.join(' ') + '\\n');",
    "if (a[0] === 'start' && st.slow) { var t = Date.now(); while (Date.now() - t < 1500) {} }",
    "if (a[0] === 'show') process.stdout.write(st.pid + '\\n');",
    "else if (a[0] === 'is-active') process.stdout.write('active\\n');",
].join('\n') + '\n');
fs.chmodSync(path.join(BIN, 'systemctl'), 0o755);
fs.writeFileSync(path.join(BIN, 'journalctl'), '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(BIN, 'journalctl'), 0o755);

var RECMGR = path.join(dir, 'recmgr-restartlist.conf');
var PROC_STAT = path.join(dir, 'stat');
var BOOT_S = Math.floor(Date.now() / 1000) - 60;
fs.writeFileSync(PROC_STAT, 'cpu  1 2 3\nbtime ' + BOOT_S + '\n');
function setRecmgr(names) {
    fs.writeFileSync(RECMGR, '[Whitelist]\n' + names.join('\n') + '\n[WhitelistExitSuccess]\n' + names.join('\n') + '\n');
    fs.utimesSync(RECMGR, BOOT_S - 3600, BOOT_S - 3600);   /* loaded at boot */
}
var TGT = path.join(dir, 'carplay');
fs.writeFileSync(TGT, 'not a carplay binary');
var RESYNC = path.join(dir, 'resync.json');
var SOCK = null;
var STREAM = path.join(dir, 'stream.json');

/* The render's report, fresh unless age_s is given. */
function report(waitMs, ageS) {
    fs.writeFileSync(STREAM, JSON.stringify({ keyframe_wait_ms: waitMs }) + '\n');
    if (ageS) { var t = Date.now() / 1000 - ageS; fs.utimesSync(STREAM, t, t); }
}
/* Keeps the report fresh, as the render does each second. */
var reporting = null;
function keepReporting(waitMs) {
    if (reporting) clearInterval(reporting);
    report(waitMs);
    reporting = setInterval(function () { report(waitMs); }, 200);
}
function stopReporting() { if (reporting) clearInterval(reporting); reporting = null; }

function dummyCarplay(slow) {
    var c = cp.spawn(process.execPath, ['-e', 'setInterval(function () {}, 1e6)'], { stdio: 'ignore' });
    children.push(c);
    c.on('exit', function (code, signal) { c.exitSignal = signal || code; });
    fs.writeFileSync(SYSTEMD, JSON.stringify({ pid: c.pid, slow: !!slow }));
    return c;
}
var seen = 0;
function newCalls() {
    var all = fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean);
    var fresh = all.slice(seen);
    seen = all.length;
    return fresh;
}
var patchdLog = '';
/* Each run on a fresh socket directory (patchd creates it, as root on the
 * unit) and the one resync record. */
var runs = 0;
function startPatchd() {
    SOCK = path.join(dir, 'sock' + ++runs, 'patch.sock');
    var p = cp.spawn(process.execPath, [PATCHD], {
        env: Object.assign({}, process.env, {
            PATH: BIN + path.delimiter + process.env.PATH,
            WOC_PATCH_SOCK: SOCK,
            WOC_CARPLAY: TGT,
            WOC_STREAM_STATE: STREAM,
            WOC_RESYNC_FILE: RESYNC,
            WOC_RESYNC_POLL_MS: '50',
            WOC_RESYNC_AFTER_MS: '1000',
            WOC_RESYNC_SPACING_MS: '1500,3000',
            WOC_RESYNC_RESET_MS: '1500',
            WOC_RESYNC_MAX: '4',
            WOC_RESTART_POLL_MS: '20',
            WOC_RECMGR_CONF: RECMGR,
            WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
            WOC_PROC_STAT: PROC_STAT,
            WOC_BOOT_ID: path.join(dir, 'no-boot-id'),
            WOC_MOUNT: path.join(dir, 'no-mount'),
            WOC_PROC_MOUNTS: path.join(dir, 'no-mounts'),
            WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
            WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'),
            WOC_DLT_RETRY_MS: '600000',
            WOC_REMOUNT_LOCK: path.join(dir, 'remount.lock'),
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.on('data', function (d) { patchdLog += d; });
    p.stderr.on('data', function (d) { patchdLog += d; });
    children.push(p);
    p.exited = new Promise(function (r) { p.on('exit', r); });
    return p;
}
/* Polls cond every 50 ms for up to ms; resolves to its last value. */
async function waitFor(cond, ms) {
    for (var t = 0; t < ms && !cond(); t += 50) await sleep(50);
    return cond();
}
function died(c) { return c.exitSignal !== undefined; }
function readResync() { return JSON.parse(fs.readFileSync(RESYNC, 'utf8')); }
function restarts(calls) { return calls.filter(function (c) { return c === 'start carplay.service'; }).length; }
function neverRestartStop(calls) { return !calls.some(function (c) { return /^(restart|stop) /.test(c); }); }

/* Every status event patchd broadcasts, from a client kept connected. */
var statuses = [];
function watchStatus() {
    var c = net.connect(SOCK), buf = '';
    c.setEncoding('utf8');
    c.on('error', function () {});
    c.on('data', function (d) {
        buf += d;
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
            var m = JSON.parse(buf.slice(0, i));
            buf = buf.slice(i + 1);
            if (m.ev === 'status') statuses.push(m);
        }
    });
    return c;
}

async function main() {
    setRecmgr(['carplay']);
    var carplay = dummyCarplay();
    var patchd = startPatchd();
    await waitFor(function () { return fs.existsSync(SOCK); }, 5000);
    var watcher = watchStatus();

    keepReporting(500);
    await sleep(800);
    ok('under the threshold: no restart', newCalls().length === 0);
    ok('during a wait the record says patchd decided a resync would go',
       readResync().waiting === true && readResync().held === null, JSON.stringify(readResync()));

    stopReporting();
    report(5000, 30);
    await sleep(600);
    ok('a stale report (the render not running): no restart', newCalls().length === 0);

    var real = path.join(dir, 'elsewhere.json');
    fs.writeFileSync(real, JSON.stringify({ keyframe_wait_ms: 5000 }) + '\n');
    fs.unlinkSync(STREAM);
    fs.symlinkSync(real, STREAM);
    await sleep(600);
    ok('a report that is a link is not followed: no restart', newCalls().length === 0);
    fs.unlinkSync(STREAM);
    cp.execFileSync('mkfifo', [STREAM]);
    await sleep(600);
    var answered = await new Promise(function (resolve) {
        var c = net.connect(SOCK), t = setTimeout(function () { c.destroy(); resolve(false); }, 3000);
        c.on('data', function () { clearTimeout(t); c.destroy(); resolve(true); });
        c.on('error', function () { resolve(false); });
    });
    ok('a report that is a FIFO neither blocks patchd nor restarts', answered && newCalls().length === 0);
    fs.unlinkSync(STREAM);

    keepReporting(5000);
    var calls = [];
    await waitFor(function () { calls = calls.concat(newCalls()); return calls.indexOf('is-active carplay.service') >= 0; }, 4000);
    ok('past the threshold: carplay SIGKILLed', carplay.exitSignal === 'SIGKILL', carplay.exitSignal);
    ok('then systemctl start, confirmed active', restarts(calls) === 1 && calls.indexOf('is-active carplay.service') >= 0, calls.join(' | '));
    ok('never systemctl restart or stop', neverRestartStop(calls), calls.join(' | '));
    var saved = readResync();
    ok('the attempt is recorded', saved.attempts === 1 && saved.total === 1, JSON.stringify(saved));

    /* Spacing is checked on the times patchd recorded for its attempts, so a
     * slow machine only lengthens the gaps. */
    carplay = dummyCarplay();
    calls = [];
    await waitFor(function () { calls = calls.concat(newCalls()); return died(carplay) && restarts(calls) >= 1; }, 6000);
    var second = readResync();
    ok('the next attempt waits its spacing (1.5 s), then restarts (attempt 2)', carplay.exitSignal === 'SIGKILL' && restarts(calls) === 1 &&
       second.attempts === 2 && second.last - saved.last >= 1500, JSON.stringify([saved, second]));

    /* A patchd restart keeps the counts: attempt 3 waits the second step (3 s). */
    carplay = dummyCarplay();
    watcher.destroy();
    patchd.kill('SIGTERM');
    await patchd.exited;
    patchd = startPatchd();
    await waitFor(function () { return fs.existsSync(SOCK); }, 5000);
    watcher = watchStatus();
    calls = [];
    await waitFor(function () { calls = calls.concat(newCalls()); return died(carplay) && restarts(calls) >= 1; }, 8000);
    var third = readResync();
    ok('after a patchd restart the counts are kept: attempt 3 waits the 3 s step, then restarts',
       carplay.exitSignal === 'SIGKILL' && restarts(calls) === 1 && third.attempts === 3 && third.total === 3 &&
       third.last - second.last >= 3000, JSON.stringify([second, third]));

    /* A calm spell resets the spacing: the next incident restarts at once. */
    carplay = dummyCarplay();
    keepReporting(0);
    await waitFor(function () { return /spacing back to its first step/.test(patchdLog); }, 8000);
    var rec = JSON.parse(fs.readFileSync(RESYNC, 'utf8'));
    ok('no wait for the reset time sets the spacing back, the total kept', rec.attempts === 0 && rec.total === 3, JSON.stringify(rec));
    keepReporting(5000);
    calls = [];
    await waitFor(function () { calls = calls.concat(newCalls()); return died(carplay) && restarts(calls) >= 1; }, 6000);
    var fourth = readResync();
    ok('the next incident restarts at the first step (attempt 4 of 4)', carplay.exitSignal === 'SIGKILL' && restarts(calls) === 1 &&
       fourth.attempts === 1 && fourth.total === 4, JSON.stringify(fourth));

    /* The per-boot limit: no fifth attempt, whatever the spacing. */
    carplay = dummyCarplay();
    await waitFor(function () { return /resync held: 4 attempts/.test(patchdLog); }, 6000);
    ok('past the limit a due resync is held', restarts(newCalls()) === 0 && !died(carplay) && /resync held: 4 attempts/.test(patchdLog));
    ok('the record says why, for the render', readResync().held === '4 attempts this head-unit start', JSON.stringify(readResync()));

    /* Without carplay's recmgr entry, a due resync is held, never forced; a
     * previous process's reason is gone at start. */
    fs.writeFileSync(RESYNC, JSON.stringify({ waiting: true, held: 'from before', attempts: 0, last: null, total: 0 }) + '\n');
    watcher.destroy();
    patchd.kill('SIGTERM');
    await patchd.exited;
    setRecmgr(['someone-else']);
    keepReporting(0);
    patchd = startPatchd();
    await waitFor(function () { return fs.existsSync(SOCK) && readResync().held !== 'from before'; }, 5000);
    ok('a restarted patchd drops the previous decision', readResync().waiting === false && readResync().held === null,
       JSON.stringify(readResync()));
    keepReporting(500);
    await waitFor(function () { return readResync().held !== null; }, 3000);
    ok('the hold is decided while the wait is under the threshold', newCalls().length === 0 &&
       readResync().waiting === true && readResync().held === 'recmgr did not load a carplay restart entry this boot',
       JSON.stringify(readResync()));
    keepReporting(5000);
    await waitFor(function () { return /resync held: recmgr/.test(patchdLog); }, 6000);
    ok('no recmgr entry: held, carplay left running', restarts(newCalls()) === 0 && !died(carplay) && /resync held: recmgr/.test(patchdLog));
    ok('the record says why', readResync().held === 'recmgr did not load a carplay restart entry this boot', JSON.stringify(readResync()));
    keepReporting(0);
    await waitFor(function () { return readResync().held === null; }, 3000);
    ok('a stream that decodes again clears both', readResync().waiting === false && readResync().held === null,
       JSON.stringify(readResync()));

    ok('the app never saw a busy patch state for a resync', !statuses.some(function (m) { return m.state === 'busy'; }),
       JSON.stringify(statuses.filter(function (m) { return m.state === 'busy'; })));

    /* An apply pressed during a resync is refused as busy, and the real state
     * follows once the resync ends. */
    keepReporting(0);
    patchd.kill('SIGTERM');
    await patchd.exited;
    fs.writeFileSync(RESYNC, JSON.stringify({ attempts: 0, last: null, total: 0 }) + '\n');
    setRecmgr(['carplay']);
    try { process.kill(carplay.pid, 'SIGKILL'); } catch (e) {}
    carplay = dummyCarplay(true);
    patchd = startPatchd();
    await waitFor(function () { return fs.existsSync(SOCK); }, 5000);
    watcher = watchStatus();
    var asker = net.connect(SOCK);
    asker.on('error', function () {});
    await sleep(1500);   /* the statuses each connection brings are in */
    statuses = [];
    patchdLog = '';
    keepReporting(5000);
    await waitFor(function () { return died(carplay); }, 3000);
    asker.write(JSON.stringify({ cmd: 'apply', panel: 'high', mode: 'avb' }) + '\n');
    var refused = await waitFor(function () {
        return statuses.some(function (m) { return m.state === 'busy' && m.reason === 'another operation is running'; });
    }, 1000);
    await waitFor(function () { return /resync: carplay restarted/.test(patchdLog); }, 6000);
    var last = {};
    await waitFor(function () { last = statuses[statuses.length - 1] || {}; return last.state && last.state !== 'busy'; }, 5000);
    asker.destroy();
    ok('an apply during a resync is refused as busy', refused);
    ok('and the real state follows when the resync ends', last.state && last.state !== 'busy', JSON.stringify(last));
    ok('the refused apply ran nothing', patchdLog.indexOf('apply IC_') < 0 && !statuses.some(function (m) { return m.reason === 'applying'; }));

    stopReporting();
    watcher.destroy();
    patchd.kill('SIGTERM');
    await patchd.exited;
    ok('never systemctl restart or stop, over the whole run', neverRestartStop(fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean)));
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all ok\n');
    process.exit(fails ? 1 : 0);
}

main().catch(function (e) { process.stdout.write('FAIL ' + e.stack + '\n'); process.exit(1); });
