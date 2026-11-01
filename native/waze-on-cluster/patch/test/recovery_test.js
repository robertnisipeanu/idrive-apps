// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Host tests for boot recovery (patch/recovery.js: the boot step and the
 * watcher), shutdown_mark.sh and the shared remount lock
 * (patch/remount_lock.js). carplay.service, systemd, recmgr and the patcher
 * are faked through injected dependencies, so the logic runs with no car, no
 * root and no writes to /; the real restore runs on a copy with CARPLAY_BIN.
 *
 *   node patch/test/recovery_test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const { Recovery, tally } = require('../recovery.js');

const RECOVERY_PATH = path.join(__dirname, '..', 'recovery.js');
const MARK_SH = path.join(__dirname, '..', 'shutdown_mark.sh');
const CARPLAY_PATCH = path.join(__dirname, '..', 'carplay_patch.js');
const CARPLAY_BIN = process.env.CARPLAY_BIN || '';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let tmpN = 0;
function tmpState() {
    return path.join(os.tmpdir(), `woc-rec-${process.pid}-${tmpN++}.json`);
}

/* A controllable clock. */
function clock(start) {
    let t = start || 1000000;
    const fn = () => t;
    fn.advance = (ms) => { t += ms; };
    return fn;
}

/* A fake carplay.service and system around a Recovery: carplay.pid / state /
 * result as systemctl show reports them, the set of live PIDs, the system's
 * state, the shutdown mark, the patch on disk. Every effect lands in
 * world.events in order. */
function makeWorld(opts) {
    opts = opts || {};
    const w = {
        statePath: opts.statePath || tmpState(),
        carplay: { pid: 0, state: 'inactive', result: 'success' },
        alive: new Set(),
        system: 'running',
        marks: {},
        patched: opts.patched !== false,
        restorable: opts.restorable !== false,
        backup: opts.backup !== false,
        recmgr: !!opts.recmgr,
        killed: 0,
        lockHeld: false,
        events: [],
        now: opts.now || clock(),
    };
    let nextPid = 100;
    w.carplayStarts = () => {
        const pid = nextPid++;
        w.carplay = { pid, state: 'active', result: 'success' };
        w.alive.add(pid);
        w.events.push('carplay-start:' + (w.patched ? 'patched' : 'stock'));
        return pid;
    };
    w.carplayCrashes = () => {
        w.alive.delete(w.carplay.pid);
        w.carplay = { pid: 0, state: 'failed', result: 'core-dump' };
        w.events.push('carplay-crash');
    };
    w.recovery = (bootId, extra) => new Recovery(Object.assign({
        statePath: w.statePath,
        bootId,
        threshold: opts.threshold || 2,
        healthyMs: opts.healthyMs || 60000,
        now: w.now,
        classify: (cb) => { w.events.push('classify'); cb({ ok: true, patchActive: w.patched, restorable: w.patched && w.restorable }); },
        restore: (cb) => { w.events.push('restore'); w.patched = false; cb(null); },
        probe: (cb) => cb(Object.assign({}, w.carplay)),
        systemState: (cb) => cb(w.system),
        start: (cb) => { w.carplayStarts(); cb(null); },
        mark: (boot) => w.marks[boot] || null,
        hasBackup: () => w.backup,
        alive: (pid) => w.alive.has(pid),
        killed: () => w.killed,
        recmgrLoaded: (name) => name === 'carplay' && w.recmgr,
        lock: { tryAcquire: () => !w.lockHeld, release: () => {} },
        log: () => {},
    }, extra || {}));
    return w;
}

function readState(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

const startBoot = (rec) => new Promise((resolve) => rec.startBoot(resolve));
const tick = (rec) => new Promise((resolve) => rec.tick(resolve));
const shutdown = (rec) => new Promise((resolve) => rec.onShutdown(resolve));

/* One boot as the units order it: the boot step, carplay's start, the
 * watcher's own start; then the watcher sees one tick. */
async function bootUp(w, bootId) {
    const step = await startBoot(w.recovery(bootId));
    w.events.push('boot-step:' + step.action);
    w.carplayStarts();
    const watcher = w.recovery(bootId);
    await startBoot(watcher);
    await tick(watcher);
    return { step, watcher };
}

/* An orderly reboot: the system stops and the watcher gets SIGTERM. */
async function orderlyReboot(w, watcher) {
    w.system = 'stopping';
    await shutdown(watcher);
    w.system = 'running';
    w.alive.clear();
    w.carplay = { pid: 0, state: 'inactive', result: 'success' };
}

test('crash loop with orderly reboots: each crash counts despite SIGTERM, and the threshold restores before carplay starts again', async () => {
    const w = makeWorld({ recmgr: false });
    let r;
    for (const boot of ['A', 'B']) {
        const { watcher } = await bootUp(w, boot);
        w.carplayCrashes();
        r = await tick(watcher);
            await orderlyReboot(w, watcher);
        if (boot === 'A') {
            assert.strictEqual(r.fails, 1);
            assert.deepStrictEqual(readState(w.statePath).arm, { boot: 'A', crashes: 1, confirmed: false, clean: false },
                'persisted at once, and SIGTERM does not exempt a crashed boot');
        }
    }
    assert.strictEqual(r.restore, 'restored', 'the second crash reached the threshold');
    const crash2 = w.events.lastIndexOf('carplay-crash');
    assert.deepStrictEqual(w.events.slice(crash2), ['carplay-crash', 'classify', 'restore']);
    w.events.length = 0;
    await bootUp(w, 'C');
    assert.deepStrictEqual(w.events.slice(0, 2), ['boot-step:armed', 'carplay-start:stock']);
    assert.strictEqual(readState(w.statePath).fails, 0);
});

test('crash loop the watcher never sees: the shutdown mark counts it and the boot step restores before carplay starts', async () => {
    const w = makeWorld({ recmgr: false });
    for (const boot of ['A', 'B']) {
        await bootUp(w, boot);
        w.carplayCrashes();
        w.marks[boot] = 'failed';   /* rebooted before the watcher's next tick */
        w.alive.clear();
    }
    w.events.length = 0;
    const { step } = await bootUp(w, 'C');
    assert.strictEqual(step.action, 'restored');
    assert.deepStrictEqual(w.events.slice(0, 4), ['classify', 'restore', 'boot-step:restored', 'carplay-start:stock'],
        'the restore runs before carplay starts');
});

test('a crash after a healthy minute still counts, so a late crash loops too', async () => {
    const w = makeWorld({ recmgr: false });
    for (const boot of ['A', 'B']) {
        const { watcher } = await bootUp(w, boot);
        w.now.advance(61000);
        assert.strictEqual((await tick(watcher)).action, 'confirmed');
        w.carplayCrashes();
        await tick(watcher);
        await orderlyReboot(w, watcher);
    }
    assert(w.events.includes('restore'));
});

test('a healthy boot clears the counter', async () => {
    const w = makeWorld();
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 1, arm: null }));
    const { watcher } = await bootUp(w, 'B');
    assert.strictEqual(readState(w.statePath).fails, 1);
    w.now.advance(30000);
    assert.strictEqual((await tick(watcher)).action, 'watch');
    w.now.advance(31000);
    assert.strictEqual((await tick(watcher)).action, 'confirmed');
    w.marks.B = 'running';
    await bootUp(w, 'C');
    assert.strictEqual(readState(w.statePath).fails, 0);
});

test('a switch-off without a crash keeps the counter; a boot that ended with no record adds one', async () => {
    const w = makeWorld();
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 1, arm: { boot: 'A', crashes: 0, confirmed: false, clean: false } }));
    w.marks.A = 'running';
    await bootUp(w, 'B');
    assert.strictEqual(readState(w.statePath).fails, 1, 'a short trip is exempt');
    w.marks.B = 'stopped';
    await bootUp(w, 'C');
    assert.strictEqual(readState(w.statePath).fails, 1, 'carplay never started: exempt');
    const { step } = await bootUp(w, 'D');
    assert.strictEqual(step.action, 'restored', 'no mark for C: counted, restored at the threshold');
    assert.strictEqual(readState(w.statePath).fails, 0);
});

test('an orderly reboot without a crash exempts the boot; a service restart does not', async () => {
    const w = makeWorld();
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 1, arm: null }));
    const { watcher } = await bootUp(w, 'A');
    await shutdown(watcher);   /* system running: a restart of the watcher */
    assert.strictEqual(readState(w.statePath).arm.clean, false);
    await orderlyReboot(w, watcher);
    assert.strictEqual(readState(w.statePath).arm.clean, true);
    await bootUp(w, 'B');
    assert.strictEqual(readState(w.statePath).fails, 1);
    assert(!w.events.includes('restore'));
});

test('no patch of ours on disk: the boot step neither classifies nor restores, and is fast', async () => {
    const w = makeWorld({ backup: false });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 7, arm: { boot: 'A', crashes: 3 } }));
    const t0 = Date.now();
    const r = await startBoot(w.recovery('B', { classify: () => { throw new Error('classified'); } }));
    assert.strictEqual(r.action, 'idle');
    assert(Date.now() - t0 < 100);
    assert.deepStrictEqual(readState(w.statePath), { fails: 0, arm: null, starts: null });
});

test('below the threshold the boot step arms without classifying', async () => {
    const w = makeWorld();
    const r = await startBoot(w.recovery('A', { classify: () => { throw new Error('classified'); } }));
    assert.strictEqual(r.action, 'armed');
    assert.deepStrictEqual(readState(w.statePath).arm, { boot: 'A', crashes: 0, confirmed: false, clean: false });
});

test('the watcher counts nothing twice and retries a restore the boot step did not finish', async () => {
    const w = makeWorld();
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 1, arm: { boot: 'A', crashes: 1 } }));
    let fail = true;
    const restore = (cb) => { w.events.push('restore'); if (fail) { fail = false; cb(new Error('remount lock held; deferring')); return; } w.patched = false; cb(null); };
    assert.strictEqual((await startBoot(w.recovery('B', { restore }))).action, 'restore-failed');
    assert.strictEqual(readState(w.statePath).fails, 2);
    assert.strictEqual((await startBoot(w.recovery('B', { restore }))).action, 'restored');
    assert.deepStrictEqual(readState(w.statePath), { fails: 0, arm: null, starts: null });
});

test('a firmware-replaced binary at the threshold is never restored, and the counter clears', async () => {
    const w = makeWorld({ patched: false });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 9, arm: { boot: 'A', crashes: 1 } }));
    assert.strictEqual((await startBoot(w.recovery('B'))).action, 'idle');
    assert(!w.events.includes('restore'));
    assert.strictEqual(readState(w.statePath).fails, 0);
});

test('patched with no verified backup: not restored, flagged unavailable', async () => {
    const w = makeWorld({ restorable: false });
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 2, arm: { boot: 'A', crashes: 1 } }));
    assert.strictEqual((await startBoot(w.recovery('B'))).action, 'restore-unavailable');
    assert(!w.events.includes('restore'));
});

test('an unreadable carplay state at the threshold leaves the counter', async () => {
    const w = makeWorld();
    fs.writeFileSync(w.statePath, JSON.stringify({ fails: 2, arm: null }));
    const r = await startBoot(w.recovery('B', { classify: (cb) => cb({ ok: false }) }));
    assert.strictEqual(r.action, 'unreadable');
    assert.strictEqual(readState(w.statePath).fails, 2);
});

test('a 0.7.4 state carries over: an unconfirmed arm counts, a clean or confirmed one does not', () => {
    assert.strictEqual(tally(1, { boot: 'A', state: 'unconfirmed' }, null), 2);
    assert.strictEqual(tally(1, { boot: 'A', state: 'clean' }, null), 1);
    assert.strictEqual(tally(1, { boot: 'A', state: 'confirmed' }, null), 0);
    assert.strictEqual(tally(1, { boot: 'A', crashes: 2 }, 'failed'), 3, 'seen crashes are not counted twice');
});

test('recmgr loaded carplay: an in-boot crash loop is restored and carplay started again, with no reboot', async () => {
    const w = makeWorld({ recmgr: true });
    const { watcher } = await bootUp(w, 'A');
    w.events.length = 0;
    w.carplayCrashes();
    assert.strictEqual((await tick(watcher)).fails, 1);
    assert.strictEqual((await tick(watcher)).action, 'watch', 'the start waits its delay');
    w.now.advance(5000);
    assert.strictEqual((await tick(watcher)).action, 'started');
    await tick(watcher);
    w.carplayCrashes();
    const r = await tick(watcher);
    assert.strictEqual(r.restore, 'restored');
    w.now.advance(15000);
    assert.strictEqual((await tick(watcher)).action, 'started');
    assert.deepStrictEqual(w.events, ['carplay-crash', 'classify', 'carplay-start:patched',
        'carplay-crash', 'classify', 'restore', 'carplay-start:stock']);
    assert.deepStrictEqual(readState(w.statePath), { fails: 0, arm: null, starts: { boot: 'A', n: 2 } });
});

test('recmgr loaded carplay: starts are bounded per boot', async () => {
    const w = makeWorld({ recmgr: true, patched: false });
    const { watcher } = await bootUp(w, 'A');
    let starts = 0;
    for (let i = 0; i < 5; i++) {
        await tick(watcher);
        w.carplayCrashes();
        await tick(watcher);
        w.now.advance(60000);
        if ((await tick(watcher)).action === 'started') starts++;
    }
    assert.strictEqual(starts, 3);
});

test('recmgr loaded carplay: no start while patchd holds the lock, the system stops, or carplay is up again', async () => {
    const w = makeWorld({ recmgr: true, patched: false });
    const { watcher } = await bootUp(w, 'A');
    w.carplayCrashes();
    await tick(watcher);
    w.now.advance(5000);
    w.lockHeld = true;
    assert.strictEqual((await tick(watcher)).action, 'watch', 'waits for patchd');
    w.lockHeld = false;
    w.system = 'stopping';
    assert.strictEqual((await tick(watcher)).action, 'start-skipped');
    w.system = 'running';
    w.carplayStarts();
    await tick(watcher);
    w.carplayCrashes();
    await tick(watcher);
    w.now.advance(5000);
    w.carplayStarts();
    assert.strictEqual((await tick(watcher)).action, 'start-skipped');
    assert.strictEqual(readState(w.statePath).starts, null, 'the watcher started nothing');
});

test('recmgr did not load carplay: a crash is counted but carplay is not started', async () => {
    const w = makeWorld({ recmgr: false });
    const { watcher } = await bootUp(w, 'A');
    w.carplayCrashes();
    await tick(watcher);
    for (let i = 0; i < 3; i++) { w.now.advance(60000); await tick(watcher); }
    assert.strictEqual(w.events.filter((e) => e.startsWith('carplay-start')).length, 1);
    assert.strictEqual(readState(w.statePath).arm.crashes, 1);
});

test('not a crash: patchd\'s activation kill, a clean stop, or a death while the system stops', async () => {
    for (const how of ['killed', 'stopped', 'stopping']) {
        const w = makeWorld({ recmgr: true });
        const { watcher } = await bootUp(w, 'A');
        const pid = w.carplay.pid;
        w.alive.delete(pid);
        w.carplay = { pid: 0, state: how === 'stopped' ? 'inactive' : 'failed', result: how === 'stopped' ? 'success' : 'signal' };
        if (how === 'killed') w.killed = pid;
        if (how === 'stopping') w.system = 'stopping';
        assert.strictEqual((await tick(watcher)).action, 'watch', how);
        assert.strictEqual(readState(w.statePath).arm.crashes, 0, how);
    }
});

test('a dying PID systemd has not reaped yet is not taken for a crash', async () => {
    const w = makeWorld();
    const { watcher } = await bootUp(w, 'A');
    w.alive.delete(w.carplay.pid);   /* gone from /proc, systemd still says active */
    assert.strictEqual((await tick(watcher)).action, 'watch');
    assert.strictEqual(readState(w.statePath).arm.crashes, 0);
});

test('the watcher stays quiet between probes while the PID lives', async () => {
    const w = makeWorld();
    let probes = 0;
    const watcher = w.recovery('A', { probe: (cb) => { probes++; cb(Object.assign({}, w.carplay)); } });
    await startBoot(watcher);
    w.carplayStarts();
    for (let i = 0; i < 4; i++) { await tick(watcher); w.now.advance(1000); }
    assert.strictEqual(probes, 1);
});

/* shutdown_mark.sh against a fake systemctl. */
function runMark(show, opts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-mark-'));
    try {
        fs.writeFileSync(path.join(dir, 'boot_id'), 'boot-X\n');
        const sc = path.join(dir, 'systemctl');
        fs.writeFileSync(sc, '#!/bin/sh\n' + (show === null ? 'exit 1\n' : 'printf "%s\\n" "' + show.join('" "') + '"\n'));
        fs.chmodSync(sc, 0o755);
        const state = path.join(dir, 'state');
        if (!(opts && opts.noDir)) fs.mkdirSync(state);
        const r = cp.spawnSync('sh', [MARK_SH], { env: Object.assign({}, process.env, { WOC_STATE_DIR: state, WOC_BOOT_ID: path.join(dir, 'boot_id'), WOC_SYSTEMCTL: sc }) });
        let mark = null;
        try { mark = fs.readFileSync(path.join(state, 'shutdown'), 'utf8'); } catch (e) {}
        return { status: r.status, mark };
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
}

test('shutdown_mark.sh records running, failed or stopped, and nothing it cannot read', () => {
    assert.deepStrictEqual(runMark(['ActiveState=active', 'Result=success']), { status: 0, mark: 'boot-X running\n' });
    assert.deepStrictEqual(runMark(['ActiveState=failed', 'Result=core-dump']), { status: 0, mark: 'boot-X failed\n' });
    assert.deepStrictEqual(runMark(['ActiveState=deactivating', 'Result=watchdog']), { status: 0, mark: 'boot-X failed\n' });
    assert.deepStrictEqual(runMark(['ActiveState=inactive', 'Result=success']), { status: 0, mark: 'boot-X stopped\n' });
    assert.deepStrictEqual(runMark(null), { status: 0, mark: null });
    assert.deepStrictEqual(runMark(['ActiveState=active', 'Result=success'], { noDir: true }), { status: 0, mark: null });
});

test('the boot step exits 0 whatever fails, so carplay\'s start goes ahead', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-bootfail-'));
    try {
        const tgt = path.join(dir, 'carplay');
        fs.writeFileSync(tgt, 'not a carplay build\n');
        fs.writeFileSync(tgt + '.woc-orig', 'x');
        fs.writeFileSync(path.join(dir, 'boot_id'), 'boot-Z\n');
        fs.writeFileSync(path.join(dir, 'state'), '');
        const cases = [
            { WOC_RECOVERY_STATE: path.join(dir, 'state', 'nested.json') },   /* state unwritable */
            { WOC_RECOVERY_STATE: path.join(dir, 's.json'), WOC_MOUNT: path.join(dir, 'no-mount') },
        ];
        fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ fails: 5, arm: { boot: 'old', crashes: 1 } }));
        for (const env of cases) {
            const t0 = Date.now();
            const r = cp.spawnSync(process.execPath, [RECOVERY_PATH, 'boot'], {
                env: Object.assign({}, process.env, { WOC_CARPLAY: tgt, WOC_BOOT_ID: path.join(dir, 'boot_id') }, env), encoding: 'utf8', timeout: 20000,
            });
            assert.strictEqual(r.status, 0, JSON.stringify(env) + ': ' + r.stdout + r.stderr);
            assert(Date.now() - t0 < 10000);
        }
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('the boot unit orders itself before carplay, never blocks it, and is whitelisted', () => {
    const unit = fs.readFileSync(path.join(__dirname, '..', '..', 'systemd', 'waze-on-cluster-boot.service'), 'utf8');
    const val = (k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(unit) || [])[1];
    assert.strictEqual(val('Before'), 'carplay.service');
    assert(!/^(Requires|BindsTo|Requisite|RequiredBy)=/m.test(unit), 'carplay does not depend on it');
    assert.strictEqual(val('Type'), 'oneshot');
    assert(/^-/.test(val('ExecStart')), 'its exit status is ignored');
    assert(parseInt(val('TimeoutStartSec'), 10) <= 30);
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'component.json'), 'utf8'));
    assert(c.recmgr.includes('waze-on-cluster-boot'), 'a timed-out oneshot fails; recmgr must not reboot for it');
    assert(!c.restart.includes('waze-on-cluster-boot.service'), 'it runs at boot, not at install');
    assert(c.enable.some((e) => e.unit === 'waze-on-cluster-boot.service' && e.target === 'multi-user.target'));
    assert(c.dropins.some((d) => d.unit === 'var-opt-ro.service'));
    assert(c.files.some((f) => f.path === 'shutdown_mark.sh') && c.files.some((f) => f.path === 'recmgr_list.js'));
});

test('remount lock: mutual exclusion and stale break', () => {
    const lockPath = path.join(os.tmpdir(), `woc-lock-${process.pid}.lock`);
    try { fs.unlinkSync(lockPath); } catch (e) {}
    process.env.WOC_REMOUNT_LOCK = lockPath;
    process.env.WOC_REMOUNT_LOCK_STALE_MS = '50';
    delete require.cache[require.resolve('../remount_lock.js')];
    const lock = require('../remount_lock.js');

    assert.strictEqual(lock.tryAcquire(), true, 'first acquire');
    assert.strictEqual(lock.tryAcquire(), false, 'held: second acquire fails');
    lock.release();
    assert.strictEqual(lock.tryAcquire(), true, 'reacquire after release');

    /* Age the lock past STALE_MS and confirm it is broken and retaken. */
    const old = Date.now() / 1000 - 10;
    fs.utimesSync(lockPath, old, old);
    assert.strictEqual(lock.tryAcquire(), true, 'stale lock broken');
    lock.release();
    try { fs.unlinkSync(lockPath); } catch (e) {}
    delete process.env.WOC_REMOUNT_LOCK;
    delete process.env.WOC_REMOUNT_LOCK_STALE_MS;
});

/* Stage a patched carplay copy (with the verified stock backup) and a fake
 * mount, then run the real realRestore in a child with those env paths. */
function stageAndRestore(dir, mountBody, before) {
    const sock = path.join(dir, 'sock');
    fs.mkdirSync(sock, { recursive: true });
    const tgt = path.join(dir, 'carplay');
    fs.copyFileSync(CARPLAY_BIN, tgt);
    cp.execFileSync(process.execPath, [CARPLAY_PATCH, 'apply', '--panel', 'high',
        '--sink', 'udp://127.0.0.1:20557?mime_type=video/H264', '--target', tgt, '--yes'], { stdio: 'ignore' });
    const pending = path.join(sock, 'activation-pending');
    fs.writeFileSync(pending, 'pending\n');
    const mounts = path.join(dir, 'mounts');
    fs.writeFileSync(mounts, '/dev/root / ext4 rw 0 0\n');
    const mount = path.join(dir, 'mount');
    fs.writeFileSync(mount, '#!/bin/sh\n' + mountBody);
    fs.chmodSync(mount, 0o755);
    const proc = path.join(dir, 'proc');
    fs.mkdirSync(proc);
    if (before) before(tgt, proc);
    const out = cp.execFileSync(process.execPath, ['-e',
        'require(process.env.RP).realRestore(function(e){process.stdout.write(JSON.stringify({err:e&&e.message}));process.exit(0);});'], {
        env: Object.assign({}, process.env, {
            RP: RECOVERY_PATH, WOC_CARPLAY: tgt, WOC_MOUNT: mount, WOC_PROC_MOUNTS: mounts,
            WOC_PATCH_SOCK: path.join(sock, 'patch.sock'), WOC_REMOUNT_LOCK: path.join(sock, 'remount.lock'), WOC_PROC: proc,
        }),
        encoding: 'utf8',
    });
    return {
        err: JSON.parse(out).err,
        tgtSha: sha(fs.readFileSync(tgt)),
        mounts: fs.readFileSync(mounts, 'utf8'),
        running: fs.existsSync(tgt + '.woc-running'),
        runningIno: fs.existsSync(tgt + '.woc-running') ? fs.statSync(tgt + '.woc-running').ino : null,
        pendingGone: !fs.existsSync(pending),
    };
}

test('realRestore reverts to the verified stock and leaves / read-only', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        const stock = sha(fs.readFileSync(CARPLAY_BIN));
        const r = stageAndRestore(dir, 'case "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + path.join(dir, 'mounts') +
            '";; *remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + path.join(dir, 'mounts') + '";; esac\n');
        assert.strictEqual(r.err, null, 'no error: ' + r.err);
        assert.strictEqual(r.tgtSha, stock, 'carplay restored to the verified stock');
        assert(/\bro\b/.test(r.mounts), '/ is read-only again');
        assert(!r.running, 'nothing runs the patched binary: no link kept');
        assert(r.pendingGone, 'the pending-activation marker is cleared');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

const ROMOUNT = (dir) => 'case "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + path.join(dir, 'mounts') +
    '";; *remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + path.join(dir, 'mounts') + '";; esac\n';
/* A process runs file: a fake /proc/<pid>/exe holding its inode. */
function runs(proc, pid, file) { fs.mkdirSync(path.join(proc, pid)); fs.linkSync(file, path.join(proc, pid, 'exe')); }

test('realRestore keeps the patched binary carplay runs linked so / can go read-only', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        let patchedIno = null;
        const r = stageAndRestore(dir, ROMOUNT(dir), (tgt, proc) => { patchedIno = fs.statSync(tgt).ino; runs(proc, '1', tgt); });
        assert.strictEqual(r.err, null, 'no error: ' + r.err);
        assert.strictEqual(r.tgtSha, sha(fs.readFileSync(CARPLAY_BIN)), 'carplay restored to the verified stock');
        assert.strictEqual(r.runningIno, patchedIno, 'the running binary is linked');
        assert(/\bro\b/.test(r.mounts), '/ is read-only again');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('realRestore keeps a .woc-running a process runs, and restores', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        let held = null;
        const r = stageAndRestore(dir, ROMOUNT(dir), (tgt, proc) => {
            fs.writeFileSync(tgt + '.woc-running', 'the binary carplay runs\n');
            held = fs.statSync(tgt + '.woc-running').ino;
            runs(proc, '1', tgt + '.woc-running');
        });
        assert.strictEqual(r.err, null, 'no error: ' + r.err);
        assert.strictEqual(r.tgtSha, sha(fs.readFileSync(CARPLAY_BIN)), 'carplay restored to the verified stock');
        assert.strictEqual(r.runningIno, held, 'the link a process runs is left as it is');
        assert(/\bro\b/.test(r.mounts), '/ is read-only again');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('realRestore waits for the next boot while processes run both the target and the link', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        let held = null, patched = null;
        const r = stageAndRestore(dir, ROMOUNT(dir), (tgt, proc) => {
            fs.writeFileSync(tgt + '.woc-running', 'an older binary\n');
            held = fs.statSync(tgt + '.woc-running').ino;
            patched = sha(fs.readFileSync(tgt));
            runs(proc, '1', tgt + '.woc-running');
            runs(proc, '2', tgt);
        });
        assert(r.err && /deferring/.test(r.err), 'deferred: ' + r.err);
        assert.strictEqual(r.tgtSha, patched, 'carplay untouched');
        assert.strictEqual(r.runningIno, held, 'the link untouched');
        assert(/\brw\b/.test(r.mounts) && !r.pendingGone, 'no remount was made, nothing else changed');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('realRestore takes a link that is the target\'s own file as no reason to wait', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        let patchedIno = null;
        const r = stageAndRestore(dir, ROMOUNT(dir), (tgt, proc) => {
            fs.linkSync(tgt, tgt + '.woc-running');
            patchedIno = fs.statSync(tgt).ino;
            runs(proc, '1', tgt);
        });
        assert.strictEqual(r.err, null, 'no error: ' + r.err);
        assert.strictEqual(r.tgtSha, sha(fs.readFileSync(CARPLAY_BIN)), 'carplay restored to the verified stock');
        assert.strictEqual(r.runningIno, patchedIno, 'the link holds the patched binary carplay runs');
        assert(/\bro\b/.test(r.mounts), '/ is read-only again');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('the boot step at the threshold restores a patched copy before carplay would start, / read-only after', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-boot-'));
    try {
        const tgt = path.join(dir, 'carplay');
        fs.copyFileSync(CARPLAY_BIN, tgt);
        cp.execFileSync(process.execPath, [CARPLAY_PATCH, 'apply', '--panel', 'high', '--target', tgt, '--yes'], { stdio: 'ignore' });
        const mounts = path.join(dir, 'mounts');
        fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
        fs.writeFileSync(path.join(dir, 'mount'), '#!/bin/sh\n' + ROMOUNT(dir));
        fs.chmodSync(path.join(dir, 'mount'), 0o755);
        fs.mkdirSync(path.join(dir, 'proc'));
        fs.mkdirSync(path.join(dir, 'sock'));
        fs.writeFileSync(path.join(dir, 'boot_id'), 'boot-B\n');
        const state = path.join(dir, 'state.json');
        fs.writeFileSync(state, JSON.stringify({ fails: 1, arm: { boot: 'boot-A', crashes: 1, confirmed: false, clean: false } }));
        const r = cp.spawnSync(process.execPath, [RECOVERY_PATH, 'boot'], {
            env: Object.assign({}, process.env, {
                WOC_CARPLAY: tgt, WOC_MOUNT: path.join(dir, 'mount'), WOC_PROC_MOUNTS: mounts, WOC_PROC: path.join(dir, 'proc'),
                WOC_PATCH_SOCK: path.join(dir, 'sock', 'patch.sock'), WOC_REMOUNT_LOCK: path.join(dir, 'sock', 'remount.lock'),
                WOC_RECOVERY_STATE: state, WOC_BOOT_ID: path.join(dir, 'boot_id'),
            }),
            encoding: 'utf8',
        });
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert(/boot check: restored/.test(r.stdout), r.stdout);
        assert.strictEqual(sha(fs.readFileSync(tgt)), sha(fs.readFileSync(CARPLAY_BIN)), 'carplay starts the verified stock');
        assert(/\bro\b/.test(fs.readFileSync(mounts, 'utf8')), '/ is read-only again');
        assert(!fs.existsSync(tgt + '.woc-running'), 'nothing ran it: no link');
        assert.deepStrictEqual(readState(state), { fails: 0, arm: null, starts: null });
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('realRestore reports a remount failure instead of leaving / writable silently', () => {
    if (!fs.existsSync(CARPLAY_BIN)) { console.log('     (skipped: carplay binary not found)'); return; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-rr-'));
    try {
        /* mount honours rw but never ro, so / stays writable. */
        const r = stageAndRestore(dir, 'case "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + path.join(dir, 'mounts') + '";; esac\n');
        assert(r.err && /read-write after remount/.test(r.err), 'the remount failure is reported: ' + r.err);
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

test('the service stays up without a patch to watch, and stops on SIGTERM', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-idle-'));
    let child = null;
    try {
        const tgt = path.join(dir, 'carplay');
        fs.writeFileSync(tgt, 'not a carplay build\n');
        fs.writeFileSync(path.join(dir, 'boot_id'), 'boot-idle\n');
        child = cp.spawn(process.execPath, [RECOVERY_PATH], {
            env: Object.assign({}, process.env, {
                WOC_CARPLAY: tgt, WOC_RECOVERY_STATE: path.join(dir, 'state.json'), WOC_BOOT_ID: path.join(dir, 'boot_id'),
                WOC_SYSTEMCTL: path.join(dir, 'no-systemctl'),
            }),
            stdio: 'ignore',
        });
        let exit = null;
        child.on('exit', (code, signal) => { exit = { code, signal }; });
        await new Promise((r) => setTimeout(r, 2000));
        assert.strictEqual(exit, null, 'still running 2 s after start: ' + JSON.stringify(exit));
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 1000));
        assert(exit && exit.code === 0, 'a SIGTERM ends it cleanly: ' + JSON.stringify(exit));
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        cp.execFileSync('rm', ['-rf', dir]);
    }
});

async function main() {
    let failed = 0;
    for (const t of tests) {
        try { await t.fn(); console.log(`ok   ${t.name}`); }
        catch (err) { failed++; console.log(`FAIL ${t.name}\n     ${err && err.stack}`); }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
}

main();
