// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
'use strict';
/**
 * drive_mode against the fake render: which driving modes are Sport modes;
 * the reader (the mode through the typed FES proxy, none for good without
 * the proxy or the field, a read that fails rejected, a change the head
 * unit notifies passed on); the sync: a Sport mode is told to the render
 * while Hide HUD map in Sport mode is in use (through a short connection
 * while the page is closed, through the page's own while it is open), again
 * while it lasts, and its end once; a value that is not a mode changes
 * nothing; nothing is told while the setting is not in use, and it is
 * looked at again when the settings may have changed; no driving mode on
 * the head unit: nothing told, and the sync says it is not available.
 *
 *   node tools/test_drive_mode.js
 */
const assert = require('assert');
const fs = require('fs');
const { sportOf, driveModeReader, DriveModeSync, IFACE, INSTANCE, FIELD, MEMBER } = require('../src/drive_mode.js');
const { WazeClusterControl } = require('../src/waze_cluster_control.js');
const { FakeRender, FakePatch } = require('./fakes.js');

const RSOCK = `/tmp/woc-dr-${process.pid}.sock`;
const PSOCK = `/tmp/woc-dp-${process.pid}.sock`;
const POLL = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function until(what, check, ms) {
    const deadline = Date.now() + (ms || 2000);
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (check()) resolve();
            else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${what}`));
            else setTimeout(poll, 10);
        };
        poll();
    });
}
/* A reader whose mode is state.mode (null: no driving mode on the head
 * unit); notify(m) is the head unit's notification. */
function fakeReader(state) {
    const r = { reads: 0, changed: null };
    r.read = () => { r.reads++; return state.fails ? Promise.reject(new Error('timeout')) : Promise.resolve(state.mode); };
    r.onChange = (fn) => { r.changed = fn; };
    r.notify = (m) => r.changed && r.changed(m);
    return r;
}

/* A fake typed proxy factory: the field's value from value(), or a proxy
 * shaped by opts (no field, a build that fails, a read that fails, a field
 * without notifications). notify(v) is the head unit's notification. */
function builders(value, opts) {
    const o = opts || {};
    const b = { built: [], reads: 0, subscribers: [] };
    b.notify = (v) => b.subscribers.forEach((fn) => fn(v));
    b.buildTypedProxy = (iface, instance) => {
        b.built.push(`${iface} ${instance}`);
        if (o.buildFails) return Promise.reject(new Error('no interface configuration'));
        const proxy = { init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve() };
        if (!o.noField) {
            proxy[FIELD] = { getValue: () => { b.reads++; return o.readFails ? Promise.reject(new Error('timeout')) : Promise.resolve(value()); } };
            if (!o.noSubscribe) proxy[FIELD].subscribe = (fn) => { b.subscribers.push(fn); return Promise.resolve(); };
        }
        return Promise.resolve(proxy);
    };
    return b;
}
const mode = (m) => ({ [MEMBER]: m });
const quiet = () => {
    const l = { lines: [] };
    l.info = (m) => l.lines.push(`info: ${m}`);
    l.warn = (m) => l.lines.push(`warn: ${m}`);
    return l;
};

let passed = 0;
async function check(name, fn) {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
}

async function main() {
    await check('Sport, Sport+, Sport Individual and XtraBoost are Sport modes, by name or number; Comfort, Eco Pro, Adaptive and a ' +
        'plug-in hybrid\'s Hybrid and Electric are not', async () => {
        ['SPORT', 'SPORT_PLUS', 'SPORT_INDIVIDUAL', 'sport', 'XTRABOOST', 1, 2, 3, 15, 16, 23, 28, '2'].forEach((raw) => {
            assert.strictEqual(sportOf(raw), true, JSON.stringify(raw));
        });
        ['COMFORT', 'COMFORT_PLUS', 'ECO_PRO', 'ECO_PRO_INDIVIDUAL', 'ADAPTIVE', 'HYBRID', 'ELECTRIC', 'BATTERY_CONTROL', 'TRAFFIC',
            4, 5, 6, 7, 8, 9, 10, 17, 18, 19, 20, 21, 22, '7'].forEach((raw) => {
            assert.strictEqual(sportOf(raw), false, JSON.stringify(raw));
        });
    });
    await check('a value that is not a driving mode is neither', async () => {
        [undefined, null, '', 0, 255, 11, 'INIT', 'INVALID', true, {}, [], NaN].forEach((raw) => {
            assert.strictEqual(sportOf(raw), null, JSON.stringify(raw));
        });
    });
    await check('a mode the proxy gives as an object, by its name or its value', async () => {
        assert.strictEqual(sportOf({ name: 'SPORT', value: 1 }), true);
        assert.strictEqual(sportOf({ name: 'COMFORT', value: 4 }), false);
        assert.strictEqual(sportOf({ value: 3 }), true);
        assert.strictEqual(sportOf({ name: 'INIT' }), null);
    });

    /* ---- the reader ---- */
    await check('the reader: the driving mode, read-only through the typed FES proxy, built once', async () => {
        let v = mode('SPORT');
        const b = builders(() => v);
        const reader = driveModeReader(b, quiet());
        assert.strictEqual(await reader.read(), 'SPORT');
        v = mode(4);
        assert.strictEqual(await reader.read(), 4);
        assert.deepStrictEqual(b.built, [`${IFACE} ${INSTANCE}`]);
        assert.deepStrictEqual([IFACE, INSTANCE], ['de.bmw.infotainment.drivingexcitement.FES', '1']);
    });
    await check('the reader: no proxy, or no field: none for good, warned once', async () => {
        for (const opts of [{ buildFails: true }, { noField: true }]) {
            const log = quiet();
            const b = builders(() => mode('SPORT'), opts);
            const reader = driveModeReader(b, log);
            assert.strictEqual(await reader.read(), null);
            assert.strictEqual(await reader.read(), null);
            assert.strictEqual(b.built.length, 1, 'not built again');
            assert.strictEqual(log.lines.filter((l) => /^warn: driving mode: .*; the HUD map stays shown in every mode$/.test(l)).length, 1, log.lines.join('\n'));
        }
    });
    await check('the reader: a read that fails, or gives no mode, is rejected (nothing changes)', async () => {
        await assert.rejects(driveModeReader(builders(() => mode('SPORT'), { readFails: true }), quiet()).read());
        for (const v of [undefined, null, 'SPORT', 42, {}]) {
            await assert.rejects(driveModeReader(builders(() => v), quiet()).read(), /no driving mode read/, JSON.stringify(v));
        }
    });
    await check('the reader: a change the head unit notifies is passed on; a field without notifications is still read', async () => {
        const b = builders(() => mode('COMFORT'));
        const reader = driveModeReader(b, quiet());
        const seen = [];
        reader.onChange((m) => seen.push(m));
        assert.strictEqual(await reader.read(), 'COMFORT');
        b.notify(mode('SPORT'));
        b.notify(undefined);
        b.notify(mode(7));
        assert.deepStrictEqual(seen, ['SPORT', 7], 'a notification without a mode is left out');
        assert.strictEqual(b.subscribers.length, 1, 'subscribed once');
        await reader.read();
        assert.strictEqual(b.subscribers.length, 1, 'not again at the next read');
        const plain = driveModeReader(builders(() => mode('SPORT'), { noSubscribe: true }), quiet());
        plain.onChange(() => {});
        assert.strictEqual(await plain.read(), 'SPORT');
    });

    /* ---- the sync ---- */
    try { fs.unlinkSync(RSOCK); } catch (e) { /* none */ }
    const render = new FakeRender(RSOCK);
    await render.listen();
    const drives = () => render.received.filter((m) => m.cmd === 'drive').map((m) => m.sport).join('');
    const sync = (state, opts) => new DriveModeSync(Object.assign({ reader: fakeReader(state), renderPath: RSOCK, pollMs: POLL,
        resendMs: 60000, holdMs: 20, log: quiet() }, opts));

    await check('the setting in use, the page closed: a Sport mode is told to the render through a short connection, its end once; ' +
        'a mode that is not Sport at the start, and a value that is not a mode, tell nothing', async () => {
        render.hud = 1;
        render.hudHideSport = 1;
        const state = { mode: 'COMFORT' };
        const s = sync(state);
        s.start();
        await sleep(POLL * 4);
        assert.deepStrictEqual([drives(), render.connections], ['', 0], 'Comfort at the start: nothing told, no connection');
        state.mode = 'SPORT';
        await until('Sport told', () => render.sport === 1);
        await sleep(POLL * 4);
        assert.deepStrictEqual([drives(), render.connections], ['1', 1], 'told once, on one connection');
        state.mode = 'INIT';
        await sleep(POLL * 4);
        assert.deepStrictEqual([drives(), render.sport, s.sport], ['1', 1, true], 'not a mode: the last one stays');
        state.mode = 'COMFORT';
        await until('its end told', () => render.sport === 0);
        await sleep(POLL * 4);
        assert.strictEqual(drives(), '10', 'told once');
        s.stop();
    });
    const reset = () => {
        render.received.length = 0;
        render.connections = 0;
        render.sport = 0;
        render.hud = 1;
        render.hudHideSport = 1;
    };

    await check('a Sport mode is told again while it lasts, its end once and nothing after', async () => {
        reset();
        const state = { mode: 'SPORT' };
        const s = sync(state, { resendMs: 80 });
        s.start();
        await until('told three times', () => drives() === '111', 3000);
        state.mode = 'ECO_PRO';
        await until('its end told', () => render.sport === 0);
        const told = drives();
        assert(/^1{3,}0$/.test(told), told);
        await sleep(300);
        assert.strictEqual(drives(), told, 'nothing told while not in a Sport mode');
        s.stop();
    });

    await check('a change the head unit notifies is told at once, without waiting for the next read', async () => {
        reset();
        const state = { mode: 'COMFORT' };
        const reader = fakeReader(state);
        const s = sync(state, { reader, pollMs: 60000 });
        s.start();
        await until('the first read', () => s.sport === false);
        reader.notify('SPORT');
        await until('told', () => render.sport === 1, 500);
        assert.strictEqual(reader.reads, 1, 'no second read');
        s.stop();
    });

    await check('the setting not in use (unticked, or the map not on the HUD): nothing told, one look and no connection after it; ' +
        'looked at again when the settings may have changed', async () => {
        for (const off of [{ hudHideSport: 0 }, { hud: 0 }, { hudHideSport: null }]) {
            reset();
            Object.assign(render, off);
            const state = { mode: 'SPORT' };
            const s = sync(state, { resendMs: 40 });
            s.start();
            await until('looked at', () => render.connections === 1);
            await sleep(POLL * 6);
            assert.deepStrictEqual([drives(), render.connections, render.sport], ['', 1, 0], JSON.stringify(off));
            reset();
            await sleep(POLL * 4);
            assert.strictEqual(drives(), '', 'ticked where this does not see it: not known yet');
            s.recheck();
            await until('told after the recheck', () => render.sport === 1);
            s.stop();
        }
    });

    await check('the render not running: a Sport mode is told once it runs', async () => {
        reset();
        await render.close();
        const state = { mode: 'SPORT' };
        const s = sync(state);
        s.start();
        await sleep(POLL * 4);
        await render.listen();
        await until('told', () => render.sport === 1);
        s.stop();
    });

    await check('no driving mode on the head unit, or reads that fail: nothing told; without a mode the reads stop', async () => {
        reset();
        const none = { mode: null };
        const readerNone = fakeReader(none);
        let changes = 0;
        const s1 = sync(none, { reader: readerNone, changed: () => { changes++; } });
        assert.strictEqual(s1.available(), true, 'not known yet: available');
        s1.start();
        const failing = { mode: 'SPORT', fails: true };
        const readerFails = fakeReader(failing);
        const s2 = sync(failing, { reader: readerFails });
        s2.start();
        await sleep(POLL * 6);
        assert.deepStrictEqual([drives(), render.connections, s1.sport, s2.sport], ['', 0, null, null]);
        assert.strictEqual(readerNone.reads, 1, 'no mode for good: not read again');
        assert.deepStrictEqual([s1.available(), changes, s2.available()], [false, 1, true], 'no mode for good: not available, said once; failed reads: still available');
        assert(readerFails.reads > 2, 'a failed read is tried again');
        s1.stop();
        s2.stop();
    });

    /* ---- with the page open ---- */
    try { fs.unlinkSync(PSOCK); } catch (e) { /* none */ }
    const patch = new FakePatch(PSOCK);
    await patch.listen();
    await check('the page open: told through the page\'s own render connection; ticking the checkbox in a Sport mode hides the ' +
        'HUD map at once, unticking shows it again', async () => {
        reset();
        render.hudHideSport = 0;
        const c = new WazeClusterControl({ renderPath: RSOCK, patchPath: PSOCK, retryMs: 100 });
        const state = { mode: 'SPORT' };
        const s = sync(state, { control: c });
        c.on('change', () => s.follow());   /* as the app wires it */
        c.open();
        render.stream(true);
        await until('the page connected, the HUD map showing', () => c.connectedRender() && c.connectedPatch() && c.hudText() === 'HUD map: Showing');
        s.start();
        await sleep(POLL * 4);
        assert.deepStrictEqual([drives(), render.connections], ['', 1], 'unticked: nothing told, the page\'s connection alone');
        c.toggleHudHideSport();
        await until('ticked in a Sport mode: hidden', () => c.hudText() === 'HUD map: Hidden in Sport mode');
        assert.deepStrictEqual([drives(), render.connections], ['1', 1], 'through the page\'s connection');
        state.mode = 'COMFORT';
        await until('Comfort: showing again', () => c.hudText() === 'HUD map: Showing');
        state.mode = 'SPORT_PLUS';
        await until('Sport+: hidden again', () => c.hudText() === 'HUD map: Hidden in Sport mode');
        c.toggleHudHideSport();
        await until('unticked: showing in a Sport mode', () => c.hudText() === 'HUD map: Showing');
        assert.deepStrictEqual([drives(), render.connections], ['101', 1]);
        s.stop();
        c.close();
    });
    await patch.close();
    try { fs.unlinkSync(PSOCK); } catch (e) { /* gone */ }

    await render.close();
    try { fs.unlinkSync(RSOCK); } catch (e) { /* gone */ }
    console.log(`${passed}/${passed} passed`);
}

main().then(() => process.exit(0), (e) => {
    console.log(`FAIL ${e && e.stack}`);
    process.exit(1);
});
