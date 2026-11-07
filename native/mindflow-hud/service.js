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
 * Nothing here patches BMW software or reads another process's memory.
 */
const fs = require('fs'), net = require('net'), path = require('path');
const Settings = require('./settings'), { Runtime } = require('./runtime'), { MapFeed } = require('./map_feed');

const GUIDANCE_MAX_AGE_MS = 3000;

class Service {
    constructor(options) {
        this.o = options || {};
        this.file = this.o.file || '/var/opt/mindflow-hud/settings.json';
        this.socket = this.o.socket || '/dev/shm/mindflow-hud/control.sock';
        this.settings = Object.assign({}, Settings.defaults);
        this.clients = new Set(); this.error = null; this.timer = null; this.guidance = null; this.renderReport = null;
        try { this.settings = Settings.validate(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') this.error = 'Settings unreadable; defaults active'; }
        this.mapFeed = this.o.mapFeed || new MapFeed();
        this.runtime = this.o.runtime || new Runtime({
            feed: 'map://feed', fetch: u => this.mapFeed.fetch(u), guidance: () => this.currentGuidance(), settings: this.settings,
            report: m => { this.renderReport = { message: String(m), at: Date.now() }; }
        });
        this.runtime.applySettings(this.settings);
    }
    status() {
        const r = this.runtime;
        return {
            type: 'status', version: 1, settings: this.settings, visible: r.visible, feed: r.route ? 'active' : 'waiting',
            renderer: r.error ? 'refused' : r.cr.ready ? 'connected' : 'waiting',
            renderer_detail: r.lastRefusal ? r.lastRefusal.op + ': ' + r.lastRefusal.reason : r.lastError || (this.renderReport ? this.renderReport.message : null),
            map: this.mapFeed.status(), guidance: this.currentGuidance(), error: this.error
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
        this.guidance = m && typeof m === 'object' && typeof m.kind === 'string' ? {
            m: {
                kind: m.kind.slice(0, 30), direction: s(m.direction, 20), exit: Number.isFinite(m.exit) ? m.exit : null,
                angle: Number.isFinite(m.angle) ? m.angle : null, side: s(m.side, 10), branch: s(m.branch, 30), checkered: m.checkered === true,
                distance: typeof m.distance === 'string' ? m.distance.slice(0, 12) : '', unit: s(m.unit, 10) || '',
                text: typeof m.text === 'string' ? m.text.slice(0, 80) : ''
            }, at: Date.now()
        } : null;
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
                    if (msg && msg.cmd === 'position') { this.mapFeed.position(msg); continue; }
                    if (msg && msg.cmd === 'guidance') { this.setGuidance(msg.maneuver); continue; }
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
        this.timer = setInterval(() => { for (const s of this.clients) this.send(s, this.status()); }, 1000);
    }
    async stop() {
        clearInterval(this.timer); this.runtime.stop();
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
