'use strict';
// Turn guidance for the map HUD: the maneuver list BMW navigation keeps for its
// own HUD view (GuidanceEventList 'HUD.RB.Main' - Android Auto's turns, as aapd
// pushes them in). Read-only: the HUD view's config is read once and queried
// with queryContent every 500 ms (its own minimumUpdateIntervalMs); nothing is
// registered or set. The first maneuver goes to the HUD service
// ({cmd:'guidance'}), which draws it beside the map.
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const net = require('net'), EventEmitter = require('events');

const EVENT_LIST = 'de.bmw.infotainment.navigation.guiding.GuidanceEventList', INSTANCE = 'Main_Instance', VIEW = 'HUD.RB.Main';
const SOCKET = '/dev/shm/mindflow-hud/control.sock';
const QUERY_MS = 500, RESEND_MS = 2000;
const KINDS = ['intersection', 'roundabout', 'branch', 'destinationManeuver', 'laneChange', 'tollgate', 'border', 'vehicleTransportation', 'passiveManeuver'];
// what the HUD's own config asks for, if its config cannot be read
const FALLBACK_CONFIG = { viewport: { startPoint: { anchorPoint: { standardReferencePoint: 'CCP' }, offsets: [] }, maxElementCount: 1, endPoints: [],
    includedTypes: ['INCLUDE_DESTINATIONS', 'INCLUDE_ACTIVE_MANEUVERS'] }, options: ['ENABLE_PRIORITIZED_VIEW'], minimumUpdateIntervalMs: 500, segmentItemRasterLength: 0 };

function texts(v, out) {
    out = out || [];
    if (!v || out.length > 6) return out;
    if (Array.isArray(v)) { v.forEach(x => texts(x, out)); return out; }
    if (typeof v === 'object') { if (typeof v.text === 'string' && v.text.trim()) out.push(v.text.trim()); Object.keys(v).forEach(k => { if (k !== 'text' && k !== 'iconHandle' && typeof v[k] === 'object') texts(v[k], out); }); }
    return out;
}
// queryContent reply -> the first maneuver, or null
function parse(reply) {
    const views = reply && reply.viewContent, list = Array.isArray(views) ? views : views ? [views] : [];
    for (const view of list) {
        for (const ev of (view && view.eventsInView) || []) {
            const kind = ev && KINDS.find(k => ev[k] && typeof ev[k] === 'object');
            if (!kind) continue;
            const e = ev[kind], fd = e.formattedDistance || {};
            return {
                kind,
                direction: e.direction !== undefined ? String(e.direction) : null,
                exit: e.exitNumber !== undefined ? Number(e.exitNumber) : null,
                angle: e.exitAngle !== undefined ? Number(e.exitAngle) : null,
                side: e.driveDirection !== undefined ? String(e.driveDirection) : e.changeSide !== undefined ? String(e.changeSide) : null,
                branch: e.branchType !== undefined ? String(e.branchType) : null,
                checkered: e.isCheckeredFlag === true,
                distance: typeof fd.distance === 'string' ? fd.distance : '', unit: fd.unit !== undefined ? String(fd.unit) : '',
                text: texts(e.description).join(' ').slice(0, 80),
                toDestination: Number.isFinite(e.distanceToDestination) ? e.distanceToDestination : null
            };
        }
    }
    return null;
}

class Link {
    constructor(path) { this.path = path || SOCKET; this.socket = null; this.timer = null; this.closed = false; this.pending = null; }
    send(obj) { try { this.pending = JSON.stringify(obj) + '\n'; } catch (e) { return; } this.flush(); }
    flush() {
        if (this.closed) return;
        if (!this.socket) { this.connect(); return; }
        if (this.pending && this.socket.writable && this.socket.bufferSize < 4096) { const l = this.pending; this.pending = null; this.socket.write(l); }
    }
    connect() {
        if (this.socket || this.timer || this.closed) return;
        const s = this.socket = net.connect(this.path);
        s.on('connect', () => this.flush()); s.on('data', () => {}); s.on('drain', () => this.flush()); s.on('error', () => {});
        s.on('close', () => { this.socket = null; if (!this.closed) this.timer = setTimeout(() => { this.timer = null; this.connect(); }, 2000); });
    }
    close() { this.closed = true; clearTimeout(this.timer); if (this.socket) this.socket.destroy(); }
}

class GuidanceFeed extends EventEmitter {
    constructor(options) {
        const o = options || {};
        super();
        this.builders = o.builders || someipBuilders; this.link = o.link || new Link(o.socket);
        this.status = 'not started'; this.proxy = null; this.config = null; this.maneuver = null;
        this.sentText = null; this.sentAt = 0; this.timer = null; this.busy = false; this.stopped = false; this.errors = 0;
    }
    start() {
        this.status = 'connecting';
        Promise.resolve()
            .then(() => this.builders.buildTypedProxy(EVENT_LIST, INSTANCE))
            .then(p => { this.proxy = p; return p.init(); })
            .then(() => { this.status = 'waiting for navigation'; this.emit('change'); return this.proxy.waitUntilAvailable(); })
            .then(() => { this.status = 'available'; this.emit('change'); this.timer = setInterval(() => this.tick(), QUERY_MS); this.tick(); })
            .catch(e => { this.status = 'unavailable: ' + (e && e.message || e); this.emit('change'); });
        return this;
    }
    call(name, params) {
        // raw.callMethod is what this SDK accepts on the car (probe v3); the typed method as a fallback
        const raw = this.proxy && this.proxy._someIpProxy;
        if (raw && typeof raw.callMethod === 'function') return Promise.resolve(raw.callMethod(name, params, 3000));
        if (this.proxy && typeof this.proxy[name] === 'function') return Promise.resolve(this.proxy[name](params));
        return Promise.reject(Error('no method call path'));
    }
    tick() {
        if (this.busy || this.stopped) return;
        this.busy = true;
        const config = this.config
            ? Promise.resolve(this.config)
            : this.call('getViewConfig', { viewId: VIEW }).then(r => (this.config = r && r.viewConfig && r.GenericListError !== 'UNKNOWN_VIEW_ID' ? r.viewConfig : FALLBACK_CONFIG), () => FALLBACK_CONFIG);
        config
            .then(c => this.call('queryContent', { viewConfigs: [c] }))
            .then(r => { this.errors = 0; this.update(parse(r)); }, () => { if (++this.errors >= 6) { this.config = null; this.update(null); } })
            .then(() => { this.busy = false; });
    }
    update(m) {
        this.maneuver = m;
        const text = JSON.stringify(m), now = Date.now();
        if (text !== this.sentText || now - this.sentAt >= RESEND_MS) {
            this.sentText = text; this.sentAt = now;
            this.link.send({ cmd: 'guidance', maneuver: m });
            this.emit('change');
        }
    }
    stop() { this.stopped = true; clearInterval(this.timer); this.link.close(); try { if (this.proxy && this.proxy.shutdown) this.proxy.shutdown(); } catch (e) { /* none */ } }
}
module.exports = { GuidanceFeed, parse };
