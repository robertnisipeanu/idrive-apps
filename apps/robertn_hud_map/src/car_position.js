'use strict';
// The car's own GNSS fix for the map HUD: BMW's Positioning interface
// (rawPositionData, plus currentLocation for its heading), forwarded to the HUD
// service ({cmd:'position'}), which feeds the map renderer (map_feed.js).
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const net = require('net'), EventEmitter = require('events');

const POSITIONING = 'de.bmw.infotainment.navigation.positioning.Positioning', INSTANCE = 'Main_Instance';
const SOCKET = '/dev/shm/mindflow-hud/control.sock';

function plain(v, depth) {
    depth = depth || 0;
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.slice(0, 200);
    if (depth > 6) return null;
    if (typeof v.toNumber === 'function' && typeof v.high === 'number') return v.toNumber();
    if (Array.isArray(v)) return v.slice(0, 10).map(x => plain(x, depth + 1));
    if (typeof v === 'object') { const o = {}; Object.keys(v).slice(0, 30).forEach(k => { if (typeof v[k] !== 'function') o[k] = plain(v[k], depth + 1); }); return o; }
    return null;
}

class Link {
    // write-only line connection to the HUD service; only the newest position matters
    constructor(path) { this.path = path || SOCKET; this.socket = null; this.timer = null; this.closed = false; this.pending = null; }
    send(obj) { try { this.pending = JSON.stringify(obj) + '\n'; } catch (e) { return; } this.flush(); }
    flush() {
        if (this.closed) return;
        if (!this.socket) { this.connect(); return; }
        if (this.pending && this.socket.writable && this.socket.bufferSize < 4096) { const line = this.pending; this.pending = null; this.socket.write(line); }
    }
    connect() {
        if (this.socket || this.timer || this.closed) return;
        const s = this.socket = net.connect(this.path);
        s.on('connect', () => this.flush());
        s.on('data', () => {}); // the service's status lines: not needed on this connection
        s.on('drain', () => this.flush());
        s.on('error', () => {});
        s.on('close', () => { this.socket = null; if (!this.closed) this.timer = setTimeout(() => { this.timer = null; this.connect(); }, 2000); });
    }
    close() { this.closed = true; clearTimeout(this.timer); if (this.socket) this.socket.destroy(); }
}

class CarPosition extends EventEmitter {
    constructor(options) {
        super();
        const o = options || {};
        this.builders = o.builders || someipBuilders; this.link = o.link || new Link(o.socket);
        this.status = 'not started'; this.current = null; this.proxy = null; this.stopped = false; this.count = 0;
    }
    start() {
        this.status = 'connecting';
        Promise.resolve()
            .then(() => this.builders.buildTypedProxy(POSITIONING, INSTANCE))
            .then(p => { this.proxy = p; return p.init(); })
            .then(() => { this.status = 'waiting for car positioning'; this.emit('change'); return this.proxy.waitUntilAvailable(); })
            .then(() => {
                this.status = 'available'; this.emit('change');
                const p = this.proxy;
                const watch = (name, fn) => p[name] && typeof p[name].subscribe === 'function'
                    ? Promise.resolve(p[name].subscribe(fn)).then(() => typeof p[name].getValue === 'function' ? p[name].getValue() : undefined).then(v => { if (v !== undefined) fn(v); })
                    : Promise.reject(Error('no ' + name + ' on the proxy'));
                return watch('currentLocation', v => { this.current = plain(v); })
                    .catch(() => {}) // heading helper only
                    .then(() => watch('rawPositionData', v => this.raw(v)));
            })
            .catch(e => { this.status = 'unavailable: ' + (e && e.message || e); this.emit('change'); });
        return this;
    }
    raw(v) {
        if (this.stopped) return;
        this.count++;
        this.link.send({ cmd: 'position', raw: plain(v), current: this.current });
    }
    stop() { this.stopped = true; this.link.close(); try { if (this.proxy && this.proxy.shutdown) this.proxy.shutdown(); } catch (e) { /* none */ } }
}
module.exports = { CarPosition, Link, plain };
