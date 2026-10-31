// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
var assert = require('assert'), cp = require('child_process'), fs = require('fs'), net = require('net');
var helperPath = '/patch/dlt_capture.js';
var helper = require(helperPath);
var children = [];

/* A file of the unit's root file system, mounted at /rootfs. */
function install(from, to, mode) {
    fs.copyFileSync('/rootfs' + from, to);
    fs.chmodSync(to, mode);
}
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function until(fn, what) {
    for (var i = 0; i < 400; i++) { if (await fn()) return; await delay(25); }
    throw new Error('timed out: ' + what);
}
function spawn(cmd, args, env) {
    var child = cp.spawn(cmd, args, { env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'] });
    child.out = '';
    child.stdout.on('data', function (d) { child.out += d; });
    child.stderr.on('data', function (d) { child.out += d; });
    child.done = new Promise(function (r) { child.on('exit', function (code) { r(code); }); });
    children.push(child);
    return child;
}
async function receive() {
    var r = spawn('dlt-receive', ['-a', 'localhost']);
    await Promise.race([r.done, delay(1500)]);
    r.kill('SIGKILL');
    await r.done;
    return r.out;
}
function state() {
    try { return JSON.parse(fs.readFileSync('/run/woc-dlt-capture/state.json', 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
}
function command(cmd) {
    return new Promise(function (resolve, reject) {
        var c = net.connect('/run/woc-dlt-capture/control.sock'), buf = '';
        c.on('error', reject);
        c.on('connect', function () { c.write(JSON.stringify({ cmd: cmd }) + '\n'); });
        c.on('data', function (d) { buf += d; if (buf.indexOf('\n') >= 0) { c.destroy(); resolve(JSON.parse(buf)); } });
    });
}
function startHelper() {
    var h = spawn(process.execPath, [helperPath], { WOC_CAPTURE_MS: '4000' });
    return until(function () { return command('status').then(function () { return true; }, function () { return false; }); },
        'helper control socket').then(function () { return h; });
}

(async function () {
    fs.symlinkSync('/lib64/ld-linux-x86-64.so.2', '/lib/ld-linux-x86-64.so.2');
    install('/usr/bin/dlt-daemon', '/usr/local/bin/dlt-daemon', 0o755);
    install('/usr/bin/dlt-receive', '/usr/local/bin/dlt-receive', 0o755);
    install('/usr/lib/libdlt.so.2.15.0', '/usr/lib/libdlt.so.2', 0o755);
    fs.symlinkSync('/usr/lib/libdlt.so.2', '/usr/lib/libdlt.so');
    install('/etc/dlt.conf', '/etc/dlt.conf', 0o644);
    cp.execFileSync('groupadd', ['mgu_dlt']);
    cp.execFileSync('mkdir', ['-p', '-m', '0711', '/run/dlt-files']);
    cp.execFileSync('mkdir', ['-p', '/run/logntrace', '/run/lifecycle-ioc', '/var/opt/public/sin/dlt-daemon']);
    fs.writeFileSync('/run/lifecycle-ioc/lccount', '12\n');

    var daemon = spawn('dlt-daemon', []);
    await until(function () { return fs.existsSync('/run/dlt-files/dlt-ctrl.sock'); }, 'dlt-daemon control socket');
    spawn('/tools/client', []);
    await delay(500);
    assert.strictEqual(await helper.listening(), false, 'TCP 3490 must be closed at boot');
    assert(/connect\(\) failed/.test(await receive()), 'dlt-receive must be refused before capture');
    console.log('ok boot: no DLT TCP listener, dlt-receive refused');

    var h = await startHelper();
    await command('start');
    await until(function () { return /open|refused|restore_failed/.test(state().state); }, 'capture open');
    assert.strictEqual(state().state, 'open', JSON.stringify(state()));
    // As in patchd: dlt-receive runs until the restore drops its connection,
    // and only then flushes its block-buffered stdout.
    var r = spawn('dlt-receive', ['-a', 'localhost']);
    assert.notStrictEqual(await Promise.race([r.done, delay(10000).then(function () { return 'timeout'; })]), 'timeout',
        'dlt-receive must exit when the capture closes');
    assert(/Adding display: capture-test/.test(r.out), 'dlt-receive must get the marker while open');
    console.log('ok capture: firmware dlt-receive -a localhost reads the marker, exits at restore');

    await until(function () { return state().state === 'closed'; }, 'deadline restore');
    assert.strictEqual(await helper.listening(), false);
    assert.strictEqual(daemon.exitCode, null, 'dlt-daemon must survive');
    console.log('ok deadline: BUFFER restored, listener closed');

    // A resume starts a new lifecycle; the BUFFER record stays in 12_dltd.idlt.
    fs.writeFileSync('/run/lifecycle-ioc/lccount', '13\n');
    await command('start');
    await until(function () { return state().state === 'open'; }, 'capture open in a new lifecycle');
    h.kill('SIGKILL');
    await h.done;
    var restore = spawn(process.execPath, [helperPath, 'restore']);
    assert.strictEqual(await restore.done, 0, restore.out);
    assert.strictEqual(await helper.listening(), false);
    assert.strictEqual(state().owned, false);
    assert.strictEqual(daemon.exitCode, null, 'dlt-daemon must survive');
    console.log('ok new lifecycle, helper SIGKILLed while open: restore subcommand closes the listener');
})().catch(function (err) {
    console.error(err.stack);
    children.forEach(function (c) { if (c.out) console.error('--- ' + c.spawnargs.join(' ') + '\n' + c.out); });
    process.exitCode = 1;
}).then(function () {
    children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) {} });
    process.exit(process.exitCode || 0);
});
