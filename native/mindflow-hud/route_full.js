// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The full route line. Given a destination coordinate, requests the whole
// driving route from the car to it (the service supplies Vela; Mapbox is the default)
// and serves it so the renderer draws the complete cyan line. Re-requests when
// the destination changes or a reroute is asked for. The destination coordinate
// comes from the service's {cmd:'destination'} input; this module never resolves
// or captures it, only routes to and draws it.
const https = require('https'), url = require('url');

const MIN_REROUTE_MS = 6000;    // never re-request faster than this
const RETRY_AFTER_FAIL_MS = 3000; // after a failed or rejected request
const STEP_MANEUVERS = /^(turn|roundabout|rotary|fork|merge|end of road|on ramp|off ramp|continue|new name|arrive)/i;

function coordOk(c) { return Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && Math.abs(c[0]) <= 180 && isFinite(c[1]) && Math.abs(c[1]) <= 85; }
function metres(a, b) {
    const k = Math.PI / 180, x = (b[0] - a[0]) * k * Math.cos((a[1] + b[1]) / 2 * k), y = (b[1] - a[1]) * k;
    return Math.hypot(x, y) * 6371000;
}

// Mapbox Directions: full geometry + steps. Returns { coordinates, steps } or rejects.
function fetchRoute(token, from, to, timeoutMs) {
    return new Promise(function (resolve, reject) {
        if (!coordOk(from) || !coordOk(to)) { reject(Error('bad route endpoints')); return; }
        var path = '/directions/v5/mapbox/driving/' + from[0].toFixed(6) + ',' + from[1].toFixed(6) + ';' +
            to[0].toFixed(6) + ',' + to[1].toFixed(6) +
            '?geometries=geojson&overview=full&steps=true&access_token=' + encodeURIComponent(token);
        // Node 8 (the unit's): no https.get(url, options, callback)
        var opts = url.parse('https://api.mapbox.com' + path);
        var req = https.get(opts, function (res) {
            if (res.statusCode !== 200) { res.resume(); reject(Error('Directions HTTP ' + res.statusCode)); return; }
            var size = 0, parts = [];
            res.on('data', function (p) { size += p.length; if (size > 6 * 1024 * 1024) { req.destroy(Error('route too large')); return; } parts.push(p); });
            res.on('error', function () { reject(Error('route interrupted')); });
            res.on('end', function () {
                try {
                    var j = JSON.parse(Buffer.concat(parts).toString('utf8'));
                    var r = j && j.routes && j.routes[0];
                    var c = r && r.geometry && r.geometry.coordinates;
                    if (!Array.isArray(c) || c.length < 2 || c.length > 60000 || !c.every(coordOk)) { reject(Error('no usable route geometry')); return; }
                    resolve({ coordinates: c, steps: stepsOf(r), distance: r.distance, duration: r.duration });
                } catch (e) { reject(Error('invalid Directions response')); }
            });
        });
        req.setTimeout(timeoutMs || 12000, function () { req.destroy(Error('Directions timed out')); });
        req.on('error', function () { reject(Error('Directions connection failed')); });
    });
}
// each maneuver along the route: its point, type/modifier and name, for the mismatch check
function pointAt(coordinates, cum, target) {
    for (var i = 1; i < coordinates.length; i++) {
        if (target <= cum[i]) {
            var span = cum[i] - cum[i - 1], t = span > 0 ? Math.max(0, Math.min(1, (target - cum[i - 1]) / span)) : 0;
            return [coordinates[i - 1][0] + (coordinates[i][0] - coordinates[i - 1][0]) * t, coordinates[i - 1][1] + (coordinates[i][1] - coordinates[i - 1][1]) * t];
        }
    }
    return coordinates[coordinates.length - 1];
}
function stepsOf(route) {
    var out = [];
    // Vela candidate steps use cumulative along-distance and a normalized maneuver object.
    if (Array.isArray(route.steps) && route.steps.length && Number.isFinite(route.steps[0].along)) {
        var cum = route.cum || [0];
        if (cum.length !== route.coordinates.length) { cum = [0]; for (var ci = 1; ci < route.coordinates.length; ci++) cum.push(cum[ci - 1] + metres(route.coordinates[ci - 1], route.coordinates[ci])); }
        route.steps.forEach(function (s) {
            var m = s.maneuver || {};
            if (!Number.isFinite(s.along) || /^(depart|destination|arrive)$/.test(m.type || '')) return;
            out.push({ at: pointAt(route.coordinates, cum, s.along), type: m.type || 'continue', modifier: m.side || '', exit: Number.isInteger(m.roundabout_exit) ? m.roundabout_exit : null, name: s.road || '' });
        });
        return out;
    }
    (route.legs || []).forEach(function (leg) {
        (leg.steps || []).forEach(function (s) {
            var m = s.maneuver || {};
            if (!coordOk(m.location) || !STEP_MANEUVERS.test(m.type || '')) return;
            out.push({ at: m.location, type: m.type, modifier: m.modifier || '', name: s.name || '',
                exit: Number.isInteger(m.exit) ? m.exit : null, bearing_after: m.bearing_after, bearing_before: m.bearing_before });
        });
    });
    return out;
}

class RouteFull {
    constructor(options) {
        var o = options || {};
        this.token = o.token || null;            // function or string
        this.fetchRoute = o.fetchRoute || fetchRoute;
        this.wall = o.wall || Date.now;
        this.dest = null; this.destKey = null; this.generation = 0; this.requestSerial = 0;
        this.route = null; this.fetching = false; this.lastFetchAt = 0; this.lastError = null; this.fetches = 0;
    }
    // {cmd:'destination', coord:[lon,lat], address?}; null clears it (trip ended)
    setDestination(coord, address) {
        if (!coordOk(coord)) { this.generation++; this.requestSerial++; this.fetching = false; this.lastFetchAt = -Infinity; this.dest = null; this.destKey = null; this.address = null; this.route = null; this.lastError = null; return; }
        var key = coord[0].toFixed(5) + ',' + coord[1].toFixed(5);
        if (key === this.destKey) return;        // same destination: keep the route
        this.generation++; this.requestSerial++; this.fetching = false; this.lastFetchAt = -Infinity;
        this.dest = [coord[0], coord[1]]; this.destKey = key; this.address = address || null;
        this.route = null;                       // a new destination voids the old line
    }
    setRouteCandidate(candidate, from, reason) {
        if (!candidate || !Array.isArray(candidate.coordinates) || candidate.coordinates.length < 2 || !candidate.coordinates.every(coordOk)) throw Error('Invalid Vela route candidate');
        this.requestSerial++; this.fetching = false;
        this.route = { coordinates: candidate.coordinates, steps: stepsOf(candidate), from: from, at: this.wall(), reason: reason || 'vela', distance: candidate.distance_m, duration: candidate.duration_s };
        this.fetches++; this.lastError = null;
        return this.route;
    }
    // ask for a fresh route from the car's current position (reroute / first fetch)
    plan(from, reason) {
        if (!this.dest || this.fetching) return;
        var now = this.wall();
        if (now - this.lastFetchAt < MIN_REROUTE_MS) return;
        var token = typeof this.token === 'function' ? this.token() : this.token;
        if (!token) { this.lastError = 'no Mapbox token'; return; }
        this.fetching = true; this.lastFetchAt = now;
        var self = this, generation = this.generation, request = ++this.requestSerial, destination = this.dest.slice();
        Promise.resolve().then(function () { return self.fetchRoute(token, from, destination, 12000, reason || 'plan'); }).then(function (r) {
            if (generation !== self.generation || request !== self.requestSerial) return;
            self.fetching = false;
            self.route = { coordinates: r.coordinates, steps: Array.isArray(r.steps) && r.steps.every(s => Array.isArray(s.at)) ? r.steps : stepsOf(r), from: from, at: self.wall(), reason: reason || 'plan' };
            self.fetches++; self.lastError = null;
        }).catch(function (e) {
            if (generation !== self.generation || request !== self.requestSerial) return;
            self.fetching = false; self.lastError = e && e.message || String(e);
            // a rejected/failed correction may be retried sooner than a successful one
            self.lastFetchAt = Math.min(self.lastFetchAt, self.wall() - MIN_REROUTE_MS + RETRY_AFTER_FAIL_MS);
        });
    }
    // the full line to draw; plans on first need
    coordinates(fix) {
        var from = [fix.lon, fix.lat];
        if (this.dest && !this.route && !this.fetching) this.plan(from, 'first');
        return this.route && this.route.coordinates.length >= 2 ? this.route.coordinates : null;
    }
    reroute(fix, reason) { if (this.dest) this.plan([fix.lon, fix.lat], reason || 'reroute'); }  // keep the old (clipped) line until the new route arrives
    steps() { return this.route ? this.route.steps : []; }
    active() { return !!this.dest; }
    status() {
        return { destination: this.destKey, address: this.address || null, line: this.route ? this.route.coordinates.length + ' points' : null,
            steps: this.route ? this.route.steps.length : 0, fetching: this.fetching, fetches: this.fetches, error: this.lastError };
    }
}
module.exports = { RouteFull, fetchRoute, stepsOf, coordOk, metres };
