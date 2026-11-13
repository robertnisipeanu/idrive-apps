// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The route line, predicted one segment at a time from the next-turn updates
// (BMW navigation's HUD maneuver list) and the car's position: Android Auto
// gives the maneuvers but never the route geometry.
//
//   1. the turn point: ahead of the car along its heading, at the reported distance
//   2. a target past it, offset to the turn's side
//   3. the car -> target leg as a real driving route (Mapbox Directions), so it
//      follows the streets through the turn
//   4. held unchanged while the same maneuver is ahead; re-planned when the
//      maneuver changes or after RE_PLAN_M, so the line never jumps
//
// The renderer trims what is behind the car, so the leg stays usable as it is driven.
const https = require('https'), url = require('url');

const AHEAD_M = 220;        // straight-ahead leg when no turn is known
const PAST_TURN_M = 140;    // how far past the turn the target sits
const SIDE_M = 85;          // its offset to the turn's side
const RE_PLAN_M = 250;      // re-plan after this much driving on the same maneuver
const MIN_TURN_M = 30, MAX_TURN_M = 3000, DEFAULT_TURN_M = 120;
const UNIT_M = { METER: 1, KM: 1000, MILE_UK: 1609.34, MILE_US: 1609.34, YARD: 0.9144, FEET: 0.3048 };
const LEFT = /LEFT/, RIGHT = /RIGHT/;

function metres(a, b) {
    const k = Math.PI / 180, x = (b[0] - a[0]) * k * Math.cos((a[1] + b[1]) / 2 * k), y = (b[1] - a[1]) * k;
    return Math.hypot(x, y) * 6371000;
}
function projectAhead(lon, lat, headingDeg, m) {
    const k = Math.PI / 180, h = headingDeg * k;
    return [lon + m * Math.sin(h) / (111320 * Math.cos(lat * k)), lat + m * Math.cos(h) / 110540];
}
// the maneuver's distance in metres, or null
function turnMetres(m) {
    if (!m || typeof m.distance !== 'string') return null;
    const n = parseFloat(m.distance.replace(',', '.'));
    if (!isFinite(n) || n <= 0) return null;
    const f = UNIT_M[m.unit];
    if (!f) return null;
    const d = n * f;
    return d >= MIN_TURN_M && d <= MAX_TURN_M ? d : null;
}
// what a maneuver turns towards: -1 left, 1 right, 0 straight on
function side(m) {
    if (!m) return 0;
    const v = String(m.direction || m.branch || m.side || '');
    if (m.kind === 'roundabout') return String(m.side || '') === 'LEFT' ? -1 : 1;
    return LEFT.test(v) ? -1 : RIGHT.test(v) ? 1 : 0;
}
// a maneuver's identity: a new one means a new leg
function keyOf(m) {
    if (!m) return 'ahead';
    return [m.kind, m.direction || '', m.branch || '', m.exit === null || m.exit === undefined ? '' : m.exit, m.text || ''].join('|');
}

function directions(token, from, to, timeoutMs) {
    return new Promise((resolve, reject) => {
        const path = '/directions/v5/mapbox/driving/' + from[0].toFixed(6) + ',' + from[1].toFixed(6) + ';' +
            to[0].toFixed(6) + ',' + to[1].toFixed(6) + '?geometries=geojson&overview=full&access_token=' + encodeURIComponent(token);
        // Node 8 (the unit's): no https.get(url, options, callback)
        const opts = url.parse('https://api.mapbox.com' + path);
        const req = https.get(opts, res => {
            if (res.statusCode !== 200) { res.resume(); reject(Error('Directions HTTP ' + res.statusCode)); return; }
            let size = 0; const parts = [];
            res.on('data', p => { size += p.length; if (size > 2 * 1024 * 1024) { req.destroy(Error('Directions response too large')); return; } parts.push(p); });
            res.on('error', () => reject(Error('Directions interrupted')));
            res.on('end', () => {
                try {
                    const j = JSON.parse(Buffer.concat(parts).toString('utf8'));
                    const c = j && j.routes && j.routes[0] && j.routes[0].geometry && j.routes[0].geometry.coordinates;
                    if (!Array.isArray(c) || c.length < 2 || c.length > 20000) { reject(Error('No usable leg')); return; }
                    if (!c.every(p => Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && Math.abs(p[0]) <= 180 && isFinite(p[1]) && Math.abs(p[1]) <= 85)) { reject(Error('Invalid leg geometry')); return; }
                    resolve(c);
                } catch (e) { reject(Error('Invalid Directions response')); }
            });
        });
        req.setTimeout(timeoutMs || 8000, () => req.destroy(Error('Directions timed out')));
        req.on('error', () => reject(Error('Directions connection failed')));
    });
}

class RoutePredict {
    constructor(options) {
        const o = options || {};
        this.token = o.token || null;          // a function or a string
        this.directions = o.directions || directions;
        this.wall = o.wall || Date.now;
        this.maneuver = null; this.plan = null; this.planning = null; this.lastError = null; this.plans = 0;
    }
    setManeuver(m) { this.maneuver = m || null; }
    // where the leg should end: past the turn, on its side; else straight ahead
    target(fix, heading) {
        const m = this.maneuver, d = turnMetres(m), s = side(m);
        if (!m || d === null || (s === 0 && m.kind !== 'roundabout')) return projectAhead(fix.lon, fix.lat, heading, Math.max(AHEAD_M, d || 0));
        const turn = projectAhead(fix.lon, fix.lat, heading, d);
        return projectAhead(turn[0], turn[1], (heading + s * SIDE_M + 360) % 360, PAST_TURN_M);
    }
    plan_(fix, heading, key) {
        const token = typeof this.token === 'function' ? this.token() : this.token;
        if (!token) { this.lastError = 'no Mapbox token'; return; }
        const from = [fix.lon, fix.lat];
        this.planning = key;
        this.directions(token, from, this.target(fix, heading), 8000).then(coords => {
            if (this.planning !== key) return;            // a newer maneuver won
            this.planning = null; this.plans++; this.lastError = null;
            this.plan = { key, coords, from, at: this.wall() };
        }, e => {
            if (this.planning === key) this.planning = null;
            this.lastError = e && e.message || String(e);
        });
    }
    // the leg to draw now; plans in the background when the maneuver or the position has moved on
    coordinates(fix, heading) {
        if (!fix || !isFinite(heading)) return null;
        const key = keyOf(this.maneuver), from = [fix.lon, fix.lat];
        const stale = !this.plan || this.plan.key !== key || metres(this.plan.from, from) > RE_PLAN_M;
        if (stale && this.planning !== key) this.plan_(fix, heading, key);
        if (this.plan && this.plan.key !== key && metres(this.plan.from, from) > RE_PLAN_M * 4) this.plan = null;  // long gone
        return this.plan && this.plan.coords.length >= 2 ? this.plan.coords : null;
    }
    status() {
        return { plans: this.plans, leg: this.plan ? this.plan.coords.length + ' points' : null, planning: !!this.planning, error: this.lastError };
    }
}
module.exports = { RoutePredict, directions, turnMetres, side, keyOf, projectAhead, metres };
