// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Car position and calculated route feed for the HUD renderer. Phone guidance
// checks the full route before its cyan geometry is returned. Without a usable
// line, the heading stub keeps the road map visible and is marked mapOnly.
const fs = require('fs');
const { RouteProgress } = require('./route_match');

// Mapbox token: a private override (a user's own mindflow-hud-routing tool), else the
// public token this tool ships in mapbox.json.
const ROUTING = '/var/opt/mindflow-hud-routing/current/routing.json', BUNDLED = require('path').join(__dirname, 'mapbox.json');
const MAX_AGE_S = 3;          // a fix older than this (measured or since receipt) is not shown
const AHEAD_M = 150;          // length of the heading stub
const PHONE_HOLD_S = 10;      // keep the route line this long after the phone's last maneuver
const FIT_S = 1.6;            // speed and course are fitted over the fixes of this window
const JUMP_M = 15;            // fix this far (+ half the distance driven) from the prediction is a jump
const RESYNC_S = 4;           // a "jump" that persists this long is the real position
const FIX_OK = { FIX_2D: 25, FIX_3D: 12, 2: 25, 3: 12 };   // assumed accuracy per fix type (BMW reports none)
const nowNs = () => { const t = process.hrtime(); return t[0] * 1e9 + t[1]; };

function utcMs(dt) {
    // RawGNSSPositionData.utcDateTime {date:{invalid,year,month,day}, time:{invalid,hour,minute,seconds}}
    const d = dt && dt.date, t = dt && dt.time;
    if (!d || !t || d.invalid || t.invalid || !(d.year > 2000)) return null;
    const ms = Date.UTC(d.year, d.month - 1, d.day, t.hour, t.minute, t.seconds !== undefined ? t.seconds : t.secound);
    return Number.isFinite(ms) ? ms : null;
}
function metres(a, b) {
    const k = Math.PI / 180, x = (b.lon - a.lon) * k * Math.cos((a.lat + b.lat) / 2 * k), y = (b.lat - a.lat) * k;
    return Math.hypot(x, y) * 6371000;
}
function bearing(a, b) {
    const k = Math.PI / 180, y = Math.sin((b.lon - a.lon) * k) * Math.cos(b.lat * k);
    const x = Math.cos(a.lat * k) * Math.sin(b.lat * k) - Math.sin(a.lat * k) * Math.cos(b.lat * k) * Math.cos((b.lon - a.lon) * k);
    return (Math.atan2(y, x) / k + 360) % 360;
}
function ahead(p, headingDeg, m) {
    const k = Math.PI / 180, h = headingDeg * k;
    return [p.lon + m * Math.sin(h) / (111320 * Math.cos(p.lat * k)), p.lat + m * Math.cos(h) / 110540];
}

class MapFeed {
    constructor(options) {
        const o = options || {};
        this.clock = o.clock || nowNs; this.wall = o.wall || Date.now; this.routing = o.routing || ROUTING; this.bundled = o.bundled || BUNDLED;
        this.fix = null; this.prev = null; this.heading = null; this.reason = 'waiting for car GPS';
        this.token = null; this.count = 0;
        this.full = o.full || null; this.match = o.match || null;
        this.maneuver = o.maneuver || null; this.phoneAt = null; this.matchedRoute = null; this.matchedFix = null; this.progress = new RouteProgress();
    }
    // {cmd:'position', raw: RawGNSSPositionData, current: CurrentLocation|null}
    position(msg) {
        const raw = msg && msg.raw, pos = raw && raw.position;
        const fixType = raw && raw.fixType, acc = FIX_OK[fixType];
        const t = this.clock();
        const usable = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
        if (!pos || pos.coordinatesValid === false || !acc || !usable(Number(pos.latitude), Number(pos.longitude))) {
            // No satellite fix (garage, tunnel): BMW navigation's own current location
            // (map-matched, dead-reckoned, valid indoors) keeps the map on screen.
            const c = msg.current;
            if (c && c.coordinatesValid === true && usable(Number(c.latitude), Number(c.longitude))) { this.located(Number(c.latitude), Number(c.longitude), t, 0, 'BMW_LOCATION', 20, msg); return; }
            this.reason = 'car GPS: ' + (fixType || 'no data') + ', no BMW location';
            return;
        }
        const lat = Number(pos.latitude), lon = Number(pos.longitude);
        // measurement age from the receiver's UTC time when the clock agrees; else since receipt
        const utc = utcMs(raw.utcDateTime), measured = utc === null ? null : (this.wall() - utc) / 1000;
        const age = measured !== null && measured >= -1.5 && measured <= MAX_AGE_S ? Math.max(0, measured) : 0;
        this.located(lat, lon, t, age, fixType, acc, msg);
    }
    located(lat, lon, t, age, fixType, acc, msg) {
        const raw = msg.raw || {};
        const fix = { lat, lon, accuracy: acc, at: t - age * 1e9, received: t, fixType };
        const good = this.lastGood;
        // Multipath jump: a fix far from where the last good fix, speed and course put the car.
        // Show the dead-reckoned position instead and mark it (route matching ignores it);
        // a jump that persists RESYNC_S is accepted as the real position.
        if (good && Number.isFinite(good.speed) && good.speed >= 1.5 && this.heading !== null) {
            const dt = (fix.at - good.at) / 1e9;
            if (dt > 0 && dt < MAX_AGE_S) {
                const p = ahead(good, this.heading, good.speed * dt), predicted = { lon: p[0], lat: p[1] };
                // the gate grows with the dead-reckoned time only up to 1 s, so a multipath offset
                // lasting a few seconds is not adopted halfway through (and then jumps back)
                const jumped = metres(predicted, fix) > JUMP_M + 0.5 * good.speed * Math.min(dt, 1);
                if (jumped && (!this.jumpSince || (t - this.jumpSince) / 1e9 < RESYNC_S)) {
                    if (!this.jumpSince) this.jumpSince = t;
                    this.prev = this.fix; this.fix = Object.assign({}, fix, predicted, { speed: good.speed, deadReckoned: true });
                    this.count++; this.reason = null;
                    return;
                }
            }
        }
        this.jumpSince = 0;
        // Speed and course from the fixes; BMW's heading when moving slowly or when it is all there is.
        // Velocity is a least-squares fit over the fixes of the last FIT_S (at least the previous
        // fix): at 5-10 Hz this averages per-fix jitter that a two-point course would turn into
        // tens of degrees of heading error; at 1 Hz it is the plain two-fix course.
        let speed = null;
        const recent = (this.recent || []).filter(p => (fix.at - p.at) / 1e9 > 0 && (fix.at - p.at) / 1e9 < 5);
        let window = recent.filter(p => (fix.at - p.at) / 1e9 <= FIT_S);
        if (!window.length && recent.length) window = recent.slice(-1);
        if (window.length) {
            const k = Math.PI / 180, cx = 6371000 * Math.cos(lat * k) * k, cy = 6371000 * k;
            const pts = window.concat([fix]).map(p => [(p.at - fix.at) / 1e9, (p.lon - lon) * cx, (p.lat - lat) * cy]);
            const n = pts.length, tm = pts.reduce((a, p) => a + p[0], 0) / n, xm = pts.reduce((a, p) => a + p[1], 0) / n, ym = pts.reduce((a, p) => a + p[2], 0) / n;
            let stt = 0, stx = 0, sty = 0;
            for (const p of pts) { stt += (p[0] - tm) * (p[0] - tm); stx += (p[0] - tm) * (p[1] - xm); sty += (p[0] - tm) * (p[2] - ym); }
            const span = -pts[0][0];
            if (span > 0.2 && stt > 0) {
                const vx = stx / stt, vy = sty / stt; speed = Math.hypot(vx, vy);
                if (speed >= 1.5 && speed * span >= 3) this.heading = (Math.atan2(vx, vy) / k + 360) % 360;
            }
        }
        recent.push({ lat, lon, at: fix.at });
        this.recent = recent.slice(-40);
        const cur = msg.current && Number(msg.current.heading), rh = Number(raw.heading);
        if (this.heading === null || speed === null || speed < 1.5) {
            if (Number.isFinite(cur) && cur !== 0) this.heading = (cur % 360 + 360) % 360;
            else if (Number.isFinite(rh) && rh !== 0) this.heading = (rh % 360 + 360) % 360;
        }
        fix.speed = speed; this.prev = this.fix; this.fix = fix; this.lastGood = fix; this.count++; this.reason = null;
    }
    current() {
        const f = this.fix;
        if (!f) return null;
        const age = (this.clock() - f.at) / 1e9;
        return age <= MAX_AGE_S ? Object.assign({ age }, f) : null;
    }
    mapboxToken() {
        if (this.token) return this.token;
        const valid = t => typeof t === 'string' && /^pk\.[A-Za-z0-9_.-]{10,500}$/.test(t);
        try { const v = JSON.parse(fs.readFileSync(this.routing, 'utf8')); if (valid(v.mapbox_token)) this.token = v.mapbox_token; } catch (e) { /* no override */ }
        if (!this.token) { try { const v = JSON.parse(fs.readFileSync(this.bundled, 'utf8')); if (valid(v.token)) this.token = v.token; } catch (e) { /* none */ } }
        return this.token;
    }
    // the renderer's feed: same answers the HTTP feed gave, without a server
    fetch(address) {
        const path = String(address).replace(/^[a-z]+:\/\/[^/]*/, '');
        if (path === '/mapbox-config') {
            const token = this.mapboxToken();
            return token ? Promise.resolve({ token }) : Promise.reject(Error('Mapbox token not configured'));
        }
        const f = this.current();
        if (!f) return Promise.reject(Error(this.reason || 'car GPS fix too old'));
        if (path === '/state') {
            const now = this.clock(), out = { latitude: f.lat, longitude: f.lon, accuracy_m: f.accuracy, sent_elapsed_ns: now, fix_elapsed_ns: f.at, server_age_s: 0, simulated: false };
            if (this.heading !== null) out.heading_deg = this.heading;
            if (f.speed !== null && f.speed !== undefined) out.speed_mps = f.speed;
            return Promise.resolve({ fix: out, status: 'ACTIVE' });
        }
        if (path === '/route') {
            const h = this.heading !== null ? this.heading : 0;
            const phone = this.maneuver ? this.maneuver() : null, now = this.clock();
            // While Android Auto recalculates, its maneuver can be missing for several seconds.
            // Keep the (possibly clipped) line for PHONE_HOLD_S; GPS off-route checks continue.
            if (phone) this.phoneAt = now;
            const held = !phone && this.phoneAt !== null && (now - this.phoneAt) / 1e9 <= PHONE_HOLD_S;
            if (this.full && this.full.active() && (!this.maneuver || phone || held)) {
                let coordinates = this.full.coordinates(f);
                if (coordinates) this.progress.update(this.full.route, f);
                if (coordinates && this.match) {
                    if (this.matchedRoute !== this.full.route) {
                        this.match.onNewRoute(); this.matchedRoute = this.full.route; this.matchedFix = null;
                    }
                    const moving = Number.isFinite(f.speed) && f.speed >= 1.5;
                    if (moving) {
                        // Repeated renderer polls of one fix are not new observations, and a
                        // dead-reckoned position (GPS jump) is no evidence about the route.
                        if (this.matchedFix !== f.at && !f.deadReckoned) {
                            this.match.update(Object.assign({}, f, { routeAlong: this.progress.along, heading: this.heading }), this.full.route, phone); this.matchedFix = f.at;
                        }
                        // The clipped line and local fallback react to the phone at once; Vela is
                        // asked only when the phone's new maneuver has settled.
                        const requested = this.match.takeReroute();
                        const settled = typeof this.match.phoneSettled !== 'function' || this.match.phoneSettled();
                        if ((requested || this.match.state === 'mismatch') && settled) this.full.reroute(f, 'phone-mismatch');
                    } else {
                        this.match.pause(); this.matchedFix = null;
                    }
                    coordinates = this.match.clip(coordinates);
                }
                coordinates = this.progress.display(coordinates, f);
                if (coordinates && coordinates.length >= 2) {
                    return Promise.resolve({ route: { coordinates, traffic: { status: 'unavailable', age_s: 0, intervals: [] }, mapOnly: false, localFallback: !!(this.match&&this.match.state==='mismatch') }, generation: 'destination:' + this.full.destKey });
                }
            } else if (this.match && !(this.full && this.full.active())) {
                // Trip ended. A phone gap during a trip keeps the mismatch and its clip, so the
                // disputed line does not reappear unclipped when the phone returns.
                this.match.onNewRoute(); this.matchedRoute = null;
            }
            return Promise.resolve({ route: { coordinates: [[f.lon, f.lat], ahead(f, h, AHEAD_M)], traffic: { age_s: 0, intervals: [] }, mapOnly: true }, generation: 'map' });
        }
        return Promise.reject(Error('unknown feed path ' + path));
    }
    status() {
        const f = this.current();
        return f ? { gps: 'fix', fixType: f.fixType, age_s: Math.round(f.age * 10) / 10, latitude: Math.round(f.lat * 1e5) / 1e5, longitude: Math.round(f.lon * 1e5) / 1e5, heading: this.heading === null ? null : Math.round(this.heading), speed_mps: f.speed === null || f.speed === undefined ? null : Math.round(f.speed * 10) / 10, fixes: this.count, mapbox: !!this.mapboxToken() }
            : { gps: this.reason || 'car GPS fix too old', fixes: this.count, mapbox: !!this.mapboxToken() };
    }
}
module.exports = { MapFeed, utcMs, bearing, ahead, metres };
