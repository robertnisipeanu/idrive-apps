// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * route_gate - the Only during a route checkbox: while it is ticked, the map
 * shows (on the cluster, the HUD or both, as Show on says) only while the
 * phone guides a route, and BMW's own content shows otherwise. Runs from the
 * app's start, page shown or not.
 *
 * Whether the phone guides a route: CarPlay's and Android Auto's
 * projectedGuidanceActive (de.bmw.infotainment.a4a.carplay.CarPlayManager,
 * CarPlayManagerInst1; de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.
 * AndroidAutoProjectedManager, AndroidAutoProjectedManagerInst1), read-only:
 * subscribed, and read every POLL_MS. It is the phone's own route state, so
 * it is the same for every navigation app (Waze, Apple Maps, Google Maps).
 * BMW's own guidance state stays inactive during a phone's route. The
 * proxies are set up only while the box is ticked; one that fails is set up
 * again SETUP_RETRY_MS later, doubling up to SETUP_RETRY_MAX_MS.
 *
 * holds() is true while the map is held back: the box ticked, no route,
 * and END_HOLD_MS gone since the last route ended (a re-route or a lost
 * signal does not take the map away). Where neither proxy exists on the
 * head unit, nothing is held. The render goes on decoding the phone's
 * stream while the map is held back, so the map shows at once when a route
 * starts (the phone sends a keyframe only when its stream starts).
 *
 * Holding back is the render's cluster and hud switches turned off, never
 * saved: patchd keeps Show on as chosen, and the render's next start reads
 * it. The gate keeps the settings in effect (wanted: {cluster, hud}, 0|1) to
 * put back when a route starts; view(s) gives the settings as the render
 * is to show them now, and the page shows the wanted ones. A change goes to
 * the render through the page's connection while the page is open (the
 * control's sendRender), else through a short connection of its own, which
 * reads the render's first status (its wanted settings, when not yet known).
 * While it holds and the page is closed, it looks again every CHECK_MS, so
 * a render started again with the saved settings is held back again.
 *
 * The box is the app's own: saved in the app's data folder (FILE_NAME in
 * its working directory), one for every driver.
 */
'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');

const FILE_NAME = 'route-gate.json';
const FIELD = 'projectedGuidanceActive';
const SOURCES = [
    { name: 'CarPlay', iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', instance: 'CarPlayManagerInst1' },
    { name: 'Android Auto', iface: 'de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager',
        instance: 'AndroidAutoProjectedManagerInst1' }
];
const POLL_MS = 5000;
const READ_MS = 3000;
const END_HOLD_MS = 10000;
const CHECK_MS = 30000;
const SETUP_RETRY_MS = 10000;
const SETUP_RETRY_MAX_MS = 300000;
/* how long a short render connection stays for its status and commands */
const RENDER_HOLD_MS = 800;

function within(p, ms, what) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
        p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
}

/* A field's value, or the event's output that carries it: true, false, or null for neither. */
function guiding(v) {
    const b = v && typeof v === 'object' ? v[FIELD] : v;
    return b === true || b === 1 ? true : b === false || b === 0 ? false : null;
}

const bit = (v) => (v === 1 || v === true ? 1 : 0);

/* The render's commands for cluster and hud: a display turned on first. */
function switches(s) {
    return ['cluster', 'hud'].sort((a, b) => bit(s[b]) - bit(s[a])).map((d) => ({ cmd: d, on: bit(s[d]) ? '1' : '0' }));
}

/* One source's route state through the SDK's typed proxy. onValue(true|false)
 * for each value read or sent. */
class RouteSource {
    constructor(source, someipBuilders, log, o, onValue) {
        this.name = source.name;
        this._source = source;
        this._builders = someipBuilders;
        this._log = log;
        this._readMs = o.readMs || READ_MS;
        this._retryFirst = o.setupRetryMs || SETUP_RETRY_MS;
        this._retryMs = this._retryFirst;
        this._retryMax = o.setupRetryMaxMs || SETUP_RETRY_MAX_MS;
        this._onValue = onValue;
        this.value = null;      /* true, false, or null while not known */
        this.none = false;      /* the head unit has no such proxy or field, for good */
        this._proxy = null;
        this._starting = null;
        this._retryAt = 0;
        this._subscribed = false;
    }

    _setUp() {
        if (this._proxy || this.none) {
            return Promise.resolve(this._proxy);
        }
        if (this._starting) {
            return this._starting;
        }
        if (Date.now() < this._retryAt) {
            return Promise.resolve(null);
        }
        const { iface, instance } = this._source;
        this._starting = within(Promise.resolve()
            .then(() => this._builders.buildTypedProxy(iface, instance))
            .then((p) => {
                if (!p || !p[FIELD] || typeof p[FIELD].getValue !== 'function') {
                    this.none = true;
                    this._log.warn(`route: ${this.name} has no ${FIELD} on this head unit`);
                    return null;
                }
                return p.init().then(() => p);
            }, (e) => {
                this.none = true;
                this._log.warn(`route: no ${this.name} proxy on this head unit (${e && e.message})`);
                return null;
            }), this._readMs, `${this.name} proxy`)
            .then((p) => {
                this._starting = null;
                this._proxy = p;
                this._retryMs = this._retryFirst;
                return p;
            }, (e) => {
                this._starting = null;
                this._retryAt = Date.now() + this._retryMs;
                this._log.info(`route: ${e && e.message}; ${this.name} set up again in ${Math.round(this._retryMs / 1000)} s`);
                this._retryMs = Math.min(this._retryMs * 2, this._retryMax);
                return null;
            });
        return this._starting;
    }

    _subscribe(p) {
        const f = p[FIELD];
        if (this._subscribed || typeof f.subscribe !== 'function') {
            return;
        }
        this._subscribed = true;
        Promise.resolve()
            .then(() => f.subscribe((v) => this._take(guiding(v))))
            .catch((e) => {
                this._subscribed = false;
                this._log.info(`route: ${this.name} not subscribed (${e && e.message}); read every ${POLL_MS / 1000} s`);
            });
    }

    /* Reads the field once; a read that fails leaves the value as it was. */
    read() {
        return this._setUp().then((p) => {
            if (!p) {
                return;
            }
            return within(Promise.resolve().then(() => p[FIELD].getValue()), this._readMs, `${this.name} read`)
                .then((v) => {
                    this._subscribe(p);
                    this._take(guiding(v));
                }, () => {});
        });
    }

    _take(v) {
        if (v === null || v === this.value) {
            return;
        }
        this.value = v;
        this._log.info(`route: ${this.name} ${v ? 'guides a route' : 'guides no route'}`);
        this._onValue(v);
    }
}

class RouteGate extends EventEmitter {
    /* options: someipBuilders, log, file (the box's file), renderPath,
     * pollMs, endHoldMs, checkMs, readMs, setupRetryMs, setupRetryMaxMs,
     * sources. Emits 'change' when routeOnly(), route(), holds() or the
     * wanted settings may have changed. */
    constructor(options) {
        super();
        const o = options || {};
        this._log = o.log || { info() {}, warn() {} };
        this._file = o.file || path.join(process.cwd(), FILE_NAME);
        this._renderPath = o.renderPath || require('./waze_cluster_control.js').RENDER_PATH;
        this._pollMs = o.pollMs || POLL_MS;
        this._endHoldMs = o.endHoldMs === undefined ? END_HOLD_MS : o.endHoldMs;
        this._checkMs = o.checkMs || CHECK_MS;
        this._routeOnly = false;
        this._endAt = 0;            /* the last route ended: the map stays until then */
        this._timer = null;
        this._endTimer = null;
        this._checkTimer = null;
        this._started = false;
        this._held = null;          /* what the render was last told: true held back, false not */
        this.wanted = null;         /* the settings in effect, {cluster, hud}, null until known */
        this._sendRender = null;    /* the page's render connection while open: (cmds, status) */
        const builders = o.someipBuilders;
        this._sources = (o.sources || SOURCES).map((s) => new RouteSource(s, builders, this._log, o, () => this._update()));
    }

    start() {
        if (this._started) {
            return;
        }
        this._started = true;
        this._routeOnly = this._load();
        this._log.info(`route: Only during a route ${this._routeOnly ? 'ticked' : 'not ticked'}`);
        if (this._routeOnly) {
            this._poll();
        }
        this._apply();
    }

    stop() {
        this._started = false;
        clearTimeout(this._timer);
        clearTimeout(this._endTimer);
        clearTimeout(this._checkTimer);
        this._timer = this._endTimer = this._checkTimer = null;
    }

    /* The page's render connection, while the page is open: send(cmds), and status() its last status. */
    setPageRender(send, status) {
        this._sendRender = send ? { send, status } : null;
        if (!send && this.holds()) {
            this._check();
        }
    }

    routeOnly() {
        return this._routeOnly;
    }

    setRouteOnly(on) {
        on = !!on;
        if (on === this._routeOnly) {
            return;
        }
        this._routeOnly = on;
        this._save(on);
        this._log.info(`route: Only during a route ${on ? 'ticked' : 'unticked'}`);
        if (on) {
            this._poll();
        } else {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._update();
    }

    /* true while the phone guides a route (CarPlay or Android Auto), false while neither does, null while not known */
    route() {
        const vs = this._sources.map((s) => s.value);
        return vs.includes(true) ? true : vs.includes(false) ? false : null;
    }

    /* Whether no route can be read: the head unit has neither proxy. */
    unreadable() {
        return this._sources.every((s) => s.none);
    }

    /* True while the map is held back: the box ticked, no route and its end hold over. */
    holds() {
        return this._routeOnly && !this.unreadable() && this.route() !== true && Date.now() >= this._endAt;
    }

    /* The settings in effect (patchd's, a page's choice): kept, and given as
     * the render is to show them now. */
    view(s) {
        if (s && (s.cluster === 0 || s.cluster === 1) && (s.hud === 0 || s.hud === 1)) {
            this.wanted = { cluster: s.cluster, hud: s.hud };
        }
        return this.holds() ? Object.assign({}, s, { cluster: 0, hud: 0 }) : s;
    }

    /* A render command as it is to go now: a display switched on while held back goes off. */
    command(cmd) {
        if (cmd && (cmd.cmd === 'cluster' || cmd.cmd === 'hud') && 'on' in cmd) {
            const s = Object.assign({}, this.wanted || { cluster: 0, hud: 0 });
            s[cmd.cmd] = bit(cmd.on === '1' || cmd.on === 1 ? 1 : 0);
            this.wanted = s;
            if (this.holds()) {
                return Object.assign({}, cmd, { on: '0' });
            }
        }
        return cmd;
    }

    /* A render status the page's connection got: what it is to show, when it shows other. */
    status(rs) {
        if (!rs || this._held === null || !this._sendRender) {
            return;
        }
        if (this.holds() && (rs.cluster === 1 || rs.hud === 1)) {
            this._sendRender.send(switches({ cluster: 0, hud: 0 }));
        }
    }

    _poll() {
        clearTimeout(this._timer);
        this._timer = null;
        if (!this._started || !this._routeOnly) {
            return;
        }
        Promise.all(this._sources.map((s) => s.read())).catch(() => {}).then(() => {
            /* a value that changed has run _update already; a manager found missing has not */
            this._apply();
            this._changed();
            if (this._started && this._routeOnly && !this._timer) {
                this._timer = setTimeout(() => this._poll(), this._pollMs);
                if (this._timer.unref) {
                    this._timer.unref();
                }
            }
        });
    }

    _update() {
        const route = this.route();
        if (route === true) {
            this._wasRoute = true;
        } else if (this._wasRoute) {
            /* the route just ended: the map stays END_HOLD_MS */
            this._wasRoute = false;
            this._endAt = Date.now() + this._endHoldMs;
            clearTimeout(this._endTimer);
            this._endTimer = setTimeout(() => this._update(), this._endHoldMs + 10);
        }
        this._apply();
        this._changed();
    }

    /* 'change' when what the page shows of the gate changed. */
    _changed() {
        const now = [this._routeOnly, this.route(), this.holds(), this.unreadable()].join();
        if (now !== this._shown) {
            this._shown = now;
            this.emit('change');
        }
    }

    /* The render to holds(): once each time it changes. */
    _apply() {
        if (!this._started) {
            return;
        }
        const held = this.holds();
        if (held === this._held) {
            return;
        }
        this._held = held;
        this._log.info(`route: map ${held ? 'held back until a route starts' : 'shown as Show on says'}`);
        this._toRender(held);
        clearTimeout(this._checkTimer);
        this._checkTimer = null;
        if (held) {
            this._scheduleCheck();
        }
    }

    _scheduleCheck() {
        this._checkTimer = setTimeout(() => this._check(), this._checkMs);
        if (this._checkTimer.unref) {
            this._checkTimer.unref();
        }
    }

    /* While held back and the page is closed: a render started again with the saved settings is held back again. */
    _check() {
        clearTimeout(this._checkTimer);
        this._checkTimer = null;
        if (!this._started || !this.holds()) {
            return;
        }
        if (!this._sendRender) {
            this._short((rs) => (rs.cluster === 1 || rs.hud === 1 ? switches({ cluster: 0, hud: 0 }) : []));
        }
        this._scheduleCheck();
    }

    _toRender(held) {
        const cmds = (rs) => {
            if (held) {
                if (!this.wanted && rs && (rs.cluster === 0 || rs.cluster === 1) && (rs.hud === 0 || rs.hud === 1)) {
                    this.wanted = { cluster: rs.cluster, hud: rs.hud };
                }
                return switches({ cluster: 0, hud: 0 });
            }
            /* back to Show on: the settings in effect; not known, the render keeps what it shows */
            return this.wanted ? switches(this.wanted) : [];
        };
        if (this._sendRender) {
            this._sendRender.send(cmds(this._sendRender.status()));
        } else {
            this._short(cmds);
        }
    }

    /* A short connection of its own: the render's first status, then cmds(status) (or cmds(null) when none comes). */
    _short(cmds) {
        const sock = net.connect(this._renderPath);
        let buf = '';
        let sent = false;
        const send = (rs) => {
            if (sent) {
                return;
            }
            sent = true;
            cmds(rs).forEach((m) => sock.write(JSON.stringify(m) + '\n'));
            setTimeout(() => sock.end(), RENDER_HOLD_MS);
        };
        const end = setTimeout(() => sock.destroy(), RENDER_HOLD_MS * 4);
        sock.on('connect', () => setTimeout(() => send(null), RENDER_HOLD_MS));
        sock.on('data', (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                let msg = null;
                try {
                    msg = JSON.parse(line);
                } catch (e) {
                    msg = null;
                }
                if (msg && msg.ev === 'status') {
                    send(msg);
                }
            }
        });
        sock.on('error', () => {});
        sock.on('close', () => clearTimeout(end));
    }

    _load() {
        try {
            return JSON.parse(fs.readFileSync(this._file, 'utf8')).routeOnly === true;
        } catch (e) {
            return false;
        }
    }

    _save(on) {
        const tmp = `${this._file}.tmp`;
        try {
            fs.writeFileSync(tmp, JSON.stringify({ routeOnly: on }) + '\n');
            fs.renameSync(tmp, this._file);
        } catch (e) {
            this._log.warn(`route: Only during a route not saved: ${e && e.message}`);
        }
    }
}

module.exports = { RouteGate, SOURCES, FIELD, FILE_NAME, POLL_MS, END_HOLD_MS, CHECK_MS, guiding, switches };
