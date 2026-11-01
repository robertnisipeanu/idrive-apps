#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* recovery.js — the boot-time safety net for the carplay patch. Enabling the
 * map rewrites /usr/bin/carplay; a bad interaction (e.g. the requestStream
 * self-start throwing on a phone connect, PATCH.md "Exception risk") can crash
 * carplay. On the stock recmgr list carplay is in neither restart section, so a
 * carplay death reboots the head unit — and the patched binary is still on
 * disk, so it can crash again at the next boot: a boot loop that leaves the
 * user no HMI to turn the map off from.
 *
 * This service restores the verified known-good original automatically when it
 * sees that pattern, using the same vetted, reversible carplay_patch.js revert
 * (verified backup, refuses a binary it does not recognise as a patched form of
 * the backup's build) that Disable map
 * uses, with / remounted read-write only for the write and read-only again
 * after. It never kills or restarts carplay and never reboots: it only replaces
 * the on-disk binary, which the next carplay start (the crash's own restart, or
 * the next boot) picks up — so it cannot itself cause a reboot loop.
 *
 * The trigger is a persisted counter (survives reboots). Each boot that comes
 * up with the patch on disk is "armed" as unconfirmed. A boot that neither
 * reaches a healthy carplay nor shuts down cleanly (a crash power-cycle leaves
 * no clean marker) is counted as a failed patched boot at the next boot. After
 * THRESHOLD failed patched boots in a row, the next boot restores the original
 * before carplay can crash again. A healthy carplay (continuously active for
 * HEALTHY_MS) clears the counter; a clean shutdown (SIGTERM) exempts that boot.
 *
 * It is only ever armed/counted while the on-disk carplay is a recognised
 * patched build with a backup present; a stock binary, or one a firmware
 * update replaced (unrecognised), is left untouched and the counter is
 * cleared — recovery never downgrades a binary it does not recognise. A classify that cannot be read leaves the counter as it is.
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
var STATE = process.env.WOC_RECOVERY_STATE || '/var/opt/waze-on-cluster/boot-recovery.json';
var SOCK = process.env.WOC_PATCH_SOCK || '/dev/shm/waze-on-cluster/patch.sock';
var PENDING = path.join(path.dirname(SOCK), 'activation-pending');
/* The running (patched) binary, kept hard-linked while restoring so replacing
 * TARGET by rename does not leave an unlinked-but-open file that blocks the
 * read-only remount — the same guard patchd uses (patchd.js, RUNNING). */
var RUNNING = TARGET + '.woc-running';
var MOUNT = process.env.WOC_MOUNT || '/bin/mount';
var PROC_MOUNTS = process.env.WOC_PROC_MOUNTS || '/proc/mounts';
var BOOT_ID = process.env.WOC_BOOT_ID || '/proc/sys/kernel/random/boot_id';
var SYSTEMCTL = process.env.WOC_SYSTEMCTL || 'systemctl';

var THRESHOLD = parseInt(process.env.WOC_RECOVERY_THRESHOLD, 10) || 2;
var HEALTHY_MS = parseInt(process.env.WOC_RECOVERY_HEALTHY_MS, 10) || 60000;
var POLL_MS = parseInt(process.env.WOC_RECOVERY_POLL_MS, 10) || 3000;

var lock = require('./remount_lock.js');

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

function readBootId() { try { return (fs.readFileSync(BOOT_ID, 'utf8') || '').trim(); } catch (e) { return ''; } }

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
 * / read-write only for the write and read-only again after. The running
 * patched binary is hard-linked to RUNNING first so the rename does not leave
 * an unlinked-but-open file that would keep / writable; a RUNNING a process
 * still runs (a change pending this boot) is that link already and stays. With
 * both RUNNING and TARGET run by processes there is no name left to keep TARGET
 * linked, so the restore waits for the next boot. Yields to patchd if the
 * lock is held (cb with a 'busy' error; startBoot then keeps the counter and the
 * next boot retries). */
function realRestore(cb) {
    if (lock.holds(RUNNING, TARGET) && lock.inUse(TARGET)) { cb(new Error('processes run both ' + TARGET + ' and ' + RUNNING + '; deferring')); return; }
    if (!lock.tryAcquire()) { cb(new Error('remount lock held; deferring')); return; }
    var released = false;
    function finish(err) { if (!released) { released = true; lock.release(); } cb(err); }
    remount(true, function (mErr) {
        if (mErr) { finish(new Error('remount rw: ' + mErr.message)); return; }
        if (!lock.holds(RUNNING, TARGET)) {
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

/* carplay.service's current main PID and whether it is active. */
function realProbeCarplay(cb) {
    cp.execFile(SYSTEMCTL, ['show', 'carplay.service', '-p', 'MainPID', '-p', 'ActiveState'], { timeout: 15000 }, function (err, out) {
        var text = (out || '') + '';
        var pid = /MainPID=(\d+)/.exec(text);
        var active = /ActiveState=(\S+)/.exec(text);
        cb({ pid: pid ? parseInt(pid[1], 10) : 0, active: !!active && active[1] === 'active' });
    });
}

function log(line) { process.stdout.write('[' + new Date().toISOString() + '] recovery: ' + line + '\n'); }

/* ---- the recovery state machine ---- */

function Recovery(opts) {
    opts = opts || {};
    this.statePath = opts.statePath || STATE;
    this.threshold = opts.threshold || THRESHOLD;
    this.healthyMs = opts.healthyMs || HEALTHY_MS;
    this.bootId = opts.bootId || readBootId();
    this._classify = opts.classify || realClassify;
    this._restore = opts.restore || realRestore;
    this._probe = opts.probe || realProbeCarplay;
    this._now = opts.now || Date.now;
    this._log = opts.log || log;

    this.patchActive = false;   /* a restorable patched binary to monitor this boot */
    this.restorable = false;
    this.restoring = false;     /* a restore is running (stop waits for it) */
    this._confirmed = false;
    this._activeSince = null;   /* start of the current continuous-active run */
    this._lastPid = null;
}

Recovery.prototype._load = function () {
    try {
        var st = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        if (st && typeof st === 'object') return { fails: st.fails || 0, arm: st.arm || null };
    } catch (e) {}
    return { fails: 0, arm: null };
};

/* Persist durably: the counter and arm must survive the crash power-cycle this
 * mechanism is built to detect, so fsync before returning. */
Recovery.prototype._save = function (st) {
    try {
        var dir = path.dirname(this.statePath);
        try { fs.mkdirSync(dir, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        fs.writeFileSync(this.statePath, JSON.stringify({ fails: st.fails || 0, arm: st.arm || null }) + '\n');
        var fd = fs.openSync(this.statePath, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (e) { this._log('could not persist state: ' + e.message); }
};

/* The boot-time decision: count a prior failed patched boot, restore at the
 * threshold, otherwise arm this boot. cb(result) for tests; result.action is
 * 'unreadable' | 'idle' | 'restored' | 'restore-failed' | 'restore-unavailable'
 * | 'armed'. */
Recovery.prototype.startBoot = function (cb) {
    cb = cb || function () {};
    var self = this;
    this._classify(function (cls) {
        if (!cls.ok) {
            /* The on-disk state could not be read: leave the counter untouched
             * and do nothing this boot rather than mistake it for stock. */
            self._log('could not read carplay state; leaving the boot-recovery counter as is');
            self.patchActive = false;
            cb({ action: 'unreadable' });
            return;
        }
        self.patchActive = !!cls.patchActive;
        self.restorable = !!cls.restorable;
        var st = self._load();

        if (!cls.patchActive) {
            /* Stock, or a binary we do not recognise: nothing to protect, and a
             * firmware update must not be counted. Clear any stale counter. */
            self._save({ fails: 0, arm: null });
            self.patchActive = false;
            cb({ action: 'idle' });
            return;
        }

        /* The previous patched boot failed if it was armed unconfirmed and never
         * cleanly shut down (a crash power-cycle leaves it unconfirmed). */
        if (st.arm && st.arm.boot !== self.bootId && st.arm.state === 'unconfirmed') {
            st.fails = (st.fails || 0) + 1;
            self._log('previous patched boot did not confirm; failed patched boots now ' + st.fails);
        }

        if (st.fails >= self.threshold) {
            if (!cls.restorable) {
                /* Patched and looping but no verified backup to restore from. */
                self._log('WARNING: ' + st.fails + ' failed patched boots but no restorable backup; leaving carplay as is');
                st.arm = { boot: self.bootId, state: 'unconfirmed' };
                self._save(st);
                cb({ action: 'restore-unavailable', fails: st.fails });
                return;
            }
            self._log('restoring the original carplay after ' + st.fails + ' failed patched boots');
            self.restoring = true;
            self._restore(function (err) {
                self.restoring = false;
                if (err) {
                    /* Keep the counter so the next boot retries; re-arm this boot. */
                    self._log('boot recovery restore failed: ' + err.message);
                    st.arm = { boot: self.bootId, state: 'unconfirmed' };
                    self._save(st);
                    cb({ action: 'restore-failed', fails: st.fails, error: err.message });
                    return;
                }
                self._log('restored the original carplay; the map is off until Enable map re-applies it');
                self._save({ fails: 0, arm: null });
                self.patchActive = false;    /* stock now: nothing to monitor */
                cb({ action: 'restored', fails: st.fails });
            });
            return;
        }

        /* Below the threshold: arm this boot and watch carplay. */
        st.arm = { boot: self.bootId, state: 'unconfirmed' };
        self._save(st);
        cb({ action: 'armed', fails: st.fails });
    });
};

/* One monitor poll: a healthy carplay (continuously active for HEALTHY_MS)
 * clears the loop counter and marks this boot confirmed, so it is never counted
 * as a failed boot. A carplay restart (a new main PID) breaks the run. */
Recovery.prototype.tick = function (cb) {
    cb = cb || function () {};
    var self = this;
    if (!this.patchActive || this.restoring) { cb({ action: 'skip' }); return; }
    this._probe(function (info) {
        var now = self._now();
        if (info.pid && info.pid !== self._lastPid) {
            self._lastPid = info.pid;
            self._activeSince = null;   /* a restart breaks the continuous-active run */
        }
        if (info.active) {
            if (self._activeSince === null) self._activeSince = now;
            if (!self._confirmed && now - self._activeSince >= self.healthyMs) {
                self._confirmed = true;
                var st = self._load();
                st.fails = 0;
                if (st.arm) st.arm.state = 'confirmed';
                self._save(st);
                self._log('carplay healthy; cleared the boot-recovery counter');
                cb({ action: 'confirmed' });
                return;
            }
        } else {
            self._activeSince = null;
        }
        cb({ action: self._confirmed ? 'confirmed' : 'watch' });
    });
};

/* A clean shutdown (SIGTERM) exempts this boot: an armed, not-yet-confirmed
 * boot that stops normally is not a crash, so the next boot must not count it. */
Recovery.prototype.onShutdown = function () {
    if (!this.patchActive) return;
    var st = this._load();
    if (st.arm && st.arm.state === 'unconfirmed') { st.arm.state = 'clean'; this._save(st); }
};

module.exports = { Recovery: Recovery, realClassify: realClassify, realRestore: realRestore, realProbeCarplay: realProbeCarplay };

/* ---- run as the service ---- */
function runMain() {
    var rec = new Recovery({});
    var timer = null;
    var starting = true;
    var stopping = false;
    function finish() { if (timer) clearInterval(timer); rec.onShutdown(); process.exit(0); }
    rec.startBoot(function () {
        starting = false;
        if (stopping) { finish(); return; }   /* a stop arrived mid-restore: let it complete, then exit */
        /* Polled even with nothing to watch (tick skips then): the service
         * stays up, since Restart=always would otherwise start it again every
         * few seconds and the deploy tool's health check takes that for a
         * crash loop. */
        timer = setInterval(function () { rec.tick(); }, POLL_MS);
    });
    function stop() { stopping = true; if (!starting) finish(); }   /* else finish() runs when startBoot returns */
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

if (require.main === module) runMain();
