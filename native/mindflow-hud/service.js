// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * HUD map service. Draws a road map of the car's surroundings on the HUD
 * through cluster-render, plus a turn panel, from what the HUD map app
 * (apps/robertn_hud_map) reads from the car over SOME/IP:
 *
 *   {cmd:'position', raw, current}  BMW Positioning (map_feed.js)
 *   {cmd:'guidance', maneuver}      BMW navigation's HUD maneuver list
 *
 * and serves the app's settings page over a Unix socket (status, set, reset).
 * Destination text: a bounded, exact-firmware-guarded aapd reader starts when
 * guidance becomes active; a captured address
 * is resolved by Vela for route geometry, no diagnostic files are recorded.
 */
const fs = require('fs'), net = require('net'), path = require('path');
const Settings = require('./settings'), { Runtime } = require('./runtime'), { MapFeed } = require('./map_feed');
const { bearing, metres: metresBetween } = require('./map_feed');
const { RoutePredict } = require('./route_predict'), { RouteFull } = require('./route_full'), { RouteMatch, phoneSide, phoneMetres, routeSide } = require('./route_match'), { Provider } = require('./vela_routes');
const { DestinationCapture } = require('./destination_capture');

const GUIDANCE_MAX_AGE_MS = 3000;

class Service {
    constructor(options) {
        this.o = options || {};
        this.file = this.o.file || '/var/opt/mindflow-hud/settings.json';
        this.socket = this.o.socket || '/dev/shm/mindflow-hud/control.sock';
        this.settings = Object.assign({}, Settings.defaults);
        this.clients = new Set(); this.error = null; this.timer = null; this.guidance = null; this.renderReport = null;
        this.captureAttempted = false; this.lastCaptureStartedAt = 0; this.guidanceInactiveSince = Date.now(); this.pendingDestinationAddress = null; this.destinationBusy = false; this.lastDestinationAddress = null; this.destinationGeneration = 0;
        try { this.settings = Settings.validate(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') this.error = 'Settings unreadable; defaults active'; }
        this.predict = this.o.predict || new RoutePredict({ token: () => this.mapFeed.mapboxToken() });
        this.vela = this.o.vela || new Provider();
        this.full = this.o.full || new RouteFull({ token: () => this.mapFeed.mapboxToken(), fetchRoute: (token, from, to, timeout, reason) => this.fetchVelaRoute(token, from, to, reason) });
        this.match = this.o.match || new RouteMatch(); this.destError = null;
        this.destinationCapture = this.o.destinationCapture || new DestinationCapture({ onAddress: address => this.setDestination({ address }) });
        this.mapFeed = this.o.mapFeed || new MapFeed({ predict: this.predict, full: this.full, match: this.match, maneuver: () => this.currentGuidance() });
        this.runtime = this.o.runtime || new Runtime({
            feed: 'map://feed', fetch: u => this.mapFeed.fetch(u), guidance: () => this.currentGuidance(), settings: this.settings,
            report: m => { this.renderReport = { message: String(m), at: Date.now() }; }
        });
        this.runtime.applySettings(this.settings);
    }
    status() {
        const r = this.runtime;
        return {
            type: 'status', version: 1, destinationCapture:this.destinationCapture.state, settings: this.settings, visible: r.visible, feed: r.route ? 'active' : 'waiting',
            renderer: r.error ? 'refused' : r.cr.ready ? 'connected' : 'waiting',
            renderer_detail: r.lastRefusal ? r.lastRefusal.op + ': ' + r.lastRefusal.reason : r.lastError || (this.renderReport ? this.renderReport.message : null),
            map: this.mapFeed.status(), guidance: this.currentGuidance(),
            destination: this.destError || (this.full.active() ? 'set' : null), error: this.error || null
        };
    }
    command(msg) {
        if (!msg || typeof msg !== 'object') throw Error('Invalid request');
        if (msg.cmd === 'status') return this.status();
        let next;
        if (msg.cmd === 'reset') next = Object.assign({}, Settings.defaults, { enabled: this.settings.enabled });
        else if (msg.cmd === 'set' && msg.values && typeof msg.values === 'object' && !Array.isArray(msg.values)) {
            if (Object.keys(msg.values).some(k => !Object.prototype.hasOwnProperty.call(Settings.defaults, k))) throw Error('Unknown setting');
            next = Settings.validate(Object.assign({}, this.settings, msg.values));
        } else throw Error('Unknown request');
        // persist before applying: a failed write keeps the last working settings
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(next) + '\n', { mode: 0o600 }); fs.renameSync(tmp, this.file);
        this.settings = next; this.error = null; this.runtime.applySettings(next);
        return this.status();
    }
    // BMW navigation's HUD maneuver from the app (guidance_feed.js), dropped 3 s after its last update
    setGuidance(m) {
        const s = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));
        const active = m && typeof m === 'object' && typeof m.kind === 'string';
        // An empty maneuver list is normal while Android Auto recalculates: keep the last
        // maneuver and let it age out (GUIDANCE_MAX_AGE_MS) instead of dropping it at once.
        if (!active) { if (this.guidance && this.guidanceInactiveSince === null) this.guidanceInactiveSince = Date.now(); return; }
        if (this.captureAttempted && this.guidanceInactiveSince !== null && Date.now() - this.guidanceInactiveSince >= 10000) this.captureAttempted = false;
        if (!this.captureAttempted) this.startDestinationCapture();
        this.guidanceInactiveSince = null;
        this.guidance = {
            m: {
                kind: m.kind.slice(0, 30), direction: s(m.direction, 20), exit: Number.isFinite(m.exit) ? m.exit : null,
                angle: Number.isFinite(m.angle) ? m.angle : null, side: s(m.side, 10), branch: s(m.branch, 30), checkered: m.checkered === true,
                distance: typeof m.distance === 'string' ? m.distance.slice(0, 12) : '', unit: s(m.unit, 10) || '',
                text: typeof m.text === 'string' ? m.text.slice(0, 80) : '',
                toDestination: Number.isFinite(m.toDestination) && m.toDestination >= 0 ? m.toDestination : null,
                distance_scope: ['next_stop', 'final_destination'].indexOf(m.distance_scope) >= 0 ? m.distance_scope : 'unknown',
                remaining_time_s: Number.isFinite(m.remaining_time_s) && m.remaining_time_s >= 0 ? m.remaining_time_s : null
            }, at: Date.now()
        };
    }
    // An address is read from the bounded AAPD capture, then Vela resolves it near the car.
    setDestination(msg) {
        if (!msg || (!msg.coord && !msg.address)) { this.destinationGeneration++; this.pendingDestinationAddress = null; this.lastDestinationAddress = null; this.full.setDestination(null); this.destError = null; return; }
        if (msg.coord) { this.destinationGeneration++; this.pendingDestinationAddress = null; this.lastDestinationAddress = null; this.full.setDestination(msg.coord, msg.address); this.destError = null; return; }
        if (typeof msg.address !== 'string' || !msg.address.trim() || msg.address.length > 2048) { this.destError = 'invalid destination text'; return; }
        const address = msg.address.trim();
        if (address === this.pendingDestinationAddress) return;
        if (address === this.lastDestinationAddress && this.full.active()) return;
        this.destinationGeneration++; this.lastDestinationAddress = null;
        this.full.setDestination(null);
        this.pendingDestinationAddress = address; this.resolvePendingDestination();
    }
    resolvePendingDestination() {
        const address = this.pendingDestinationAddress;
        if (!address || this.destinationBusy || address === this.lastDestinationAddress) return;
        const token = this.mapFeed.mapboxToken(), f = this.mapFeed.current();
        if (!token) { this.destError = 'waiting for Mapbox token'; return; }
        if (!f) { this.destError = 'waiting for car position'; return; }
        const generation = this.destinationGeneration;
        this.destinationBusy = true; this.destError = 'resolving captured destination';
        Promise.resolve().then(() => this.vela.compute({ longitude: f.lon, latitude: f.lat }, [{ address }], token)).then(result => {
            if (generation !== this.destinationGeneration || this.pendingDestinationAddress !== address) return;
            const raw = result && typeof result.destination_key === 'string' ? result.destination_key.split('|')[0].split(';').pop() : '';
            const coord = raw.split(',').map(Number);
            if (coord.length !== 2 || !coord.every(Number.isFinite) || Math.abs(coord[0]) > 180 || Math.abs(coord[1]) > 85) throw Error('Vela returned no valid destination coordinate');
            const candidate = result && Array.isArray(result.candidates) ? result.candidates.slice().sort((a, b) => a.duration_s - b.duration_s || a.alternative_index - b.alternative_index)[0] : null;
            if (!candidate) throw Error('Vela returned no route candidates');
            this.full.setDestination(coord, address);
            if (typeof this.full.setRouteCandidate === 'function') this.full.setRouteCandidate(candidate, [f.lon, f.lat], 'captured-destination');
            this.destError = null; this.lastDestinationAddress = address;
            if (this.pendingDestinationAddress === address) this.pendingDestinationAddress = null;
        }).catch(e => {
            if (generation !== this.destinationGeneration) return;
            this.destError = String(e && e.message || 'Destination routing failed');
            if (this.pendingDestinationAddress === address) this.pendingDestinationAddress = null;
        }).then(() => { this.destinationBusy = false; this.resolvePendingDestination(); });
    }
    fetchVelaRoute(token, from, to, reason) {
        return this.vela.compute({ longitude: from[0], latitude: from[1] }, [{ coordinates: to }], token).then(result => {
            const candidates = result && Array.isArray(result.candidates) ? result.candidates : [];
            if (!candidates.length) throw Error('Vela returned no route candidates');
            const fix = this.mapFeed.current();
            const moving = fix && Number.isFinite(fix.speed) && fix.speed >= 1.5;
            const phone = moving && reason !== 'first' ? this.currentGuidance() : null, side = phoneSide(phone), distance = phoneMetres(phone);
            // Vela has no heading and answers after a delay: measure candidates from where the
            // car is now, and rule out a start that runs against the car's travel direction.
            const here = fix ? { lon: fix.lon, lat: fix.lat } : null, travelled = here ? metresBetween({ lon: from[0], lat: from[1] }, here) : 0;
            const heading = moving && reason !== 'first' ? this.mapFeed.heading : null;
            const startBearing = c => { const p = c.coordinates, a = { lon: p[0][0], lat: p[0][1] }; for (let i = 1; i < p.length; i++) { const b = { lon: p[i][0], lat: p[i][1] }; if (metresBetween(a, b) >= 25) return bearing(a, b); } return null; };
            const score = c => {
                const step = (c.steps || []).find(x => Number.isFinite(x.along) && x.along > travelled + 10 && x.maneuver && !/^(depart|destination|arrive)$/.test(x.maneuver.type));
                const route = step ? routeSide({ type: step.maneuver.type, modifier: step.maneuver.side }) : null;
                let n = 0;
                const b = Number.isFinite(heading) && Array.isArray(c.coordinates) && c.coordinates.length >= 2 ? startBearing(c) : null;
                if (b !== null && Math.abs(((b - heading + 540) % 360) - 180) > 100) n += 10000000;
                if (side && route && side !== route) n += 1000000;
                if (phone && phone.kind === 'roundabout' && step && step.maneuver) {
                    if (step.maneuver.type !== 'roundabout' && step.maneuver.type !== 'rotary') n += 1000000;
                    const exit = step.maneuver.roundabout_exit;
                    if (Number.isInteger(phone.exit) && phone.exit > 0 && Number.isInteger(exit) && exit > 0 && phone.exit !== exit) n += 1000000;
                }
                if (distance !== null && step) n += Math.abs(distance - (step.along - travelled));
                if (!route && side) n += 50000;
                return n;
            };
            candidates.sort((a, b) => score(a) - score(b) || a.duration_s - b.duration_s || a.alternative_index - b.alternative_index);
            // A correction that still contradicts the phone (or the travel direction) would be drawn
            // and rejected again: keep the clipped line and local fallback instead.
            if (reason === 'phone-mismatch' && (phone || Number.isFinite(heading)) && score(candidates[0]) >= 1000000) throw Error('No Vela route agrees with the phone');
            return candidates[0];
        });
    }
    startDestinationCapture() {
        if (!this.destinationCapture.start()) return;
        this.captureAttempted = true; this.lastCaptureStartedAt = Date.now();
    }
    currentGuidance() { return this.guidance && Date.now() - this.guidance.at <= GUIDANCE_MAX_AGE_MS ? this.guidance.m : null; }
    send(s, data) { if (s.destroyed) return; if (s.bufferSize > 16384) { s.destroy(); return; } s.write(JSON.stringify(data) + '\n'); }
    // one JSON request per line; position and guidance lines are data feeds (no reply, no rate limit)
    accept(s) {
        if (this.clients.size >= 8) { s.destroy(); return; }
        this.clients.add(s);
        let buf = '', last = 0;
        s.setEncoding('utf8');
        this.send(s, this.status());
        s.on('data', chunk => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                if (i > 4096) { s.destroy(); return; }
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                try {
                    const msg = JSON.parse(line);
                    if (msg && msg.cmd === 'position') { this.mapFeed.position(msg); this.resolvePendingDestination(); continue; }
                    if (msg && msg.cmd === 'guidance') { this.setGuidance(msg.maneuver); continue; }
                    if (msg && msg.cmd === 'destination') { this.setDestination(msg); continue; }
                    if (msg && msg.cmd === 'reroute') { const cf = this.mapFeed.current(); if (cf) this.full.reroute(cf, 'manual'); continue; }
                    if (msg.cmd !== 'status' && Date.now() - last < 100) throw Error('Please wait');
                    if (msg.cmd !== 'status') last = Date.now();
                    this.send(s, this.command(msg));
                } catch (e) { this.send(s, { type: 'error', message: 'Setting could not be saved or request was invalid' }); }
            }
            if (buf.length > 4096) s.destroy();
        });
        s.on('error', () => {});
        s.on('close', () => this.clients.delete(s));
    }
    async start() {
        const dir = path.dirname(this.socket);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o750 });
        if (!fs.existsSync(path.dirname(this.file))) fs.mkdirSync(path.dirname(this.file), { mode: 0o700 });
        try { const st = fs.lstatSync(this.socket); if (!st.isSocket()) throw Error('Control path is not a socket'); fs.unlinkSync(this.socket); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        this.server = net.createServer(s => this.accept(s));
        await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.socket, resolve); });
        fs.chmodSync(this.socket, 0o660);
        this.runtime.start();
        this.timer = setInterval(() => {
            if (this.currentGuidance() && Date.now() - this.lastCaptureStartedAt >= 60000) this.startDestinationCapture();
            for (const s of this.clients) this.send(s, this.status());
        }, 1000);
    }
    async stop() {
        clearInterval(this.timer); await this.destinationCapture.close(); this.runtime.stop();
        for (const s of this.clients) s.destroy();
        if (this.server && this.server.listening) await new Promise(r => this.server.close(r));
        try { fs.unlinkSync(this.socket); } catch (e) { /* gone */ }
    }
}
module.exports = { Service };

if (require.main === module) {
    // outbound HTTPS (Mapbox tiles, camera data) from the hmi_5000 uid this tool's "uids" names
    require('./net_route').install();
    const s = new Service();
    s.start().catch(e => { console.error('HUD service startup failed: ' + e.message); process.exitCode = 1; });
    const stop = () => s.stop().then(() => process.exit(0));
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    if (process.send) setInterval(() => process.send({ heartbeat: true }), 1000).unref();
}
