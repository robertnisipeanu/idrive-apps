#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* recovery.js — the safety net for the carplay patch (PATCH.md "Boot
 * recovery"). A bad interaction (e.g. the requestStream self-start throwing on
 * a phone connect, PATCH.md "Exception risk") can crash carplay at every
 * session. Where recmgr has not loaded a carplay entry, a carplay death
 * reboots the head unit with the patched binary still on disk: a boot loop
 * with no HMI to turn the map off.
 *
 *   recovery.js boot   waze-on-cluster-boot.service, a oneshot ordered before
 *                      carplay.service: counts the previous boot and, at the
 *                      threshold, restores the original before carplay starts.
 *   recovery.js        waze-on-cluster-recovery.service: watches carplay for
 *                      the rest of the boot, records each crash the moment it
 *                      is seen and, where recmgr loaded carplay's entry,
 *                      restores at the threshold and starts carplay again.
 *
 * shutdown_mark.sh (a var-opt-ro.service drop-in) records at each head-unit
 * shutdown, before /var/opt goes read-only, whether carplay was running,
 * failed or stopped. recmgr's reboot and a switch-off are both an NSM fast
 * shutdown that stops no service, so that record, not a SIGTERM, tells a
 * crash from a switch-off.
 *
 * STATE (fsync'd) holds fails, the crashes of a patched carplay since the last
 * boot in which carplay ran healthy and did not crash; arm, this boot's record
 * ({boot, crashes, confirmed, clean}), kept while a backup of ours exists; and
 * starts ({boot, n}), the carplay starts made this boot. At the next boot a
 * previous boot adds its crashes (one when the mark says failed and none were
 * seen); one with none clears the counter if carplay ran HEALTHY_MS
 * continuously, keeps it if it shut down with carplay running or stopped (or
 * on SIGTERM while the system stops), and otherwise adds one (it ended with no
 * record, e.g. power lost).
 *
 * The restore is the carplay_patch.js revert Disable map uses (verified
 * backup, refuses a binary it does not recognise as a patched form of the
 * backup's build), under the remount lock shared with patchd, with / read-write
 * only for the write. It acts only on a recognised patched build with a
 * verified backup; a stock or firmware-replaced binary clears the counter. It
 * never kills, restarts or reboots anything; the only start is `systemctl
 * start carplay.service` after a crash, never stop or restart, bounded by
 * START_DELAYS_MS per boot.
 *
 * Node 8.16.2 on the unit. No dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var HERE = __dirname;
var PATCHER = path.join(HERE, 'carplay_patch.js');
var TARGET = process.env.WOC_CARPLAY || '/usr/bin/carplay';
var BACKUP = TARGET + '.woc-orig';
var STATE = process.env.WOC_RECOVERY_STATE || '/var/opt/waze-on-cluster/boot-recovery.json';
/* Written by shutdown_mark.sh: "<boot id> running|failed|stopped". */
var MARK = path.join(path.dirname(STATE), 'shutdown');
var SOCK = process.env.WOC_PATCH_SOCK || '/dev/shm/waze-on-cluster/patch.sock';
var PENDING = path.join(path.dirname(SOCK), 'activation-pending');
/* The PID patchd SIGKILLs to activate a change: its death is not a crash. */
var KILLED = path.join(path.dirname(SOCK), 'carplay-killed');
/* The running (patched) binary, kept hard-linked while restoring so replacing
 * TARGET by rename does not leave an unlinked-but-open file that blocks the
 * read-only remount — the same guard patchd uses (patchd.js, RUNNING). */
var RUNNING = TARGET + '.woc-running';
var MOUNT = process.env.WOC_MOUNT || '/bin/mount';
var PROC_MOUNTS = process.env.WOC_PROC_MOUNTS || '/proc/mounts';
var PROC = process.env.WOC_PROC || '/proc';
var BOOT_ID = process.env.WOC_BOOT_ID || '/proc/sys/kernel/random/boot_id';
var SYSTEMCTL = process.env.WOC_SYSTEMCTL || 'systemctl';

var THRESHOLD = parseInt(process.env.WOC_RECOVERY_THRESHOLD, 10) || 2;
var HEALTHY_MS = parseInt(process.env.WOC_RECOVERY_HEALTHY_MS, 10) || 60000;
var TICK_MS = parseInt(process.env.WOC_RECOVERY_TICK_MS, 10) || 1000;
/* systemctl is asked this often; between asks a tick only checks /proc. */
var PROBE_MS = 5000;
var START_DELAYS_MS = [5000, 15000, 60000];

var lock = require('./remount_lock.js');
var recmgr = require('./recmgr_list.js');

/* / is read-only per /proc/mounts (the last `/` entry is the effective root). */
function rootIsReadOnly() {
    try {
        var lines = fs.readFileSync(PROC_MOUNTS, 'utf8').split('\n');
        var opts = null;
        for (var i = 0; i < lines.length; i++) {
            var p = lines[i].split(' ');
            if (p[1] === '/') opts = p[3];
        }
        if (opts !== null) return /(^|,)ro(,|$)/.test(opts);
    } catch (e) {}
    return false;
}

function remount(rw, cb) {
    cp.execFile(MOUNT, ['-o', 'remount,' + (rw ? 'rw' : 'ro'), '/'], { timeout: 15000 }, function (err) { cb(err); });
}

function remountRo(tries, cb) {
    remount(false, function () {
        if (rootIsReadOnly()) { cb(null); return; }
        if (tries > 0) { setTimeout(function () { remountRo(tries - 1, cb); }, 500); return; }
        cb(new Error('/ is still read-write after remount'));
    });
}

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; } }
function readBootId() { return readText(BOOT_ID).trim(); }

/* ---- the real dependencies, injectable for host tests ---- */

/* The on-disk carplay's state. ok is false when the status could not be read
 * (a transient spawn/timeout failure), so the counter is not disturbed. */
function realClassify(cb) {
    cp.execFile(process.execPath, [PATCHER, 'status', '--target', TARGET], { timeout: 15000 }, function (err, out) {
        var text = (out || '') + '';
        if (err || !/^size:/m.test(text)) { cb({ ok: false }); return; }
        var patched = /variant:\s+PATCHED/.test(text);
        var bak = /backup:\s+(\S+)/.exec(text);
        var hasBackup = !!bak && bak[1] !== 'none';
        var known = !/known:\s+NO/.test(text);
        cb({ ok: true, patchActive: patched, restorable: patched && known && hasBackup });
    });
}

/* Restore the original with the vetted revert, under the shared remount lock,
 * / read-write only for the write and read-only again after. A patched binary
 * a process runs is hard-linked to RUNNING first so the rename does not leave
 * an unlinked-but-open file that would keep / writable; a RUNNING a process
 * still runs (a change pending this boot) is that link already and stays. With
 * both RUNNING and TARGET run by processes there is no name left to keep TARGET
 * linked, so the restore waits for the next boot. Yields to patchd if the lock
 * is held (cb with an error; the counter stays, so a later try restores). */
function realRestore(cb) {
    if (lock.holds(RUNNING, TARGET) && lock.inUse(TARGET)) { cb(new Error('processes run both ' + TARGET + ' and ' + RUNNING + '; deferring')); return; }
    if (!lock.tryAcquire()) { cb(new Error('remount lock held; deferring')); return; }
    var released = false;
    function finish(err) { if (!released) { released = true; lock.release(); } cb(err); }
    remount(true, function (mErr) {
        if (mErr) { finish(new Error('remount rw: ' + mErr.message)); return; }
        if (!lock.holds(RUNNING, TARGET) && lock.inUse(TARGET)) {
            try { fs.unlinkSync(RUNNING); } catch (e) {}
            try { fs.linkSync(TARGET, RUNNING); } catch (e) { log('keeping the running carplay linked failed: ' + e.message); }
        }
        cp.execFile(process.execPath, [PATCHER, 'revert', '--target', TARGET, '--yes'], { timeout: 60000 }, function (pErr, out, errOut) {
            var text = ((out || '') + '') + ((errOut || '') + '');
            try { fs.unlinkSync(PENDING); } catch (e) {}   /* the pending patch is gone */
            remountRo(3, function (roErr) {
                finish(pErr ? new Error('revert: ' + pErr.message + (text ? ' (' + text.trim().slice(-200) + ')' : '')) : roErr);
            });
        });
    });
}

/* carplay.service's main PID, ActiveState and Result. */
function realProbeCarplay(cb) {
    cp.execFile(SYSTEMCTL, ['show', 'carplay.service', '-p', 'MainPID', '-p', 'ActiveState', '-p', 'Result'], { timeout: 15000 }, function (err, out) {
        var text = (out || '') + '';
        var pid = /MainPID=(\d+)/.exec(text);
        var state = /ActiveState=(\S+)/.exec(text);
        var result = /Result=(\S+)/.exec(text);
        cb({ pid: pid ? parseInt(pid[1], 10) : 0, state: state ? state[1] : '', result: result ? result[1] : '' });
    });
}

function realSystemState(cb) {
    cp.execFile(SYSTEMCTL, ['is-system-running'], { timeout: 15000 }, function (err, out) { cb(((out || '') + '').trim()); });
}

function realStartCarplay(cb) {
    cp.execFile(SYSTEMCTL, ['start', 'carplay.service'], { timeout: 30000 }, function (err) { cb(err); });
}

function realMark(boot) {
    var m = /^(\S+) (running|failed|stopped)\s*$/.exec(readText(MARK));
    return m && m[1] === boot ? m[2] : null;
}

function log(line) { process.stdout.write('[' + new Date().toISOString() + '] recovery: ' + line + '\n'); }

/* ---- the counter ---- */

function newArm(boot) { return { boot: boot, crashes: 0, confirmed: false, clean: false }; }

/* fails after the previous boot, from its arm and its shutdown mark. */
function tally(fails, arm, mark) {
    var crashes = arm.crashes || (mark === 'failed' ? 1 : 0);
    if (crashes) return fails + crashes;
    if (arm.confirmed || arm.state === 'confirmed') return 0;
    if (arm.clean || arm.state === 'clean' || mark === 'running' || mark === 'stopped') return fails;
    return fails + 1;
}

function Recovery(opts) {
    opts = opts || {};
    this.statePath = opts.statePath || STATE;
    this.threshold = opts.threshold || THRESHOLD;
    this.healthyMs = opts.healthyMs || HEALTHY_MS;
    this.bootId = opts.bootId || readBootId();
    this._classify = opts.classify || realClassify;
    this._restore = opts.restore || realRestore;
    this._probe = opts.probe || realProbeCarplay;
    this._systemState = opts.systemState || realSystemState;
    this._start = opts.start || realStartCarplay;
    this._mark = opts.mark || realMark;
    this._hasBackup = opts.hasBackup || function () { return fs.existsSync(BACKUP); };
    this._alive = opts.alive || function (pid) { return fs.existsSync(path.join(PROC, String(pid))); };
    this._killed = opts.killed || function () { return parseInt(readText(KILLED), 10) || 0; };
    this._recmgrLoaded = opts.recmgrLoaded || recmgr.recmgrLoaded;
    this._lock = opts.lock || lock;
    this._now = opts.now || Date.now;
    this._log = opts.log || log;

    this.restoring = false;
    this._busy = false;         /* a probe, crash or start is in flight */
    this._lastPid = 0;
    this._lastProbe = -Infinity;
    this._activeSince = null;   /* start of the current continuous-active run */
    this._startAt = null;       /* when the scheduled carplay start is due */
}

Recovery.prototype._load = function () {
    try {
        var st = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        if (st && typeof st === 'object') return { fails: st.fails || 0, arm: st.arm || null, starts: st.starts || null };
    } catch (e) {}
    return { fails: 0, arm: null, starts: null };
};

/* Persist durably: the state must survive the reboot a crash can cause the
 * moment after, so fsync before returning. */
Recovery.prototype._save = function (st) {
    try {
        var dir = path.dirname(this.statePath);
        try { fs.mkdirSync(dir, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        fs.writeFileSync(this.statePath, JSON.stringify({ fails: st.fails || 0, arm: st.arm || null, starts: st.starts || null }) + '\n');
        var fd = fs.openSync(this.statePath, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) { this._log('could not persist state: ' + e.message); }
};

Recovery.prototype._armed = function (st) { return !!st.arm && st.arm.boot === this.bootId; };

/* The boot-time decision: count the previous boot, arm this one, and restore
 * at the threshold. Only the restore path classifies the binary. Also run by
 * the watcher at its start, where it counts nothing twice and retries a
 * restore the boot step did not finish. cb(result) for tests; result.action is
 * 'idle' | 'armed' | 'unreadable' | 'restored' | 'restore-failed' |
 * 'restore-unavailable'. */
Recovery.prototype.startBoot = function (cb) {
    cb = cb || function () {};
    var self = this;
    var st = this._load();
    if (st.arm && !this._armed(st)) {
        var was = st.fails;
        st.fails = tally(st.fails, st.arm, this._mark(st.arm.boot));
        st.arm = null;
        if (st.fails !== was) this._log('failed patched boots and crashes now ' + st.fails + ' (was ' + was + ')');
    }
    if (!this._hasBackup()) {
        /* No backup of ours: nothing of ours to protect or restore. */
        if (st.fails || st.arm) this._save({ fails: 0, arm: null, starts: st.starts });
        cb({ action: 'idle' });
        return;
    }
    if (!st.arm) st.arm = newArm(this.bootId);
    this._save(st);
    if (st.fails < this.threshold) { cb({ action: 'armed', fails: st.fails }); return; }
    this._restoreAtThreshold(st.fails, cb);
};

/* Classify, then restore a restorable patch; the counter clears once carplay
 * is not ours to protect. */
Recovery.prototype._restoreAtThreshold = function (fails, cb) {
    var self = this;
    this._classify(function (cls) { self._restoreWith(cls, fails, cb); });
};

Recovery.prototype._restoreWith = function (cls, fails, cb) {
    var self = this;
    if (!cls.ok) {
        self._log('could not read carplay state; leaving the boot-recovery counter as is');
        cb({ action: 'unreadable', fails: fails });
        return;
    }
    if (!cls.patchActive) {
        /* Stock, or a binary we do not recognise (a firmware update):
         * nothing to restore. */
        self._clear();
        cb({ action: 'idle' });
        return;
    }
    if (!cls.restorable) {
        self._log('WARNING: ' + fails + ' carplay crashes but no restorable backup; leaving carplay as is');
        cb({ action: 'restore-unavailable', fails: fails });
        return;
    }
    self._log('restoring the original carplay after ' + fails + ' carplay crashes or failed boots');
    self.restoring = true;
    self._restore(function (err) {
        self.restoring = false;
        if (err) {
            /* The counter stays, so a later try restores. */
            self._log('boot recovery restore failed: ' + err.message);
            cb({ action: 'restore-failed', fails: fails, error: err.message });
            return;
        }
        self._log('restored the original carplay; the map is off until Enable map re-applies it');
        self._clear();
        cb({ action: 'restored', fails: fails });
    });
};

Recovery.prototype._clear = function () {
    var st = this._load();
    this._save({ fails: 0, arm: null, starts: st.starts });
};

/* One watcher poll. Between systemctl probes a tick only checks that the main
 * PID it saw is still in /proc. A main PID gone from /proc is a crash when the
 * unit's Result is not success, patchd did not kill it, and the system is not
 * stopping. A carplay continuously active with one PID for HEALTHY_MS
 * confirms the boot. cb(result) for tests; result.action is 'skip' | 'watch'
 * | 'confirmed' | 'crash' | 'started' | 'start-skipped'. */
Recovery.prototype.tick = function (cb) {
    cb = cb || function () {};
    var self = this;
    if (this._busy || this.restoring) { cb({ action: 'skip' }); return; }
    var now = this._now();
    if (this._startAt !== null && now >= this._startAt) { this._startDue(cb); return; }
    if (this._lastPid && this._alive(this._lastPid) && now - this._lastProbe < PROBE_MS) { cb({ action: this._healthy(now) }); return; }
    this._busy = true;
    this._probe(function (info) {
        self._lastProbe = now;
        var active = info.state === 'active';
        if (self._lastPid && info.pid === self._lastPid && (active || self._alive(info.pid))) {
            self._busy = false;
            cb({ action: self._healthy(now) });
            return;
        }
        var gone = self._lastPid;
        self._lastPid = active ? info.pid : 0;
        self._activeSince = active ? now : null;
        if (!gone || info.result === 'success' || !info.result || gone === self._killed()) {
            self._busy = false;
            cb({ action: 'watch' });
            return;
        }
        self._systemState(function (sys) {
            if (sys === 'stopping') { self._busy = false; cb({ action: 'watch' }); return; }
            self._onCrash(gone, info, cb);
        });
    });
};

Recovery.prototype._healthy = function (now) {
    if (this._activeSince === null || now - this._activeSince < this.healthyMs) return 'watch';
    var st = this._load();
    if (this._armed(st) && !st.arm.confirmed) {
        st.arm.confirmed = true;
        this._save(st);
        this._log('carplay healthy');
        return 'confirmed';
    }
    return 'watch';
};

/* A crash: recorded at once (the next moment can be a reboot), then, for a
 * patched binary, a restore at the threshold, then a start if recmgr allows
 * one. */
Recovery.prototype._onCrash = function (pid, info, cb) {
    var self = this;
    this._log('carplay (PID ' + pid + ') died: ' + info.result);
    var st = this._load();
    if (this._armed(st)) { st.arm.crashes++; this._save(st); }
    this._classify(function (cls) {
        if (!cls.ok || !cls.patchActive) {
            if (cls.ok && (st.fails || st.arm)) self._clear();
            self._scheduleStart();
            self._busy = false;
            cb({ action: 'crash' });
            return;
        }
        if (!self._armed(st)) { st.arm = newArm(self.bootId); st.arm.crashes = 1; self._save(st); }
        var total = st.fails + st.arm.crashes;
        self._log('carplay crashes while patched: ' + total);
        if (total < self.threshold) { self._scheduleStart(); self._busy = false; cb({ action: 'crash', fails: total }); return; }
        self._restoreWith(cls, total, function (r) {
            self._scheduleStart();
            self._busy = false;
            cb({ action: 'crash', fails: total, restore: r.action });
        });
    });
};

Recovery.prototype._startsThisBoot = function (st) { return st.starts && st.starts.boot === this.bootId ? st.starts.n : 0; };

Recovery.prototype._scheduleStart = function () {
    if (!this._recmgrLoaded('carplay')) {
        this._log('carplay stays down: recmgr did not load a carplay entry this boot');
        return;
    }
    var n = this._startsThisBoot(this._load());
    if (n >= START_DELAYS_MS.length) {
        this._log('carplay stays down: started ' + n + ' times this boot already');
        return;
    }
    this._startAt = this._now() + START_DELAYS_MS[n];
};

/* The scheduled start: only while carplay is down, the system is not
 * stopping, and patchd is not writing (it holds the remount lock; the start
 * waits for the next tick). */
Recovery.prototype._startDue = function (cb) {
    var self = this;
    this._busy = true;
    function done(action) { self._busy = false; cb({ action: action }); }
    this._probe(function (info) {
        if (info.state === 'active' || info.state === 'activating') { self._startAt = null; done('start-skipped'); return; }
        self._systemState(function (sys) {
            if (sys === 'stopping') { self._startAt = null; done('start-skipped'); return; }
            if (!self._lock.tryAcquire()) { done('watch'); return; }
            var st = self._load();
            st.starts = { boot: self.bootId, n: self._startsThisBoot(st) + 1 };
            self._save(st);
            self._startAt = null;
            self._log('starting carplay (start ' + st.starts.n + ' this boot)');
            self._start(function (err) {
                self._lock.release();
                if (err) self._log('starting carplay failed: ' + err.message);
                done('started');
            });
        });
    });
};

/* SIGTERM while the system stops (an orderly reboot) exempts a boot with no
 * crash; a SIGTERM from a service restart does not. */
Recovery.prototype.onShutdown = function (cb) {
    var self = this;
    var st = this._load();
    if (!this._armed(st) || st.arm.crashes || st.arm.clean) { cb(); return; }
    this._systemState(function (sys) {
        if (sys === 'stopping') { st.arm.clean = true; self._save(st); }
        cb();
    });
};

module.exports = { Recovery: Recovery, tally: tally, realClassify: realClassify, realRestore: realRestore, realProbeCarplay: realProbeCarplay };

/* ---- run as the boot step or the watcher ---- */

/* The boot step always exits 0: carplay's start never waits on its failure. */
function runBoot() {
    var rec = new Recovery({});
    rec.startBoot(function (r) { log('boot check: ' + r.action); process.exit(0); });
    /* A stop mid-restore lets the restore finish, so / is not left writable. */
    process.on('SIGTERM', function () { if (!rec.restoring) process.exit(0); });
}

function runWatcher() {
    var rec = new Recovery({});
    var timer = null;
    var starting = true;
    var stopping = false;
    function finish() { if (timer) clearInterval(timer); rec.onShutdown(function () { process.exit(0); }); }
    rec.startBoot(function () {
        starting = false;
        if (stopping) { finish(); return; }   /* a stop arrived mid-restore: let it complete, then exit */
        /* Polled even with no patch to watch: the service stays up, since
         * Restart=always would otherwise start it again every few seconds
         * and the deploy tool's health check takes that for a crash loop. */
        timer = setInterval(function () { rec.tick(); }, TICK_MS);
    });
    function stop() { stopping = true; if (!starting) finish(); }   /* else finish() runs when startBoot returns */
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

if (require.main === module) {
    if (process.argv[2] === 'boot') runBoot();
    else runWatcher();
}
