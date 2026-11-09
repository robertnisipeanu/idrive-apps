#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
/* patchd's Keep the model badge, with a fake systemctl: badge 0 in the
 * status and no badge.env at the start; {"cmd":"badge","on":1} writes
 * badge.env with the render's line (the map 1:1 below the top 72 rows of the
 * 1088x480 area), restarts waze-on-cluster.service and replies badge 1, the
 * next status carrying it; asking the same again restarts nothing; on 0
 * removes the file and restarts the render again; any other value is refused.
 * waze-on-cluster.service reads the file before Android Auto's crop. */
'use strict';
var cp = require('child_process');
var fs = require('fs');
var net = require('net');
var os = require('os');
var path = require('path');

var PATCHD = path.join(__dirname, '..', 'patchd.js');
var UNIT = path.join(__dirname, '..', '..', 'systemd', 'waze-on-cluster.service');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-badge-'));
var SOCK = path.join(dir, 'sock', 'patch.sock');
var SYSTEMCTL = path.join(dir, 'systemctl');
var CALLS = path.join(dir, 'systemctl-calls');
var BADGE = path.join(dir, 'badge.env');
var LINE = 'WOC_BADGE=-s tex_size=1088x408 -s src_crop=1088x480:0,72,1088,408 -s map_rect=0,72,1088,408\n';

fs.writeFileSync(SYSTEMCTL, '#!/bin/sh\necho "$*" >> ' + CALLS + '\n', { mode: 0o755 });

var ENV = Object.assign({}, process.env, {
    WOC_PATCH_SOCK: SOCK,
    WOC_PATCH_GROUP: '',
    WOC_LOCAL_CONF: path.join(dir, 'local.conf'),
    WOC_STATE_DIR: dir,
    WOC_SYSTEMCTL: SYSTEMCTL,
    WOC_CARPLAY: path.join(dir, 'no-carplay'),
    WOC_STREAM_STATE: path.join(dir, 'no-stream.json'),
    WOC_RESYNC_FILE: path.join(dir, 'resync.json'),
    WOC_RECMGR_CONF: path.join(dir, 'no-recmgr'),
    WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr-at-boot.json'),
    WOC_PROC_STAT: path.join(dir, 'no-stat'),
    WOC_BOOT_ID: path.join(dir, 'no-boot-id'),
    WOC_MOUNT: path.join(dir, 'no-mount'),
    WOC_PROC_MOUNTS: path.join(dir, 'no-mounts'),
    WOC_CAPTURE_SOCK: path.join(dir, 'no-capture.sock'),
    WOC_DLT_RECEIVE: path.join(dir, 'no-dlt-receive'),
    WOC_DLT_RETRY_MS: '600000',
    WOC_REMOUNT_LOCK: path.join(dir, 'remount.lock'),
    WOC_PROC_NET_DEV: path.join(dir, 'no-net-dev'),
    WOC_PROC_NET_TCP: path.join(dir, 'no-tcp6'),
    WOC_BUSCTL: path.join(dir, 'no-busctl'),
    WOC_WIFI_RESAMPLE_MS: '600000'
});
var out = '';
var p = cp.spawn(process.execPath, [PATCHD], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
p.stdout.on('data', function (d) { out += d; });
p.stderr.on('data', function (d) { out += d; });

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var passed = 0, total = 0;
function ok(name, cond) {
    total++;
    if (cond) passed++;
    process.stdout.write((cond ? 'ok   ' : 'FAIL ') + name + '\n');
}

function calls() { try { return fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } }

/* A client keeping every message. */
function client() {
    var c = { msgs: [], buf: '' };
    c.s = net.connect(SOCK);
    c.s.setEncoding('utf8');
    c.s.on('data', function (d) {
        c.buf += d;
        var lines = c.buf.split('\n');
        c.buf = lines.pop();
        lines.forEach(function (l) { try { c.msgs.push(JSON.parse(l)); } catch (e) { /* not ours */ } });
    });
    c.send = function (m) { c.s.write(JSON.stringify(m) + '\n'); };
    c.wait = async function (what, test, from) {
        for (var t = 0; t < 8000; t += 50) {
            var m = c.msgs.slice(from || 0).filter(test);
            if (m.length) return m[m.length - 1];
            await sleep(50);
        }
        throw new Error('no ' + what);
    };
    return c;
}

(async function () {
    var unit = fs.readFileSync(UNIT, 'utf8');
    ok('the render reads badge.env', /^EnvironmentFile=-\/var\/opt\/waze-on-cluster\/badge\.env$/m.test(unit));
    ok('the render passes $WOC_BADGE before Android Auto\'s $WOC_SRC_CROP', /^ExecStart=.* \$WOC_BADGE \$WOC_SRC_CROP$/m.test(unit));

    for (var t = 0; t < 5000 && !fs.existsSync(SOCK); t += 50) await sleep(50);
    var c = client();
    var st = await c.wait('status', function (m) { return m.ev === 'status'; });
    ok('at the start: badge 0 in the status', st.badge === 0);
    ok('at the start: no badge.env', !fs.existsSync(BADGE));

    var n = c.msgs.length;
    c.send({ cmd: 'badge', on: 1 });
    var r = await c.wait('the reply to on', function (m) { return m.ev === 'badge-reply'; }, n);
    ok('on: replied ok with badge 1', r.ok === true && r.badge === 1);
    ok('on: badge.env holds the render\'s line', fs.readFileSync(BADGE, 'utf8') === LINE);
    ok('on: the render restarted', JSON.stringify(calls()) === JSON.stringify(['restart waze-on-cluster.service']));
    st = await c.wait('a status with badge 1', function (m) { return m.ev === 'status' && m.badge === 1; }, n);
    ok('on: the status carries badge 1', st.badge === 1);

    n = c.msgs.length;
    c.send({ cmd: 'badge', on: 1 });
    r = await c.wait('the reply to on again', function (m) { return m.ev === 'badge-reply'; }, n);
    ok('on again: replied ok, nothing restarted', r.ok === true && r.badge === 1 && calls().length === 1);

    n = c.msgs.length;
    c.send({ cmd: 'badge', on: 0 });
    r = await c.wait('the reply to off', function (m) { return m.ev === 'badge-reply'; }, n);
    ok('off: replied ok with badge 0', r.ok === true && r.badge === 0);
    ok('off: badge.env removed', !fs.existsSync(BADGE));
    ok('off: the render restarted again', calls().length === 2 && calls()[1] === 'restart waze-on-cluster.service');
    st = await c.wait('a status with badge 0', function (m) { return m.ev === 'status' && m.badge === 0; }, n);
    ok('off: the status carries badge 0', st.badge === 0);

    n = c.msgs.length;
    c.send({ cmd: 'badge', on: 2 });
    r = await c.wait('the refusal', function (m) { return m.ev === 'refused' && m.cmd === 'badge'; }, n);
    ok('on 2: refused, nothing written', !!r && !fs.existsSync(BADGE) && calls().length === 2);
    c.s.end();
})().catch(function (e) {
    ok('no error: ' + e.message, false);
}).then(function () {
    p.kill();
    try { fs.rmSync ? fs.rmSync(dir, { recursive: true, force: true }) : null; } catch (e) {}
    process.stdout.write(passed + '/' + total + ' passed\n');
    if (passed !== total) { process.stdout.write(out); process.exitCode = 1; }
});
