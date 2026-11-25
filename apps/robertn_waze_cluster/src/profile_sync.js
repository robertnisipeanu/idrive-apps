// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * profile_sync - the map settings per driver profile. Runs from the app's
 * start, page shown or not.
 *
 * Every POLL_MS it reads the head unit's current user account
 * (de.bmw.infotainment.personalization.SessionManager, field
 * currentUserAccountReference: a getter, no notifier), read-only. A profile
 * counts once two reads in a row give the same valid id (PROFILE_ID); no
 * profile counts only when the head unit has no SessionManager proxy or no
 * such field. A read that fails, times out or gives no valid id changes
 * nothing, and a proxy that is slow to set up or fails to start is set up
 * again later. When the profile that counts differs from the one patchd
 * has in effect, it tells patchd {"cmd":"profile","id"} over a short
 * connection of its own. patchd puts that profile's own map settings, or
 * the shared ones, in effect and saves them for the render's next start;
 * when the render is to follow, this moves it to them: through the page's
 * own render connection while the page is open (it owns the render's
 * control socket), else through a short connection of its own. setOwn(on)
 * asks patchd {"cmd":"profile-own","id","on"} the same way, for the Own
 * settings for this driver checkbox; refused, the profile is told again.
 *
 * patchd not running is asked again at the next read; one that does not
 * answer or refuses the command (before profiles) after RETRY_MS. Meanwhile
 * the checkbox is greyed.
 *
 * The page's map settings are written for one driver profile's settings:
 * writeTarget() names the profile and set patchd has in effect, and only
 * while that is the profile that counts (settled()); patchd refuses a write
 * that names any other. Until then, from the app's start until two reads
 * agree, while a read names another profile, or while a tick of the
 * checkbox waits for patchd, nothing names one. The profile is read again
 * when the page opens (refresh) and right before each write
 * (confirmWrite). While patchd says no driver has own settings, the shared
 * settings are the only ones and a write names none. Each answer of
 * patchd's moves the page's render to the settings stored for that
 * profile when it shows others (control.showStored).
 */
'use strict';

const EventEmitter = require('events');
const net = require('net');
const { RENDER_PATH, PATCH_PATH, renderCommands } = require('./waze_cluster_control.js');

const POLL_MS = 5000;
const READ_MS = 3000;
/* a proxy that failed to start: set up again after this, then less often */
const SETUP_RETRY_MS = 10000;
const SETUP_RETRY_MAX_MS = 300000;
const REPLY_MS = 3000;
const RETRY_MS = 60000;
/* reads that fail or give no profile id in a row before, with no profile
 * that counts, the profile counts as unreadable */
const UNREADABLE_READS = 3;
/* how long a short render connection stays for its commands */
const RENDER_HOLD_MS = 800;
const IFACE = 'de.bmw.infotainment.personalization.SessionManager';
const INSTANCE = 'de.bmw.infotainment.personalization.SessionManager';
const FIELD = 'currentUserAccountReference';
/* patchd's PROFILE_ID: what an id may be before it is used as a key */
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+={}-]{0,127}$/;
const NONE = null;

function within(p, ms, what) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
        p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
}

/* A reader of the current user account through the SDK's typed proxy:
 * () -> Promise<id | NONE>. NONE only without the proxy or the field, for
 * good; rejected when the read gives nothing to go by. options: readMs,
 * retryMs, retryMaxMs. */
function sessionReader(someipBuilders, log, options) {
    const o = options || {};
    const readMs = o.readMs || READ_MS;
    const retryMax = o.retryMaxMs || SETUP_RETRY_MAX_MS;
    let retryMs = o.retryMs || SETUP_RETRY_MS;
    let proxy = null;
    let none = false;
    let starting = null;
    let retryAt = 0;
    const warned = {};
    const warn = (why, text) => {
        if (!warned[why]) {
            warned[why] = true;
            log.warn(`driver profiles: ${text}`);
        }
    };
    /* null for good when the head unit has no such proxy or field */
    const setUp = () => {
        if (proxy || none) {
            return Promise.resolve(proxy);
        }
        if (starting) {
            return starting;
        }
        if (Date.now() < retryAt) {
            return Promise.reject(new Error(`${IFACE} proxy: set up again later`));
        }
        starting = within(Promise.resolve()
            .then(() => someipBuilders.buildTypedProxy(IFACE, INSTANCE))
            .then((p) => {
                if (!p || !p[FIELD] || typeof p[FIELD].getValue !== 'function') {
                    none = true;
                    warn('none', `no ${FIELD}; the map settings are shared`);
                    return null;
                }
                return p.init().then(() => p);
            }, (e) => {
                none = true;
                warn('none', `no ${IFACE} proxy (${e && e.message}); the map settings are shared`);
                return null;
            }), readMs, `${IFACE} proxy`)
            .then((p) => {
                starting = null;
                proxy = p;
                return p;
            }, (e) => {
                starting = null;
                retryAt = Date.now() + retryMs;
                log.info(`driver profiles: ${e && e.message}; set up again in ${Math.round(retryMs / 1000)} s`);
                retryMs = Math.min(retryMs * 2, retryMax);
                throw e;
            });
        return starting;
    };
    return () => setUp().then((p) => {
        if (!p) {
            return NONE;
        }
        return within(Promise.resolve()
            .then(() => p.waitUntilAvailable(readMs))
            .then(() => p[FIELD].getValue()), readMs * 2, `reading ${FIELD}`)
            .then((v) => {
                if (typeof v === 'string' && PROFILE_ID.test(v)) {
                    return v;
                }
                if (v !== '') {
                    warn('shape', `${FIELD} is not a profile id`);
                }
                throw new Error('no profile id read');
            });
    });
}

/* One request to a socket on a connection of its own: resolves to the
 * first line done(msg) accepts, null when the connection opened and none
 * came, or undefined when it did not open. */
function askOnce(path, obj, done, ms) {
    return new Promise((resolve) => {
        const s = net.connect(path);
        let buf = '';
        let over = false;
        let linked = false;
        const finish = (v) => {
            if (!over) {
                over = true;
                clearTimeout(timer);
                s.destroy();
                resolve(v === null && !linked ? undefined : v);
            }
        };
        const timer = setTimeout(() => finish(null), ms);
        s.setEncoding('utf8');
        s.on('connect', () => {
            linked = true;
            s.write(JSON.stringify(obj) + '\n');
        });
        s.on('data', (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                let msg = null;
                try {
                    msg = JSON.parse(buf.slice(0, i));
                } catch (e) {
                    /* not ours */
                }
                buf = buf.slice(i + 1);
                if (msg && done(msg)) {
                    finish(msg);
                    return;
                }
            }
        });
        s.on('error', () => finish(null));
        s.on('close', () => finish(null));
    });
}

class ProfileSync extends EventEmitter {
    /* options: control (the page's WazeClusterControl), log, readProfile,
     * patchPath, renderPath, pollMs, replyMs, retryMs. Emits 'change' when
     * profile, own or canChooseOwn() may have changed. */
    constructor(options) {
        super();
        const o = options || {};
        this._control = o.control || null;
        this._log = o.log || { info() {}, warn() {} };
        this._read = o.readProfile;
        this._patchPath = o.patchPath || PATCH_PATH;
        this._renderPath = o.renderPath || RENDER_PATH;
        this._pollMs = o.pollMs || POLL_MS;
        this._replyMs = o.replyMs || REPLY_MS;
        this._retryMs = o.retryMs || RETRY_MS;
        /* the profile patchd has put in effect (NONE: none) and whether it
         * has its own settings; undefined and null until patchd has said */
        this.profile = undefined;
        this.own = null;
        this._askedOwn = null;      /* the checkbox as pressed, until patchd answers */
        this._seen = undefined;     /* the last read's id */
        this._confirmed = undefined; /* the profile that counts: two reads agreed, or NONE for good */
        this._differs = false;      /* the last read was another profile than the one that counts */
        this._failed = 0;           /* reads in a row that gave nothing to go by */
        this._retryAt = 0;
        this._chain = Promise.resolve();
        this._timer = null;
        this._polling = false;
        this._again = null;         /* a read asked for while one runs: whether to tell patchd */
        this._stopped = true;
    }

    start() {
        if (this._stopped && this._read) {
            this._stopped = false;
            this._poll();
        }
    }

    stop() {
        this._stopped = true;
        clearTimeout(this._timer);
        this._timer = null;
    }

    /* patchd has the profile that counts in effect (NONE too: no profile
     * detected), its set known, and no read names another. */
    _inEffect() {
        return this._confirmed !== undefined && this.profile === this._confirmed && this.own !== null && !this._differs;
    }

    canChooseOwn() {
        return typeof this.profile === 'string' && this._inEffect();
    }

    settled() {
        return this._inEffect() && this._askedOwn === null;
    }

    /* What a map setting written now is for: {profile, own} as patchd has
     * them in effect, null while not settled; {} (none named) while patchd
     * says no driver has own settings, when the shared settings are the
     * only ones. */
    writeTarget() {
        if (this._control && this._control.ownSettings === false) {
            return {};
        }
        return this.settled() ? { profile: this.profile, own: this.own ? 1 : 0 } : null;
    }

    /* No profile counts and the reads keep giving nothing to go by. */
    unreadable() {
        return this._confirmed === undefined && this._failed >= UNREADABLE_READS;
    }

    /* Right before a write for w (a writeTarget()): the profile read again;
     * true while w is still what a write is for. A read naming another
     * profile is taken as a poll's, so the page greys until it counts. */
    confirmWrite(w) {
        if (!('profile' in w)) {
            return Promise.resolve(true);
        }
        return Promise.resolve().then(() => this._read()).then((id) => {
            this._take(id, false);
            const now = this.writeTarget();
            return !!now && now.profile === w.profile && now.own === w.own;
        }, () => false);
    }

    /* The checkbox's tick: as pressed until patchd answers, then patchd's. */
    ownShown() {
        return this._askedOwn !== null ? this._askedOwn : this.own === true;
    }

    setOwn(on) {
        if (!this.canChooseOwn() || this._askedOwn !== null || !!on === this.own) {
            return Promise.resolve();
        }
        this._askedOwn = !!on;
        this.emit('change');
        return this._ask({ cmd: 'profile-own', id: this.profile, on: on ? 1 : 0 });
    }

    /* The page opened or patchd connected: the profile read at once, and
     * when it counts, told to patchd again, so the page shows what patchd
     * has for it. */
    refresh() {
        if (!this._stopped) {
            this._poll(true);
        }
    }

    /* One read; with tell, the profile that counts is told to patchd even
     * when patchd has it. */
    _poll(tell) {
        if (this._polling) {
            this._again = !!(this._again || tell);
            return;
        }
        clearTimeout(this._timer);
        this._polling = true;
        Promise.resolve().then(() => this._read()).then((id) => this._take(id, tell), () => {
            /* nothing to go by: the profile that counts stays */
            const was = this.unreadable();
            this._seen = undefined;
            this._failed++;
            if (this.unreadable() !== was) {
                this.emit('change');
            }
        }).then(() => {
            this._polling = false;
            const again = this._again;
            this._again = null;
            if (this._stopped) {
                return;
            }
            if (again !== null) {
                this._poll(again);
            } else {
                this._timer = setTimeout(() => this._poll(), this._pollMs);
            }
        });
    }

    /* A read's id: a profile counts once two reads in a row agree (NONE at
     * once); one that counts and is not patchd's is told. */
    _take(id, tell) {
        const agreed = id === NONE || id === this._seen;
        this._seen = id === NONE ? undefined : id;
        const differs = !agreed && id !== this._confirmed;
        const confirmed = agreed ? id : this._confirmed;
        const was = this.unreadable();
        this._failed = 0;
        /* both before the page redraws: a profile that counts and is not
         * yet patchd's keeps the settings greyed */
        if (differs !== this._differs || confirmed !== this._confirmed || was) {
            this._differs = differs;
            this._confirmed = confirmed;
            this.emit('change');
        }
        if (agreed && (tell || id !== this.profile) && Date.now() >= this._retryAt) {
            return this._ask({ cmd: 'profile', id });
        }
        return undefined;
    }

    /* One command at a time; the reply sets profile and own and, when the
     * settings in effect changed, moves the render. */
    _ask(msg) {
        const run = () => {
            if (this._stopped) {
                this._askedOwn = null;
                return undefined;
            }
            const ev = `${msg.cmd}-reply`;
            /* an answer older than a page write since does not show what is stored */
            const writes = this._control ? this._control.writes : 0;
            return askOnce(this._patchPath, msg, (m) => m.ev === ev || (m.ev === 'refused' && m.cmd === msg.cmd), this._replyMs)
                .then((r) => {
                    if (msg.cmd === 'profile-own') {
                        this._askedOwn = null;
                    }
                    if (r && r.ev === ev && r.ok) {
                        this._retryAt = 0;
                        this.profile = r.id;
                        this.own = r.own === true;
                        this._log.info(`driver profile: ${r.own ? 'its own' : 'the shared'} map settings${r.changed ? ', applied' : ''}`);
                        if (r.settings) {
                            this._toRender(r.settings, r.changed, writes);
                        }
                    } else {
                        /* not taken: asked again (patchd not running: at the
                         * next read; not answered or refused: after
                         * RETRY_MS), the checkbox greyed meanwhile */
                        this._log.warn(`patchd did not take ${msg.cmd}: ${r === undefined ? 'not running' : (r && r.reason) || 'no answer'}`);
                        if (msg.cmd === 'profile') {
                            this.profile = undefined;
                            this.own = null;
                            this._retryAt = r === undefined ? 0 : Date.now() + this._retryMs;
                        } else if (r && this._confirmed !== undefined) {
                            /* refused (patchd has another profile in effect): what it has */
                            this._ask({ cmd: 'profile', id: this._confirmed });
                        }
                    }
                    this.emit('change');
                });
        };
        const p = this._chain.then(run, run);
        this._chain = p.catch(() => {});
        return p;
    }

    /* The render to the settings stored for the profile in effect: through
     * the page's render connection while the page is open, where it shows
     * others (unless the page wrote one after asking); else, when they
     * changed, through a short connection. */
    _toRender(s, changed, writes) {
        const c = this._control;
        if (c && c.render && c.render.connected()) {
            if (changed || c.writes === writes) {
                c.showStored(s, changed);
            }
            return;
        }
        if (!changed) {
            return;
        }
        const cmds = renderCommands(s);
        /* the render down or owned by another: its next start reads the saved settings */
        const sock = net.connect(this._renderPath);
        const end = setTimeout(() => sock.destroy(), RENDER_HOLD_MS * 3);
        sock.on('connect', () => {
            cmds.forEach((m) => sock.write(JSON.stringify(m) + '\n'));
            setTimeout(() => sock.end(), RENDER_HOLD_MS);
        });
        sock.on('error', () => {});
        sock.on('close', () => clearTimeout(end));
    }
}

module.exports = { ProfileSync, sessionReader, IFACE, INSTANCE, FIELD, POLL_MS, UNREADABLE_READS };
