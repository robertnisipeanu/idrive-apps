// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* A single advisory lock shared by patchd and the boot-recovery service so the
 * two never remount / read-write and rewrite /usr/bin/carplay at the same time.
 * Holding it around a remount-rw -> write -> remount-ro window keeps a
 * concurrent operation from writing while the other has already put / back to
 * read-only, which would fail the write and could leave / writable.
 *
 * The lock is a file created with O_EXCL in the socket directory (tmpfs,
 * cleared each boot). A lock older than STALE_MS is taken as abandoned by a
 * killed holder and broken. Every writer gives up without it: a patchd change
 * or hook waits a bounded time, then writes nothing and reports it; recovery
 * yields: its restore reports a failure and keeps the counter, so the next boot
 * retries.
 *
 * inUse(file) is whether a process runs file (a /proc/<pid>/exe is its
 * inode): such a file, once replaced, has to stay linked for / to go
 * read-only again. holds(link, target) is whether link keeps such a
 * replaced binary: a process runs it and it is not target's own file
 * (which target keeps linked).
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');
var path = require('path');

var LOCK = process.env.WOC_REMOUNT_LOCK || '/dev/shm/waze-on-cluster/remount.lock';
var STALE_MS = parseInt(process.env.WOC_REMOUNT_LOCK_STALE_MS, 10) || 120000;
var PROC = process.env.WOC_PROC || '/proc';

function monoMs() { var t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; }
/* Process start time (field 22 of /proc/<pid>/stat), or null when unavailable. */
function procStartTime(pid) {
    try {
        var stat = fs.readFileSync(path.join(PROC, String(pid), 'stat'), 'utf8');
        var rp = stat.lastIndexOf(')');
        if (rp < 0) return null;
        var field22 = stat.slice(rp + 2).split(' ')[19];
        return field22 && /^\d+$/.test(field22) ? field22 : null;
    } catch (e) { return null; }
}
function pidAlive(pid, expectedStart) {
    var alive;
    try { process.kill(pid, 0); alive = true; }
    catch (e) { alive = e.code === 'EPERM'; }
    if (!alive) return false;
    if (expectedStart) {
        var curStart = procStartTime(pid);
        if (curStart !== null) return curStart === expectedStart;
        if (procStartTime(process.pid) !== null) return false;
    }
    return true;
}

function ensureDir(dir) {
    try { fs.mkdirSync(dir, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function tryAcquire() {
    var fd;
    try {
        fd = fs.openSync(LOCK, 'wx');
        var start = procStartTime(process.pid);
        fs.writeSync(fd, process.pid + (start ? ' ' + start : '') + ' ' + new Date().toISOString() + '\n');
        fs.closeSync(fd);
        return true;
    } catch (e) {
        if (e.code === 'ENOENT') { try { ensureDir(path.dirname(LOCK)); } catch (e2) { return false; } return tryAcquire(); }
        if (e.code !== 'EEXIST') return false;
        try {
            var st = fs.statSync(LOCK);
            var text = fs.readFileSync(LOCK, 'utf8');
            var parts = text.trim().split(/\s+/);
            var pid = parseInt((parts[0] || ''), 10);
            var lockStart = /^\d+$/.test(parts[1] || '') ? parts[1] : null;
            if (pid > 0) {
                /* A live holder's lock is never broken on a wall-clock jump; a dead or reused PID is immediately stale. */
                if (pidAlive(pid, lockStart)) return false;
                var st1 = fs.statSync(LOCK);
                if (st1.ino === st.ino && fs.readFileSync(LOCK, 'utf8') === text) fs.unlinkSync(LOCK);
                return tryAcquire();
            }
            if (Date.now() - st.mtime.getTime() > STALE_MS) { fs.unlinkSync(LOCK); return tryAcquire(); }
        } catch (e3) {}
        return false;
    }
}

/* acquire within timeoutMs, polling; cb(true) on success, cb(false) on timeout. */
function acquire(timeoutMs, cb) {
    var deadline = monoMs() + timeoutMs;
    (function attempt() {
        if (tryAcquire()) { cb(true); return; }
        if (monoMs() >= deadline) { cb(false); return; }
        setTimeout(attempt, 100);
    })();
}

/* Release only a lock this process holds, so a process that gave up waiting
 * cannot delete the holder's lock. */
function release() {
    try {
        var parts = fs.readFileSync(LOCK, 'utf8').trim().split(/\s+/);
        if (parts[0] !== String(process.pid)) return;
        var selfStart = procStartTime(process.pid);
        if (selfStart && /^\d+$/.test(parts[1] || '') && parts[1] !== selfStart) return;
        fs.unlinkSync(LOCK);
    } catch (e) {}
}

function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }
/* A process runs the inode `st` (a stat of it, the file maybe unlinked
 * since): its exe is the inode, or it maps it, as a binary translator
 * runs one, its exe being the translator. */
function runs(st) {
    var mapped = ' ' + hex2((st.dev >> 8) & 0xfff) + ':' + hex2((st.dev & 0xff) | ((st.dev >> 12) & 0xfff00)) + ' ' + st.ino + ' ';
    var pids = [];
    try { pids = fs.readdirSync(PROC).filter(function (n) { return /^\d+$/.test(n); }); } catch (e) {}
    return pids.some(function (pid) {
        try { var x = fs.statSync(path.join(PROC, pid, 'exe')); if (x.ino === st.ino && x.dev === st.dev) return true; } catch (e) {}
        try { return fs.readFileSync(path.join(PROC, pid, 'maps'), 'latin1').indexOf(mapped) >= 0; } catch (e) { return false; }
    });
}

function inUse(file) {
    try { return runs(fs.statSync(file)); } catch (e) { return false; }
}

function holds(link, target) {
    var a, b;
    try { a = fs.statSync(link); } catch (e) { return false; }
    try { b = fs.statSync(target); } catch (e) { b = null; }
    return !(b && a.ino === b.ino && a.dev === b.dev) && inUse(link);
}

module.exports = { acquire, release, tryAcquire, runs, inUse, holds };
