// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Offline check of the Only during a route checkbox (src/route_gate.js):
 * CarPlay's and Android Auto's projectedGuidanceActive through fake typed
 * proxies, the render a FakeRender (tools/fakes.js). Unticked, nothing is
 * read or sent; ticked, the map is held back (the render's cluster and hud
 * off, never saved) while no route runs and shown as Show on says while one
 * does, and END_HOLD after it ends; a render started again while held back
 * is held back again; a head unit with neither proxy holds nothing; the
 * page shows Show on as chosen and "Waiting for a route".
 *
 *   node tools/test_route_gate.js
 */
const assert = require('assert');
const fs = require('fs');
const { RouteGate, guiding, switches } = require('../src/route_gate.js');
const { WazeClusterControl } = require('../src/waze_cluster_control.js');
const { FakeRender, FakePatch } = require('./fakes.js');

const RSOCK = `/tmp/woc-rg-r-${process.pid}.sock`;
const PSOCK = `/tmp/woc-rg-p-${process.pid}.sock`;
const PENDING = `/tmp/woc-rg-pending-${process.pid}.json`;
const FILE = `/tmp/woc-rg-${process.pid}.json`;
const END_HOLD = 150;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function until(what, check) {
    const deadline = Date.now() + 2000;
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (check()) {
                resolve();
            } else if (Date.now() > deadline) {
                reject(new Error(`timed out waiting for ${what}`));
            } else {
                setTimeout(poll, 10);
            }
        };
        poll();
    });
}

/* A typed proxy's field: getValue() and subscribe(cb), set(v) as the head unit would send it. */
class FakeField {
    constructor(v) {
        this.v = v;
        this.subs = [];
        this.reads = 0;
    }
    getValue() {
        this.reads++;
        return Promise.resolve(this.v);
    }
    subscribe(cb) {
        this.subs.push(cb);
        return Promise.resolve(this.subs.length);
    }
    set(v) {
        this.v = v;
        this.subs.forEach((cb) => cb(v));
    }
}

/* someipBuilders with CarPlay's and Android Auto's managers; missing: the interfaces it lacks. */
function builders(missing) {
    const fields = { carplay: new FakeField(false), aa: new FakeField(false) };
    const built = [];
    const b = {
        fields,
        built,
        buildTypedProxy(iface) {
            built.push(iface);
            const key = /carplay/.test(iface) ? 'carplay' : 'aa';
            if ((missing || []).includes(key)) {
                return Promise.reject(new Error('unknown interface'));
            }
            return Promise.resolve({ init: () => Promise.resolve(), projectedGuidanceActive: fields[key] });
        }
    };
    return b;
}

function gate(b, extra) {
    return new RouteGate(Object.assign({ someipBuilders: b, file: FILE, renderPath: RSOCK, pollMs: 30, endHoldMs: END_HOLD,
        checkMs: 60, setupRetryMs: 50 }, extra || {}));
}

function tick(on) {
    fs.writeFileSync(FILE, JSON.stringify({ routeOnly: on }) + '\n');
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

test('the values: a field or the event\'s output; the render\'s switches, a display turned on first', async () => {
    assert.deepStrictEqual([guiding(true), guiding(false), guiding({ projectedGuidanceActive: true }), guiding(1), guiding(undefined)],
        [true, false, true, true, null]);
    assert.deepStrictEqual(switches({ cluster: 0, hud: 1 }), [{ cmd: 'hud', on: '1' }, { cmd: 'cluster', on: '0' }]);
    assert.deepStrictEqual(switches({ cluster: 1, hud: 0 }), [{ cmd: 'cluster', on: '1' }, { cmd: 'hud', on: '0' }]);
});

test('unticked (the default, no file): nothing read, nothing sent, nothing held', async (render) => {
    const b = builders();
    const g = gate(b);
    g.start();
    await sleep(120);
    assert.strictEqual(g.routeOnly(), false);
    assert.strictEqual(g.holds(), false);
    assert.deepStrictEqual(b.built, [], 'no proxy set up');
    assert.deepStrictEqual(render.received, [], 'nothing to the render');
    assert.strictEqual(render.cluster, 1);
    g.stop();
});

test('ticked, no route: the map held back; a route starts: shown as Show on says; it ends: shown END_HOLD more, then held back', async (render) => {
    const b = builders();
    const g = gate(b);
    g.setRouteOnly(true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), { routeOnly: true }, 'the tick saved');
    g.start();
    await until('held back', () => render.cluster === 0 && render.hud === 0);
    assert.deepStrictEqual(g.wanted, { cluster: 1, hud: 0 }, 'Show on as the render showed it');
    assert.strictEqual(g.holds(), true);
    b.fields.carplay.set(true);
    await until('shown for the route', () => render.cluster === 1);
    assert.strictEqual(render.hud, 0, 'the HUD stays off, as Show on says');
    assert.strictEqual(g.route(), true);
    b.fields.carplay.set(false);
    await sleep(END_HOLD / 2);
    assert.strictEqual(render.cluster, 1, 'still shown just after the route ended');
    await until('held back after the end hold', () => render.cluster === 0);
    g.stop();
});

test('Android Auto guiding alone: shown; read by polling when no event comes', async (render) => {
    tick(true);
    const b = builders();
    const g = gate(b);
    g.start();
    await until('held back', () => render.cluster === 0);
    b.fields.aa.v = true;      /* no event: the next read takes it */
    await until('shown for the route', () => render.cluster === 1);
    assert(b.fields.aa.reads > 1, 'read again');
    g.stop();
});

test('unticked while held back: shown again, and no more reads', async (render) => {
    tick(true);
    const b = builders();
    const g = gate(b);
    g.start();
    await until('held back', () => render.cluster === 0);
    g.setRouteOnly(false);
    await until('shown again', () => render.cluster === 1);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')), { routeOnly: false });
    const reads = b.fields.carplay.reads;
    await sleep(120);
    assert.strictEqual(b.fields.carplay.reads, reads, 'not read while unticked');
    g.stop();
});

test('a render started again with the saved settings while held back: held back again', async (render) => {
    tick(true);
    const g = gate(builders());
    g.start();
    await until('held back', () => render.cluster === 0);
    render.cluster = 1;         /* as a render's next start reads patchd's saved Show on */
    render.received = [];
    await until('held back again', () => render.cluster === 0);
    g.stop();
});

test('a head unit with neither manager: nothing held, the checkbox greyed (unreadable)', async (render) => {
    tick(true);
    const g = gate(builders(['carplay', 'aa']));
    g.start();
    await until('both set up and missing', () => g.unreadable());
    await sleep(80);
    assert.strictEqual(g.holds(), false);
    assert.strictEqual(render.cluster, 1, 'the map left as it is');
    g.stop();
});

test('one manager missing: the other decides', async (render) => {
    tick(true);
    const b = builders(['aa']);
    const g = gate(b);
    g.start();
    await until('held back', () => render.cluster === 0);
    assert.strictEqual(g.unreadable(), false);
    b.fields.carplay.set(true);
    await until('shown for the route', () => render.cluster === 1);
    g.stop();
});

test('with the page open: through its connection; Show on as chosen, "Waiting for a route", a choice saved and held back', async (render, patch) => {
    tick(true);
    const b = builders();
    const g = gate(b);
    const c = new WazeClusterControl({ renderPath: RSOCK, patchPath: PSOCK, pendingPath: PENDING, retryMs: 100 });
    c.setGate(g);
    c.setWriteTarget(() => ({}));
    c.open();
    await until('connected', () => c.connectedRender() && c.connectedPatch());
    patch.announce('patched', 'high', null);
    g.start();
    await until('held back', () => render.cluster === 0);
    await until('the page shows it', () => c.mapText() === 'Cluster map: Waiting for a route');
    assert.strictEqual(c.shownOn(), 'cluster', 'Show on as chosen, not the render\'s off');
    /* a choice while held back: patchd saves it, the render stays off */
    c.showOn('both');
    await until('saved', () => patch.received.some((m) => m.cmd === 'hud' && m.on === 1));
    await sleep(60);
    assert.strictEqual(render.hud, 0, 'the HUD held back too');
    assert.deepStrictEqual(g.wanted, { cluster: 1, hud: 1 });
    b.fields.carplay.set(true);
    await until('both shown for the route', () => render.cluster === 1 && render.hud === 1);
    await until('the page\'s map line', () => c.mapText() !== 'Cluster map: Waiting for a route');
    c.close();
    g.stop();
});

async function main() {
    let failed = 0;
    for (const t of tests) {
        const needsServers = t.fn.length > 0;
        const render = new FakeRender(RSOCK);
        const patch = new FakePatch(PSOCK);
        if (needsServers) {
            await render.listen();
            await patch.listen();
        }
        try {
            await t.fn(render, patch);
            console.log(`ok   ${t.name}`);
        } catch (err) {
            failed++;
            console.log(`FAIL ${t.name}\n     ${err && err.stack}`);
        } finally {
            if (needsServers) {
                await render.close();
                await patch.close();
            }
            [RSOCK, PSOCK, PENDING, FILE, `${FILE}.tmp`].forEach((p) => {
                try {
                    fs.unlinkSync(p);
                } catch (e) {
                    /* gone */
                }
            });
        }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exitCode = failed ? 1 : 0;
}

main();
