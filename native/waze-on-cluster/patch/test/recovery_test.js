// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Host tests for the boot-recovery state machine (patch/recovery.js) and the
 * shared remount lock (patch/remount_lock.js), with carplay_patch, mount and
 * systemctl all faked through injected dependencies, so the logic runs with no
 * car, no root and no real filesystem writes to /.
 *
 *   node patch/test/recovery_test.js
 *
 * Covers: a stock or firmware-replaced binary left untouched; a first patched
 * boot armed; a healthy carplay confirming and clearing the counter; a clean
 * shutdown exempting a boot; a cross-boot crash loop restoring at the threshold
 * (delayed recovery); a carplay restart breaking the healthy run; a remount failure
 * during restore preserving the counter for a retry; a patched binary with no
 * verified backup not restored; the remount lock's mutual exclusion and
 * stale break; and the service staying up with nothing to watch.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const { Recovery } = require('../recovery.js');

const RECOVERY_PATH = path.join(__dirname, '..', 'recovery.js');
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

/* A Recovery with scripted dependencies. restoreErr, when set, is the error the
 * (recorded) restore returns. probeSeq is consumed one entry per tick. */
function make(opts) {
    const calls = { restore: 0 };
    const statePath = opts.statePath || tmpState();
    const now = opts.now || clock();
    const rec = new Recovery({
        statePath,
        bootId: opts.bootId || 'boot-A',
        threshold: opts.threshold,
        healthyMs: opts.healthyMs,
        now,
        classify: (cb) => cb(opts.classifyErr ? { ok: false } : { ok: true, patchActive: opts.patchActive !== false, restorable: opts.restorable !== false }),
        restore: (cb) => { calls.restore++; cb(opts.restoreErr ? new Error(opts.restoreErr) : null); },
        probe: (cb) => cb(rec._next || { pid: 0, active: false }),
        log: () => {}
    });
    rec._feed = (info) => { rec._next = info; };
    return { rec, calls, statePath, now };
}

function readState(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

const startBoot = (rec) => new Promise((resolve) => rec.startBoot(resolve));
const tick = (rec) => new Promise((resolve) => rec.tick(resolve));

test('stock binary: nothing to protect, counter cleared, not monitored', async () => {
    const statePath = tmpState();
    fs.writeFileSync(statePath, JSON.stringify({ fails: 5, arm: { boot: 'old', state: 'unconfirmed' } }));
    const { rec } = make({ statePath, patchActive: false });
    const r = await startBoot(rec);
    assert.strictEqual(r.action, 'idle');
    assert.strictEqual(rec.patchActive, false);
    assert.deepStrictEqual(readState(statePath), { fails: 0, arm: null });
});

test('firmware-replaced (patch not recognised): never restored, counter cleared', async () => {
    /* A high fails count from a prior patched life must not restore over a
     * binary a firmware update replaced (patchActive false). */
    const statePath = tmpState();
    fs.writeFileSync(statePath, JSON.stringify({ fails: 9, arm: { boot: 'old', state: 'unconfirmed' } }));
    const { rec, calls } = make({ statePath, patchActive: false, threshold: 2 });
    const r = await startBoot(rec);
    assert.strictEqual(r.action, 'idle');
    assert.strictEqual(calls.restore, 0);
    assert.deepStrictEqual(readState(statePath), { fails: 0, arm: null });
});

test('first patched boot is armed, not counted', async () => {
    const { rec, statePath } = make({ bootId: 'boot-A', threshold: 2 });
    const r = await startBoot(rec);
    assert.strictEqual(r.action, 'armed');
    assert.strictEqual(r.fails, 0);
    assert.deepStrictEqual(readState(statePath), { fails: 0, arm: { boot: 'boot-A', state: 'unconfirmed' } });
    assert.strictEqual(rec.patchActive, true);
});

test('successful startup: a healthy carplay confirms and clears the counter', async () => {
    const now = clock();
    const { rec, statePath } = make({ bootId: 'boot-A', healthyMs: 60000, now });
    await startBoot(rec);
    rec._feed({ pid: 100, active: true });
    await tick(rec);                 /* active run starts */
    now.advance(30000);
    rec._feed({ pid: 100, active: true });
    let r = await tick(rec);
    assert.strictEqual(r.action, 'watch');   /* not yet healthy */
    now.advance(31000);
    rec._feed({ pid: 100, active: true });
    r = await tick(rec);
    assert.strictEqual(r.action, 'confirmed');
    assert.deepStrictEqual(readState(statePath), { fails: 0, arm: { boot: 'boot-A', state: 'confirmed' } });
});

test('a confirmed boot is not counted as a failure next boot', async () => {
    const statePath = tmpState();
    fs.writeFileSync(statePath, JSON.stringify({ fails: 0, arm: { boot: 'boot-A', state: 'confirmed' } }));
    const { rec } = make({ statePath, bootId: 'boot-B', threshold: 2 });
    const r = await startBoot(rec);
    assert.strictEqual(r.action, 'armed');
    assert.strictEqual(r.fails, 0);
    assert.deepStrictEqual(readState(statePath), { fails: 0, arm: { boot: 'boot-B', state: 'unconfirmed' } });
});

test('clean shutdown exempts the boot (SIGTERM marks it clean)', async () => {
    const statePath = tmpState();
    const { rec } = make({ statePath, bootId: 'boot-A', threshold: 2 });
    await startBoot(rec);
    rec.onShutdown();
    assert.deepStrictEqual(readState(statePath), { fails: 0, arm: { boot: 'boot-A', state: 'clean' } });
    /* Next boot: a clean arm is not counted. */
    const { rec: rec2 } = make({ statePath, bootId: 'boot-B', threshold: 2 });
    const r = await startBoot(rec2);
    assert.strictEqual(r.action, 'armed');
    assert.strictEqual(r.fails, 0);
});

test('delayed recovery: a cross-boot crash loop restores at the threshold', async () => {
    const statePath = tmpState();
    /* Boot A: armed, crashes (no confirm, no clean) -> leaves unconfirmed. */
    let m = make({ statePath, bootId: 'boot-A', threshold: 2 });
    assert.strictEqual((await startBoot(m.rec)).action, 'armed');
    assert.strictEqual(m.calls.restore, 0);

    /* Boot B: the prior unconfirmed boot counts as 1 failure; armed again. */
    m = make({ statePath, bootId: 'boot-B', threshold: 2 });
    let r = await startBoot(m.rec);
    assert.strictEqual(r.action, 'armed');
    assert.strictEqual(r.fails, 1);
    assert.strictEqual(m.calls.restore, 0);

    /* Boot C: a second failure reaches the threshold -> restore. */
    m = make({ statePath, bootId: 'boot-C', threshold: 2 });
    r = await startBoot(m.rec);
    assert.strictEqual(r.action, 'restored');
    assert.strictEqual(r.fails, 2);
    assert.strictEqual(m.calls.restore, 1);
    assert.strictEqual(m.rec.patchActive, false);   /* stock now, nothing to monitor */
    assert.deepStrictEqual(readState(statePath), { fails: 0, arm: null });
});

test('a carplay restart breaks the healthy run (the counter is not cleared early)', async () => {
    const now = clock();
    const { rec, statePath } = make({ bootId: 'boot-A', healthyMs: 60000, now });
    await startBoot(rec);
    rec._feed({ pid: 100, active: true }); await tick(rec);
    now.advance(40000); rec._feed({ pid: 100, active: true }); await tick(rec);
    /* carplay restarts (new PID) before 60 s: the run restarts, so no confirm. */
    now.advance(40000); rec._feed({ pid: 200, active: true });
    let r = await tick(rec);
    assert.strictEqual(r.action, 'watch');
    now.advance(61000); rec._feed({ pid: 200, active: true });
    r = await tick(rec);
    assert.strictEqual(r.action, 'confirmed');
    assert.strictEqual(readState(statePath).arm.state, 'confirmed');
});

test('an unreadable carplay state leaves the counter untouched', async () => {
    const statePath = tmpState();
    fs.writeFileSync(statePath, JSON.stringify({ fails: 1, arm: { boot: 'boot-A', state: 'unconfirmed' } }));
    const { rec, calls } = make({ statePath, bootId: 'boot-B', classifyErr: true });
    const r = await startBoot(rec);
    assert.strictEqual(r.action, 'unreadable');
    assert.strictEqual(calls.restore, 0);
    assert.strictEqual(rec.patchActive, false);
    assert.deepStrictEqual(readState(statePath), { fails: 1, arm: { boot: 'boot-A', state: 'unconfirmed' } });
});

test('remount failure during restore keeps the counter for a retry', async () => {
    const statePath = tmpState();
    fs.writeFileSync(statePath, JSON.stringify({ fails: 2, arm: { boot: 'boot-A', state: 'unconfirmed' } }));
    const { rec, calls } = make({ statePath, bootId: 'boot-B', threshold: 2, restoreErr: 'remount rw: read-only file system' });
    const r = await startBoot(rec);
    assert.strictEqual(r.action, 'restore-failed');
    assert.strictEqual(calls.restore, 1);
    /* The failure is counted (boot-A unconfirmed -> fails 3) and kept, re-armed
     * for this boot, so the next boot tries again instead of losing the loop. */
    const st = readState(statePath);
    assert.strictEqual(st.fails, 3);
    assert.strictEqual(st.arm.boot, 'boot-B');
    assert.strictEqual(st.arm.state, 'unconfirmed');
});

test('patched with no verified backup: not restored, flagged unavailable', async () => {
    const statePath = tmpState();
    fs.writeFileSync(statePath, JSON.stringify({ fails: 2, arm: { boot: 'boot-A', state: 'unconfirmed' } }));
    const { rec, calls } = make({ statePath, bootId: 'boot-B', threshold: 2, restorable: false });
    const r = await startBoot(rec);
    assert.strictEqual(r.action, 'restore-unavailable');
    assert.strictEqual(calls.restore, 0);
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
        assert(r.running, 'the running binary is kept linked so / can go read-only');
        assert(r.pendingGone, 'the pending-activation marker is cleared');
    } finally { cp.execFileSync('rm', ['-rf', dir]); }
});

const ROMOUNT = (dir) => 'case "$*" in *remount,rw*) echo "/dev/root / ext4 rw 0 0" > "' + path.join(dir, 'mounts') +
    '";; *remount,ro*) echo "/dev/root / ext4 ro 0 0" > "' + path.join(dir, 'mounts') + '";; esac\n';
/* A process runs file: a fake /proc/<pid>/exe holding its inode. */
function runs(proc, pid, file) { fs.mkdirSync(path.join(proc, pid)); fs.linkSync(file, path.join(proc, pid, 'exe')); }

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
