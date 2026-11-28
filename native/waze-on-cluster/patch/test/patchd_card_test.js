#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/* Proves that CarPlay's patch in memory follows the turn card, on a
 * synthetic carplay (synthetic_carplay.js): with the card off, the plan's
 * ShowUI URL asks for the arrival-time card, as before; patchd's
 * {"cmd":"turn-card"} plans it again with the map alone while the card
 * shows (bottom or top) and with the arrival-time card once it is off, and
 * stays proven. Where patchd may restart carplay it does (SIGKILL, start),
 * and carplay then runs the new plan; where it may not, carplay is left
 * running the plan as it started, which counts as patched with nothing
 * pending, and its next start is armed with the new one. A change the plan
 * already has plans nothing; a patch that is off is left alone; the install
 * hook plans the URL the card asks for and never restarts carplay; the
 * Patch button and boot recovery plan that URL too. Runs the real patchd.js
 * and carplay_patch.js with the fakes patchd_patch_test.js uses
 * (systemctl, mount, recmgr list and /proc: carplay_proc.js).
 *
 *   node patchd_card_test.js
 */
'use strict';

var car = require('./head_unit_env.js');   /* a HIGH head unit, coded KI_KOMBI_VARIANT 7 */
var carplayProc = require('./carplay_proc.js');
var synthetic = require('./synthetic_carplay.js');

var fs = require('fs');
var net = require('net');
var path = require('path');
var tmp = require('./tmp.js');
var cp = require('child_process');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var locator = require('../carplay_locate.js');

var fails = 0;
function ok(name, cond, detail) {
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined && !cond ? '  — ' + detail : '') + '\n');
    if (!cond) fails++;
}

var dir = tmp.dir();
var SRCBUF = synthetic.build({}).buf;
var TGT = path.join(dir, 'carplay');
var DROPIN = path.join(dir, 'carplay.service.d', '50-waze-on-cluster.conf');
var SYSTEMD = path.join(dir, 'systemd.json');
var CALLS = path.join(dir, 'systemctl.calls');
var MOUNTS = path.join(dir, 'mounts');
var MOUNT_CALLS = path.join(dir, 'mount.calls');
var RECMGR = path.join(dir, 'recmgr-restartlist.conf');
var PROC_STAT = path.join(dir, 'stat');
var STATE = path.join(dir, 'var');
var RUN = path.join(dir, 'run');
var LIB = path.join(dir, 'libwocpatch.so');
var PASSWD = path.join(dir, 'passwd');
var PENDING = path.join(dir, 'sock', 'activation-pending');
var CARD = path.join(dir, 'turn-card.state.conf');
process.env.WOC_TURN_CARD_STATE = CARD;
var cpp = require('../carplay_patch.js');
var BOOT_S = Math.floor(Date.now() / 1000) - 60;
fs.writeFileSync(TGT, SRCBUF, { mode: 0o755 });
fs.writeFileSync(PROC_STAT, 'cpu  1 2 3\nbtime ' + BOOT_S + '\n');
fs.writeFileSync(LIB, 'a stand-in for libwocpatch.so\n');
fs.writeFileSync(PASSWD, 'root:x:0:0::/:/bin/sh\ncia_13002:x:13002:13002::/:/bin/false\n');
fs.writeFileSync(CALLS, '');
fs.writeFileSync(MOUNT_CALLS, '');
fs.writeFileSync(MOUNTS, '/dev/root / ext4 ro 0 0\n');
function setRecmgr(names) {
    fs.writeFileSync(RECMGR, '[Whitelist]\n' + names.join('\n') + '\n[WhitelistExitSuccess]\n' + names.join('\n') + '\n');
    fs.utimesSync(RECMGR, BOOT_S - 3600, BOOT_S - 3600);
}
var BIN = path.join(dir, 'bin');
fs.mkdirSync(BIN);
var PROC = path.join(dir, 'proc');
fs.mkdirSync(PROC);
var HELPER = path.join(__dirname, 'carplay_proc.js');

/* systemctl as patchd_patch_test.js fakes it: each call recorded, a start
 * runs carplay from the file on disk, armed when this boot's env file is
 * there; restart and stop do nothing (and must never come). */
fs.writeFileSync(path.join(BIN, 'systemctl'), '#!' + process.execPath + '\n' + [
    "var fs = require('fs'), proc = require(" + JSON.stringify(HELPER) + ");",
    "var P = " + JSON.stringify(PROC) + ", T = " + JSON.stringify(TGT) + ", RUN = " + JSON.stringify(RUN) + ", ST = " + JSON.stringify(SYSTEMD) + ";",
    "var st = JSON.parse(fs.readFileSync(ST, 'utf8')), a = process.argv.slice(2);",
    "fs.appendFileSync(" + JSON.stringify(CALLS) + ", a.join(' ') + '\\n');",
    "if (a[0] === 'show' && a.indexOf('DropInPaths') >= 0) process.stdout.write('DropInPaths=' + " + JSON.stringify(DROPIN) + " + '\\n');",
    "else if (a[0] === 'show' && (a.indexOf('Environment') >= 0 || a.indexOf('User') >= 0)) {",
    "    if (a.indexOf('Environment') >= 0) process.stdout.write('Environment=LD_PRELOAD=/usr/lib/libschedconfig.so.1\\n');",
    "    if (a.indexOf('User') >= 0) process.stdout.write('User=cia_13002\\n');",
    "}",
    "else if (a[0] === 'show') process.stdout.write('MainPID=' + st.pid + '\\nInvocationID=inv-' + st.pid + '\\nExecMainStartTimestampMonotonic=5\\n');",
    "else if (a[0] === 'start') proc.start(P, st.pid, T, RUN);",
    "else if (a[0] === 'is-active') process.stdout.write('active\\n');",
].join('\n') + '\n');
fs.chmodSync(path.join(BIN, 'systemctl'), 0o755);
fs.writeFileSync(path.join(BIN, 'journalctl'), '#!/bin/sh\nexit 0\n');
fs.chmodSync(path.join(BIN, 'journalctl'), 0o755);
var MOUNT = path.join(dir, 'mount');
fs.writeFileSync(MOUNT, '#!/bin/sh\necho "$*" >> "' + MOUNT_CALLS + '"\n');
fs.chmodSync(MOUNT, 0o755);

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
/* A dummy carplay main process; .died resolves to the signal that ended it. */
function dummyCarplay() {
    var c = cp.spawn(process.execPath, ['-e', 'setInterval(function () {}, 1e6)'], { stdio: 'ignore' });
    c.died = new Promise(function (r) { c.on('exit', function (code, signal) { r(signal || code); }); });
    return c;
}
function setUnit(pid) { fs.writeFileSync(SYSTEMD, JSON.stringify({ pid: pid })); }
/* The next head-unit start: /dev/shm empty, the enabled patch armed (as the
 * boot step left it), carplay started. */
function nextStart() {
    try { fs.unlinkSync(PENDING); } catch (e) {}
    return carplayProc.start(PROC, JSON.parse(fs.readFileSync(SYSTEMD, 'utf8')).pid, TGT, RUN);
}
var callsSeen = 0;
/* systemctl's calls since the last look that would start, stop or kill
 * carplay: every call but the reads (show, and boot recovery's
 * is-system-running). */
function changes() {
    var all = fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean), fresh = all.slice(callsSeen);
    callsSeen = all.length;
    return fresh.filter(function (l) { return !/^(show |is-system-running$)/.test(l); });
}
function record() { try { return JSON.parse(fs.readFileSync(path.join(STATE, 'inmem-carplay.json'), 'utf8')); } catch (e) { return null; } }
function planText() { try { return fs.readFileSync(path.join(STATE, 'inmem-carplay.plan'), 'utf8'); } catch (e) { return null; } }
/* The form of the ShowUI URL's log text the plan writes: 'eta', 'map' or
 * what it holds. */
function planForm(text) {
    var l = (text || '').split('\n').filter(function (x) { return /^edit showui-1 /.test(x); })[0];
    var w = l ? l.split(' ')[4] : null, f = locator.SHOWUI_FORMS;
    return w === f.eta ? 'eta' : w === f.map ? 'map' : w;
}
/* What carplay's memory holds at the plan's sites (inmem.js memState). */
function memAgainst(text) {
    var r = cp.spawnSync(process.execPath, ['-e', 'var i = require(' + JSON.stringify(path.join(__dirname, '..', 'inmem.js')) + ');' +
        'process.stdout.write(String(i.memState("carplay", ' + JSON.parse(fs.readFileSync(SYSTEMD, 'utf8')).pid + ', ' + JSON.stringify(text) + ')));'],
        { env: Object.assign({}, process.env, ENV), encoding: 'utf8' });
    return r.stdout;
}
function diedWithin(c) { return Promise.race([c.died, sleep(5000).then(function () { return 'still running'; })]); }
function setCard(mode) {
    if (mode === null) { try { fs.unlinkSync(CARD); } catch (e) {} return; }
    fs.writeFileSync(CARD, 'turn_card = ' + mode + '\n');
}

var SOCK = path.join(dir, 'sock', 'patch.sock');
var ENV = {
    PATH: BIN + path.delimiter + process.env.PATH,
    WOC_PATCH_SOCK: SOCK, WOC_CARPLAY: TGT, WOC_MOUNT: MOUNT, WOC_PROC_MOUNTS: MOUNTS, WOC_RESTART_POLL_MS: '20',
    WOC_RECMGR_CONF: RECMGR, WOC_CARPLAY_DROPIN: DROPIN, WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
    WOC_PROC_STAT: PROC_STAT, WOC_BOOT_ID: path.join(dir, 'no-boot-id'), WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
    WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'), WOC_DLT_RETRY_MS: '600000', WOC_REBOOT_CMD: path.join(dir, 'no-reboot'),
    WOC_STATE_DIR: STATE, WOC_PRELOAD_DIR: RUN, WOC_PRELOAD_LIB: LIB, WOC_PASSWD: PASSWD,
    WOC_REMOUNT_LOCK: path.join(dir, 'sock', 'remount.lock'), WOC_PROC: PROC, WOC_TURN_CARD_STATE: CARD,
    WOC_AAPD: path.join(dir, 'no-aapd'), WOC_AAPD_CONF: path.join(dir, 'no-aapd.conf'), WOC_LOCAL_CONF: path.join(dir, 'local.conf'),
    WOC_CAPTURE_UNIT: path.join(dir, 'no-capture.service'),
};
setUnit(0);
setRecmgr(['HBAdasMgu']);
var patchd = cp.spawn(process.execPath, [PATCHD], { env: Object.assign({}, process.env, ENV), stdio: ['ignore', 'ignore', 'inherit'] });

/* Connect, wait for the status patchd sends on connect, optionally send
 * cmd, and resolve to the first status done(msg) accepts. */
function session(cmd, done) {
    return new Promise(function (resolve, reject) {
        var c = net.connect(SOCK), buf = '', sent = !cmd;
        var timer = setTimeout(function () { c.destroy(); reject(new Error('timed out waiting on ' + JSON.stringify(cmd))); }, 30000);
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
function status() { return session(null, function (m) { return m.state !== 'busy' && m.busy !== 'carplay'; }); }
function op(cmd) { return session(cmd, function (m) { return m.state === 'error' || m.carplay === 'restarted' || m.carplay === 'deferred'; }); }
/* The turn card set to mode, then patchd told: the status once whatever it
 * started ends. */
async function card(mode) {
    setCard(mode);
    await new Promise(function (resolve, reject) {
        var c = net.connect(SOCK, function () { c.end(JSON.stringify({ cmd: 'turn-card' }) + '\n'); });
        c.resume();   /* what patchd sends goes unread, so the end comes */
        c.on('error', reject);
        c.on('close', resolve);
    });
    await sleep(300);
    return status();
}

/* The status once patchd has settled what a change started: r again until
 * it is patched with nothing pending, for up to 5 s. card()'s status can come
 * while a restart it set off is still under way on a slow machine. */
async function settled(r) {
    for (var i = 0; i < 50 && !(r.state === 'patched' && !r.pending); i++) {
        await sleep(100);
        r = await status();
    }
    return r;
}

async function main() {
    for (var i = 0; i < 200 && !fs.existsSync(SOCK); i++) await sleep(25);
    var r, rc, before, dummy;

    /* The Patch button with the card off (no choice saved): the URL with
     * the arrival-time card, the arguments earlier versions planned with.
     * patchd may not restart carplay: the change waits for the next start. */
    dummy = dummyCarplay();
    setUnit(dummy.pid);
    nextStart();
    r = await op({ cmd: 'apply', panel: 'high', mode: 'avb' });
    rc = record();
    ok('card off: the Patch button plans the ShowUI URL with the arrival-time card, no --showui', r.carplay === 'deferred' && !!rc &&
        rc.args.indexOf('--showui') < 0 && planForm(planText()) === 'eta', JSON.stringify([r, rc && rc.args, planForm(planText())]));
    nextStart();
    /* Boot recovery recorded a healthy run: the patch is proven. */
    rc = record();
    rc.proven = true; rc.trial = false;
    fs.writeFileSync(path.join(STATE, 'inmem-carplay.json'), JSON.stringify(rc) + '\n');
    r = await status();
    ok('card off: carplay runs the plan, patched, mapurl eta', r.state === 'patched' && r.mapurl === 'eta' && !r.pending && !r.carplay, JSON.stringify(r));

    /* The card on where patchd may not restart carplay (not in recmgr's
     * restart list): planned again with the map alone, carplay neither
     * restarted nor killed, nothing pending, still patched and proven;
     * carplay runs the plan it started with until its next start, which is
     * armed with the new one. */
    changes();
    var etaPlan = planText();
    r = await card('bottom');
    rc = record();
    ok('card bottom: the plan asks for the map alone (--showui map)', !!rc && rc.args.indexOf('--showui') >= 0 && rc.args[rc.args.indexOf('--showui') + 1] === 'map' &&
        planForm(planText()) === 'map' && cpp.onlyShowUiDiffers(etaPlan, planText()), JSON.stringify(rc && rc.args));
    ok('card bottom: the patch stays proven, enabled', rc.enabled === true && rc.proven === true && rc.trial === false, JSON.stringify(rc));
    ok('card bottom, no restart allowed: carplay neither started, stopped nor killed; nothing pending', changes().length === 0 && !fs.existsSync(PENDING) &&
        await Promise.race([dummy.died, sleep(300).then(function () { return 'alive'; })]) === 'alive');
    ok('card bottom: status patched, mapurl map-only, nothing waits', r.state === 'patched' && r.mapurl === 'map-only' && !r.pending && !r.carplay && !r.reason,
        JSON.stringify(r));
    ok('card bottom: carplay still runs the plan it started with; the next start is armed with the new one',
        memAgainst(etaPlan) === 'patched' && memAgainst(planText()) === 'mixed' && fs.readFileSync(path.join(RUN, 'carplay.plan'), 'utf8') === planText());

    /* At the top: the same URL, nothing planned. */
    before = fs.readFileSync(path.join(STATE, 'inmem-carplay.json'), 'utf8');
    r = await card('top');
    ok('card top: the plan has the map alone already: nothing planned', fs.readFileSync(path.join(STATE, 'inmem-carplay.json'), 'utf8') === before &&
        r.state === 'patched' && r.mapurl === 'map-only', JSON.stringify(r));

    /* The next start runs the map alone. */
    nextStart();
    r = await status();
    ok('next start: carplay runs the map alone, patched', r.state === 'patched' && r.mapurl === 'map-only' && !r.pending &&
        memAgainst(planText()) === 'patched', JSON.stringify(r));

    /* Off again where patchd may restart carplay: planned with the
     * arrival-time card, carplay restarted (SIGKILL, start) and running
     * it, still proven, nothing pending. */
    setRecmgr(['HBAdasMgu', 'carplay']);
    dummy = dummyCarplay();
    setUnit(dummy.pid);
    nextStart();
    changes();
    r = await card('off');
    rc = record();
    var restarted = changes();
    ok('card off again: the plan is the arrival-time card\'s again, no --showui, proven', rc.args.indexOf('--showui') < 0 && planText() === etaPlan &&
        rc.proven === true && rc.trial === false, JSON.stringify(rc));
    ok('card off again, restart allowed: carplay killed and started, running the new plan', await diedWithin(dummy) === 'SIGKILL' &&
        restarted.some(function (l) { return /^start carplay\.service/.test(l); }) && memAgainst(planText()) === 'patched', JSON.stringify(restarted));
    r = await settled(r);
    ok('card off again: patched, mapurl eta, nothing pending', r.state === 'patched' && r.mapurl === 'eta' && !r.pending && !fs.existsSync(PENDING),
        JSON.stringify(r));

    /* Another value, or no file: off. */
    r = await card('left');
    ok('card "left": counts as off, nothing planned or restarted', planText() === etaPlan && r.mapurl === 'eta' && changes().length === 0, JSON.stringify(r));

    /* The install hook plans the user's arguments with the card's URL. */
    setCard('bottom');
    var h = cp.spawnSync(process.execPath, [PATCHD, 'activate'], { env: Object.assign({}, process.env, ENV), encoding: 'utf8', timeout: 60000 });
    rc = record();
    ok('install with the card on: planned with the map alone, the user\'s arguments kept, carplay untouched', h.status === 0 &&
        rc.args.slice(0, 2).join(' ') === '--panel high' && rc.args.indexOf('--coding') >= 0 && rc.args.slice(-2).join(' ') === '--showui map' &&
        planForm(planText()) === 'map' && changes().length === 0 && memAgainst(etaPlan) === 'patched', h.stdout + h.stderr + JSON.stringify(rc && rc.args));

    /* Remove patch: a card change leaves the patch off; the Patch button
     * then plans the card's URL. */
    setRecmgr(['HBAdasMgu']);
    r = await op({ cmd: 'revert' });
    before = fs.readFileSync(path.join(STATE, 'inmem-carplay.json'), 'utf8');
    await card('off');
    rc = record();
    ok('patch off: a card change plans nothing', fs.readFileSync(path.join(STATE, 'inmem-carplay.json'), 'utf8') === before && rc.enabled === false,
        JSON.stringify(rc));
    setCard('top');
    /* carplay still runs that patch, so nothing is to restart or wait for */
    r = await session({ cmd: 'apply', panel: 'high', mode: 'avb' }, function (m) { return m.state !== 'busy' && m.busy !== 'carplay'; });
    rc = record();
    ok('patch off, card top: the Patch button plans the map alone', rc.enabled === true && rc.args.slice(-2).join(' ') === '--showui map' &&
        planForm(planText()) === 'map' && r.state === 'patched' && r.mapurl === 'map-only' && !r.pending, JSON.stringify([r, rc && rc.args]));

    /* Boot recovery plans with the card's URL too. */
    var recovery = require('../recovery.js');
    setCard('bottom');
    var ra = recovery.TARGETS.carplay.planArgs(null);
    setCard(null);
    var rb = recovery.TARGETS.carplay.planArgs(null);
    ok('boot recovery\'s plan arguments: --showui map with the card on, none without', ra.slice(-2).join(' ') === '--showui map' && rb.indexOf('--showui') < 0,
        JSON.stringify([ra, rb]));

    var all = fs.readFileSync(CALLS, 'utf8');
    ok('never systemctl restart or stop', !/^(restart|stop|try-restart|reload-or-restart)\b/m.test(all), all);
    dummy.kill();
}

main().catch(function (e) { ok('no exception', false, e.stack); }).then(function () {
    patchd.kill();
    process.stdout.write(fails ? fails + ' FAILED\n' : 'all passed\n');
    process.exit(fails ? 1 : 0);
});
