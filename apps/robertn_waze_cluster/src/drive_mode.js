// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/**
 * drive_mode - the car's driving mode, for Hide HUD map in Sport mode. Runs
 * from the app's start, page shown or not.
 *
 * The reader reads the driving experience switch
 * (de.bmw.infotainment.drivingexcitement.FES, field
 * statusFESVehicleDynamicSwitchHMI, its actualValueModeDrivingExperience),
 * read-only, and takes the head unit's notification of each change where
 * the field has one. No mode counts only when the head unit has no FES
 * proxy or no such field, for good: the HUD map then stays shown in every
 * mode. A read that fails, times out or gives no mode changes nothing, and
 * a proxy that is slow to set up or fails to start is set up again later.
 *
 * DriveModeSync tells the render whether the car is in a Sport mode,
 * {"cmd":"drive","sport":"0"|"1"}, only while the setting is in use (the
 * map on the HUD and Hide HUD map in Sport mode ticked): a Sport mode when
 * it starts and every RESEND_MS while it lasts, since the render counts one
 * for 90 s only, so a mode this no longer reports never keeps the map away;
 * its end once. It goes through the page's own render connection while the
 * page is open (it owns the render's control socket), else through a short
 * connection of its own, whose first status line says whether the setting
 * is in use. Not in use, nothing is told and no connection made until the
 * page's status says otherwise or recheck() (another driver profile's
 * settings may be in effect). The render down or owned by another is tried
 * again at the next read.
 */
'use strict';

const net = require('net');
const { within } = require('./profile_sync.js');
const { RENDER_PATH } = require('./waze_cluster_control.js');

/* the mode is read this often beside the head unit's notifications */
const POLL_MS = 10000;
/* a Sport mode is told again this often: a third of the render's hold */
const RESEND_MS = 30000;
/* how long a short render connection waits for the render's status, and stays for its command */
const STATUS_MS = 1500;
const RENDER_HOLD_MS = 800;
/* how many different values of the mode are logged */
const SEEN_MAX = 16;
const READ_MS = 3000;
/* a proxy that failed to start: set up again after this, then less often */
const SETUP_RETRY_MS = 10000;
const SETUP_RETRY_MAX_MS = 300000;
const IFACE = 'de.bmw.infotainment.drivingexcitement.FES';
const INSTANCE = '1';
const FIELD = 'statusFESVehicleDynamicSwitchHMI';
const MEMBER = 'actualValueModeDrivingExperience';
const NONE = null;

/* The driving experience switch's modes on the wire, as idrive7-apps'
 * Redline reads them on cars (its hud.js, driveModeOf): 1-3 Sport, Sport+
 * and Sport Individual, 15, 16 and 23 a plug-in hybrid's Sport, 28
 * XtraBoost; 4-6 Comfort, 7-9 Eco Pro, 10 Adaptive, 17-22 a plug-in
 * hybrid's Hybrid, Electric and battery control. */
const SPORT_NUMBERS = [1, 2, 3, 15, 16, 23, 28];
const OTHER_NUMBERS = [4, 5, 6, 7, 8, 9, 10, 17, 18, 19, 20, 21, 22];
const SPORT_NAME = /SPORT|BOOST/;
const OTHER_NAME = /COMFORT|ECO|ADAPTIV|HYBRID|ELECTRIC|BATTERY|TRAFFIC/;

/* A driving mode, a number or a name (or an object with either): true for
 * a Sport mode, false for another mode, null for a value that is not a
 * mode (the switch initialising, the car switching off). */
function sportOf(raw) {
    const v = raw && typeof raw === 'object' ? (raw.name !== undefined ? raw.name : raw.value) : raw;
    if (typeof v === 'number' || (typeof v === 'string' && /^\s*\d+\s*$/.test(v))) {
        const n = Number(v);
        return SPORT_NUMBERS.includes(n) ? true : OTHER_NUMBERS.includes(n) ? false : null;
    }
    if (typeof v !== 'string') {
        return null;
    }
    const name = v.toUpperCase();
    return SPORT_NAME.test(name) ? true : OTHER_NAME.test(name) ? false : null;
}

/* The field's driving mode, or undefined when it holds none. */
function modeIn(value) {
    const m = value && typeof value === 'object' ? value[MEMBER] : undefined;
    return m === null ? undefined : m;
}

/* A reader of the driving mode through the SDK's typed proxy:
 * read() -> Promise<mode | NONE>, NONE only without the proxy or the field,
 * for good; rejected when the read gives nothing to go by. onChange(fn):
 * fn(mode) at each change the head unit notifies. options: readMs,
 * retryMs, retryMaxMs. */
function driveModeReader(someipBuilders, log, options) {
    const o = options || {};
    const readMs = o.readMs || READ_MS;
    const retryMax = o.retryMaxMs || SETUP_RETRY_MAX_MS;
    let retryMs = o.retryMs || SETUP_RETRY_MS;
    let proxy = null;
    let none = false;
    let starting = null;
    let retryAt = 0;
    let changed = null;
    const noMode = (why) => {
        none = true;
        log.warn(`driving mode: ${why}; the HUD map stays shown in every mode`);
        return null;
    };
    /* the head unit's notifications, where the field has them; the reads go on either way */
    const subscribe = (p) => {
        if (typeof p[FIELD].subscribe !== 'function') {
            return;
        }
        Promise.resolve()
            .then(() => p[FIELD].subscribe((v) => {
                const m = modeIn(v);
                if (m !== undefined && changed) {
                    changed(m);
                }
            }))
            .catch((e) => log.info(`driving mode: no notifications (${e && e.message}); read every few seconds`));
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
                    return noMode(`no ${FIELD}`);
                }
                return p.init().then(() => p);
            }, (e) => noMode(`no ${IFACE} proxy (${e && e.message})`)), readMs, `${IFACE} proxy`)
            .then((p) => {
                starting = null;
                proxy = p;
                if (p) {
                    subscribe(p);
                }
                return p;
            }, (e) => {
                starting = null;
                retryAt = Date.now() + retryMs;
                log.info(`driving mode: ${e && e.message}; set up again in ${Math.round(retryMs / 1000)} s`);
                retryMs = Math.min(retryMs * 2, retryMax);
                throw e;
            });
        return starting;
    };
    const read = () => setUp().then((p) => {
        if (!p) {
            return NONE;
        }
        return within(Promise.resolve()
            .then(() => p.waitUntilAvailable(readMs))
            .then(() => p[FIELD].getValue()), readMs * 2, `reading ${FIELD}`)
            .then((v) => {
                const m = modeIn(v);
                if (m === undefined) {
                    throw new Error('no driving mode read');
                }
                return m;
            });
    });
    return { read, onChange: (fn) => { changed = fn; } };
}

/* One command to the render on a connection of its own, sent only while
 * the render's status says the setting is in use: resolves to true (sent),
 * false (not in use) or undefined (no status: the render down, or owned by
 * another). */
function tellOnce(path, msg, statusMs, holdMs) {
    return new Promise((resolve) => {
        const s = net.connect(path);
        let buf = '';
        let over = false;
        const finish = (v) => {
            if (!over) {
                over = true;
                clearTimeout(timer);
                resolve(v);
            }
        };
        const timer = setTimeout(() => {
            s.destroy();
            finish(undefined);
        }, statusMs);
        const onStatus = (status) => {
            const inUse = status.hud === 1 && status.hud_hide_sport === 1;
            if (inUse) {
                s.write(JSON.stringify(msg) + '\n');
                setTimeout(() => s.end(), holdMs);
            } else {
                s.end();
            }
            finish(inUse);
        };
        s.setEncoding('utf8');
        s.on('data', (chunk) => {
            buf += chunk;
            let i;
            while (!over && (i = buf.indexOf('\n')) >= 0) {
                let m = null;
                try {
                    m = JSON.parse(buf.slice(0, i));
                } catch (e) {
                    /* not ours */
                }
                buf = buf.slice(i + 1);
                if (m && m.ev === 'status') {
                    onStatus(m);
                }
            }
        });
        s.on('error', () => finish(undefined));
        s.on('close', () => finish(undefined));
    });
}

class DriveModeSync {
    /* options: control (the page's WazeClusterControl), log, reader (a
     * driveModeReader), changed (called when available() changes),
     * renderPath, pollMs, resendMs, statusMs, holdMs. */
    constructor(options) {
        const o = options || {};
        this._control = o.control || null;
        this._log = o.log || { info() {}, warn() {} };
        this._reader = o.reader;
        this._changed = o.changed || function () {};
        this._renderPath = o.renderPath || RENDER_PATH;
        this._pollMs = o.pollMs || POLL_MS;
        this._resendMs = o.resendMs || RESEND_MS;
        this._statusMs = o.statusMs || STATUS_MS;
        this._holdMs = o.holdMs || RENDER_HOLD_MS;
        /* the car is in a Sport mode (true) or another (false); null until a mode is read */
        this.sport = null;
        this._inUse = undefined;   /* the setting in use, as last seen; undefined: not known */
        this._told = false;        /* a Sport mode is told, its end not yet */
        this._toldAt = 0;
        this._telling = false;
        this._none = false;        /* the head unit has no driving mode */
        this._seen = [];
        this._timer = null;
        this._stopped = true;
    }

    start() {
        if (this._stopped && this._reader) {
            this._stopped = false;
            this._reader.onChange((mode) => this._take(mode));
            this._poll();
        }
    }

    stop() {
        this._stopped = true;
        clearTimeout(this._timer);
        this._timer = null;
    }

    /* False once the head unit is known to have no driving mode to read:
     * the setting then does nothing. */
    available() {
        return !this._none;
    }

    /* The settings may have changed where the page's status does not show
     * it: whether the setting is in use is looked at again. */
    recheck() {
        this._inUse = undefined;
        this.follow();
    }

    /* Tells the render what is due: a Sport mode not told yet or told
     * RESEND_MS ago, or the end of one that was told. */
    follow() {
        if (this._stopped || this._telling || this.sport === null) {
            return;
        }
        const live = this._liveInUse();
        if (live !== undefined) {
            this._inUse = live;
        }
        if (this._inUse === false) {
            this._told = false;
            return;
        }
        const due = this.sport ? !this._told || Date.now() - this._toldAt >= this._resendMs : this._told;
        if (due) {
            this._tell(live === true);
        }
    }

    /* Whether the setting is in use, from the page's render connection:
     * undefined without it. A render without the setting never uses it. */
    _liveInUse() {
        const c = this._control;
        if (!c || !c.render || !c.render.connected() || !c.renderStatus) {
            return undefined;
        }
        return c.hudHideSport() === true && c.hudOn() === true;
    }

    _tell(throughPage) {
        const sport = this.sport;
        const msg = { cmd: 'drive', sport: sport ? '1' : '0' };
        const sent = () => {
            if (this._told !== sport) {
                this._log.info(`driving mode: the render told the car is ${sport ? 'in' : 'not in'} a Sport mode`);
            }
            this._told = sport;
            this._toldAt = Date.now();
        };
        if (throughPage) {
            this._control.render.send(msg);
            sent();
            return;
        }
        this._telling = true;
        tellOnce(this._renderPath, msg, this._statusMs, this._holdMs).then((result) => {
            this._telling = false;
            if (result === true) {
                sent();
            } else if (result === false) {
                this._inUse = false;
                this._told = false;
            }
            /* the mode changed meanwhile: told now; no status: at the next read */
            if (this.sport !== sport) {
                this.follow();
            }
        });
    }

    /* A mode as read or notified: a value that is not a mode keeps the last one. */
    _take(raw) {
        const sport = sportOf(raw);
        const key = JSON.stringify(raw);
        if (!this._seen.includes(key) && this._seen.length < SEEN_MAX) {
            this._seen.push(key);
            this._log.info(`driving mode: ${key} is ${sport === null ? 'not a mode, the last one stays' : sport ? 'a Sport mode' : 'not a Sport mode'}`);
        }
        if (sport === null || sport === this.sport) {
            return;
        }
        this.sport = sport;
        this.follow();
    }

    _poll() {
        Promise.resolve().then(() => this._reader.read()).then((raw) => {
            if (raw === NONE) {
                this._none = true;
                this._changed();
                return;
            }
            this._take(raw);
        }, () => {
            /* nothing to go by: the mode stays */
        }).then(() => {
            this.follow();
            if (!this._stopped && !this._none) {
                this._timer = setTimeout(() => this._poll(), this._pollMs);
            }
        });
    }
}

module.exports = { sportOf, driveModeReader, DriveModeSync, IFACE, INSTANCE, FIELD, MEMBER, POLL_MS, RESEND_MS };
