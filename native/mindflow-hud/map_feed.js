// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Map-only HUD feed. The HUD app sends the car's own GNSS fix from BMW's
// Positioning interface ({cmd:'position', raw, current}); this answers the
// renderer's /route, /state and /mapbox-config in-process, in the shapes the
// Google-route feed used. There is no route: /route is a short stub ahead of the
// car along its heading (marked mapOnly, not drawn), so the map follows the
// car's position and heading. Turn guidance stays in Google Maps' own displays.
const fs = require('fs');

// Mapbox token: a private override (a user's own mindflow-hud-routing tool), else the
// public token this tool ships in mapbox.json.
const ROUTING = '/var/opt/mindflow-hud-routing/current/routing.json', BUNDLED = require('path').join(__dirname, 'mapbox.json');
const MAX_AGE_S = 3;          // a fix older than this (measured or since receipt) is not shown
const AHEAD_M = 150;          // length of the heading stub
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
        this.token = null; this.count = 0; this.log = o.log || null; this.loggedAt = 0;
    }
    // {cmd:'position', raw: RawGNSSPositionData, current: CurrentLocation|null}
    position(msg) {
        const raw = msg && msg.raw, pos = raw && raw.position;
        const fixType = raw && raw.fixType, acc = FIX_OK[fixType];
        const t = this.clock();
        if (this.log && this.wall() - this.loggedAt >= 1000) { this.loggedAt = this.wall(); this.log({ src: 'map', field: 'position', value: { raw, current: msg.current || null } }); }
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
        // speed and course from successive fixes; BMW's heading when moving slowly or when it is all there is
        let speed = null;
        if (this.fix) {
            const dt = (fix.at - this.fix.at) / 1e9, d = metres(this.fix, fix);
            if (dt > 0.2 && dt < 5) { speed = d / dt; if (d >= 3 && speed >= 1.5) this.heading = bearing(this.fix, fix); }
        }
        const cur = msg.current && Number(msg.current.heading), rh = Number(raw.heading);
        if (this.heading === null || speed === null || speed < 1.5) {
            if (Number.isFinite(cur) && cur !== 0) this.heading = (cur % 360 + 360) % 360;
            else if (Number.isFinite(rh) && rh !== 0) this.heading = (rh % 360 + 360) % 360;
        }
        fix.speed = speed; this.prev = this.fix; this.fix = fix; this.count++; this.reason = null;
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
module.exports = { MapFeed, utcMs, bearing, ahead };
