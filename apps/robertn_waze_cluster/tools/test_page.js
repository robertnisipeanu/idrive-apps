// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Runs the app's source modules (mgu-app.json, the entry first) against
 * a fake SDK and HMI built from the shipped uiDescription.json, with its two
 * sockets pointed at tools/fakes.js.
 *
 *   node tools/build.js && node tools/test_page.js
 *
 * Covers: the page's buttons (Enable map, Disable map, Capture logs) match
 * application.xml and are the ones the app binds, with no Show or Stop; a page
 * opened while the map is up shows it; Disable map shown only while patched
 * and Enable map only while not; pressing every button sends the render
 * nothing; hiding the page closes both sockets; a page opened again reads
 * the render's current state; a pending patch shows its line with no Enable
 * or Disable, from the daemon and, before the daemon runs, from its marker;
 * the line naming the cluster setting the map needs is always on the page,
 * under the status. The Logs page: Logs opens it (a child of the main page),
 * moving there keeps the app shown and its sockets open, it holds the logs
 * socket while shown; Save logs saves once and lists the archive; the
 * address shows as text and as a QR code, a new code replacing the old one
 * when the address changes and a blank one without an address; back from
 * an overlay on the Logs page, the logs socket opens again; a tile launch
 * after leaving on the Logs page opens none.
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { FakeRender, FakePatch, FakeLogs, RENDER_PAGE, RENDER_FPS } = require('./fakes.js');
const { RENDER_PATH, PATCH_PATH, PENDING_PATH, SIZE, SAFE } = require('../src/waze_cluster_control.js');
const { LOGS_PATH } = require('../src/logs_control.js');

const STAGED = fs.readdirSync(path.join(__dirname, '..'))
    .find((name) => name.startsWith('robertn_waze_cluster@') && !name.endsWith('.tgz'));
const PKG = path.join(__dirname, '..', STAGED);
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mgu-app.json'), 'utf8'));
const UI_DIR = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID7');
const UI = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'uiDescription.json'), 'utf8'));
const XML = fs.readFileSync(path.join(UI_DIR, 'application.xml'), 'utf8');
const APP_JSON = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'application.json'), 'utf8'));

/* short: macOS limits a socket path to 104 bytes */
const RSOCK = `/tmp/woc-pr-${process.pid}.sock`;
const PSOCK = `/tmp/woc-pp-${process.pid}.sock`;
const PENDING = `/tmp/woc-ppend-${process.pid}.json`;
const LSOCK = `/tmp/woc-pl-${process.pid}.sock`;
const SOCKETS = { [RENDER_PATH]: RSOCK, [PATCH_PATH]: PSOCK, [LOGS_PATH]: LSOCK };
const realConnect = net.connect;
const exit = process.exit.bind(process);
net.connect = (p, ...rest) => realConnect.call(net, SOCKETS[p] || p, ...rest);
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...rest) => realRead.call(fs, p === PENDING_PATH ? PENDING : p, ...rest);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function until(what, check) {
    const deadline = Date.now() + 2000;
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (check()) resolve();
            else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${what}`));
            else setTimeout(poll, 10);
        };
        poll();
    });
}

/* ---- fake HMI, from the shipped uiDescription ----------------------------- */

class FakeComponent extends EventEmitter {
    constructor(id, desc) {
        super();
        this.id = Number(id);
        this.desc = desc;
        this.text = null;
        this.enabled = null;
        this.visible = (desc && desc.properties && desc.properties.Visible) ? desc.properties.Visible.value === 1 : null;
    }
    getId() { return this.id; }
    setValue(row, cell, value) { this.text = value; return Promise.resolve(); }
    setEnabled(enabled) { this.enabled = enabled; return Promise.resolve(); }
    setVisible(visible) { this.visible = visible; return Promise.resolve(); }
    updateResources() { return Promise.resolve(); }
}

const byName = {};
Object.entries(UI.containers).forEach(([cid, cont]) => {
    byName[cont.name] = new FakeComponent(cid, cont);
    Object.entries(cont.components).forEach(([id, desc]) => {
        byName[desc.name] = new FakeComponent(id, desc);
    });
});
const rhmi = new EventEmitter();
rhmi.getByName = (name) => byName[name] || null;
rhmi.mapEntryState = () => Promise.resolve();
rhmi.openEntryState = () => Promise.resolve();
rhmi.opened = [];
rhmi.openState = (name) => { rhmi.opened.push(name); return Promise.resolve(); };
rhmi.flush = () => Promise.resolve();
rhmi.handles = new Set();
rhmi.getResourceBundle = () => ({
    createResourceHandles: (files) => { files.forEach((f) => rhmi.handles.add(f)); return Promise.resolve(); },
    destroyResourceHandles: (files) => { files.forEach((f) => rhmi.handles.delete(f)); return Promise.resolve(); }
});

/* ---- fake SDK ----------------------------------------------------------------- */

const logs = [];
let inactiveReports = 0;
const logger = {};
['error', 'warn', 'info', 'verbose', 'debug'].forEach((level) => {
    logger[level] = (msg) => logs.push(`${level}: ${msg}`);
});

class OnlineApp extends EventEmitter {
    constructor() {
        super();
        this._packageJson = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
        this.appDescription = APP_JSON;
        this.rhmiApplication = rhmi;
        this.startReason = 'ENTRY_POINT';
        OnlineApp.instance = this;
        this._initialized = false;
        this._appStatusService = null;
        const description = APP_JSON.application.entryPoints[0];
        this._entryPoints = [{
            entryPoint: { setText: () => Promise.resolve(), setIcon: () => Promise.resolve() },
            getDescription: () => description,
            init: () => Promise.resolve(),
            setAvailability: () => Promise.resolve()
        }];
    }
    start() { setImmediate(() => this.emit('initialized')); return Promise.resolve(); }
    getAppId() { return 'robertn_waze_cluster'; }
    getEntryPoints() { return this._entryPoints; }
    getLastExecutedEntryPointUuid() { return null; }
    initialized() { this._initialized = true; this._appStatusService = {}; return Promise.resolve(); }
    registerActive() { return Promise.resolve(); }
    registerInactive() { inactiveReports++; return Promise.resolve(); }
    registerHmiVisible() { return Promise.resolve(); }
    unregisterHmiVisible() { return Promise.resolve(); }
    destroyBundles() { return Promise.resolve(); }
}

const FAKE_MODULES = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => logger }
};

/* Loads the app's entry module (mgu-app.json's first) with the SDK's names
 * answered by the fakes, as the unit's link of the source package would. */
function runSource() {
    const Module = require('module');
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
        return FAKE_MODULES[request] || load.call(this, request, parent, isMain);
    };
    require(path.join(__dirname, '..', MANIFEST.modules[0]));
}

/* ---- scenario ----------------------------------------------------------------- */

async function main() {
    const components = UI.containers['1'].components;
    const buttons = Object.entries(components).filter(([, d]) => d.type === 'button');
    const xmlButtons = [...XML.split('<container id="2"')[0].matchAll(/<component id="(\d+)" type="button"/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(buttons.map(([id]) => id).sort(), xmlButtons, 'application.xml and uiDescription agree');
        assert.deepStrictEqual(buttons.map(([, d]) => d.name).sort(), ['wocCapture', 'wocDisable', 'wocDisplay', 'wocEnable', 'wocHudSize', 'wocLogs', 'wocRestart']);
    assert(!buttons.some(([, d]) => /^(Show|Stop)$/.test(d.rows[0].Text.value)), 'no Show or Stop button');
    /* The restart button ships hidden; it shows only while a patch is deferred. */
    assert.strictEqual(components['34'].properties.Visible.value, 0, 'wocRestart ships hidden');
    console.log('ok   page buttons: Enable map, Disable map, Restart (hidden), Capture logs, Logs; no Show or Stop');
    const logsPage = UI.containers['2'];
    assert.strictEqual(logsPage.name, 'ST_OnlineApps_WazeClusterLogs');
    assert.deepStrictEqual(logsPage.properties.ParentState, { value: 1, type: 'UInt' }, 'the Logs page is a child of the main page');
    assert(/<container id="2" type="state" widget="LT_State_Wide">\s*<property id="9" value="1"\/>/.test(XML));
    const xmlIds = (cid) => [...XML.split('<container id="').find((c) => c.startsWith(`${cid}"`))
        .matchAll(/<component id="(\d+)" type="(\w+)"(?: widget="(\w+)")?/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepStrictEqual(xmlIds('2'), Object.entries(logsPage.components).map(([id, d]) => `${id} ${d.type}`),
        'application.xml and uiDescription agree on the Logs page');
    assert.deepStrictEqual(Object.values(logsPage.components).map((d) => d.name), ['wocLogsTitle', 'wocLogsSave',
        'wocLogsStatus', 'wocLogsQr', 'wocLogsUrl', 'wocLogsRow1', 'wocLogsRow2', 'wocLogsRow3', 'wocLogsRow4', 'wocLogsRow5']);
    assert(/<component id="83" type="label" widget="LT_Label_1Graphic_Scalable">/.test(XML), 'the QR code is a graphic');
    assert.strictEqual(APP_JSON.application.entryPoints.length, 1);
    console.log('ok   the Logs page: Save logs, status, QR code, address, five archives; a child of the main page');
    const setup = Object.entries(components).find(([, d]) => d.name === 'wocSetup');
    assert(setup && setup[0] === '21' && setup[1].type === 'label' && setup[1].properties.Visible.value === 1 &&
        setup[1].properties.Focusable.value === 0, 'wocSetup: a visible, unfocusable label right under wocStatus');
    assert(/<component id="20" type="label"[^]*?<\/component>\s*<component id="21" type="label" widget="LT_Label_1Row">\s*<property id="2" value="1"\/>/.test(XML),
        'application.xml: label 21, visible, right after the status');

    const render = new FakeRender(RSOCK);
    let patch = new FakePatch(PSOCK);
    await render.listen();
    await patch.listen();
    patch.res = SIZE;
    patch.safe = SAFE;
    patch.announce('patched', 'high', null);
    render.stream(true);
    await until('fake showing', () => render.state === 'showing');

    try {
        process.exit = (code) => { throw new Error(`process.exit(${code})`); };
        runSource();
        const status = byName.wocStatus;
        await until('page shows the map', () => status.text === `Showing: ${RENDER_PAGE} — ${RENDER_FPS}`);
        assert(!logs.some((l) => /^error/.test(l)), logs.filter((l) => /^error/.test(l)).join('\n'));
        const bound = logs.filter((l) => l.startsWith('info: BIND OK: ')).map((l) => l.split(' ')[3]).sort();
        assert.deepStrictEqual(bound, ['wocCapture', 'wocDisable', 'wocDisplay', 'wocEnable', 'wocHudSize', 'wocLogs', 'wocLogsSave', 'wocRestart'], 'bound buttons');
        assert.strictEqual(byName.wocRestart.visible, false, 'restart button hidden while the map shows');
        console.log('ok   a page opened while the map is up shows it');
        await until('the setup line', () => byName.wocSetup.text === 'Set Instrument cluster > Central display area to Map view');
        console.log('ok   the page says to set Instrument cluster > Central display area to Map view');

        await until('patched: Disable map only', () => byName.wocDisable.visible === true && byName.wocDisable.enabled === true &&
            byName.wocEnable.visible === false && byName.wocEnable.enabled === false);
        byName.wocDisable.emit('action');
        await until('reverted', () => patch.count('revert') === 1 && !patch.busy && patch.state === 'original');
        await until('original: Enable map only', () => byName.wocEnable.visible === true && byName.wocEnable.enabled === true &&
            byName.wocDisable.visible === false);
        ['wocEnable', 'wocCapture'].forEach((name) => byName[name].emit('action'));
        await until('apply and capture sent', () => patch.count('apply') === 1 && patch.count('capture-start') === 1 && !patch.busy);
        assert.deepStrictEqual(render.received, [], 'no command to the render');
        console.log('ok   Disable map while patched, Enable map while not; presses go to the patch daemon, none to the render');

        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: false });
        /* the page's own; the driver-profile link to patchd stays (profile_sync.js) */
        await until('sockets closed', () => render._clients.size === 0 && patch._clients.size === 1);
        console.log('ok   hiding the page closes both sockets');

        render.stream(false);
        patch.announce('patched', 'high', null);
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: true });
        await until('page reads the current state', () => status.text === 'Patched — waiting for CarPlay');
        console.log('ok   a page opened again reads the render\'s current state');

        /* The patch the install wrote, from the daemon: its line, no Enable
         * or Disable, the restart offered. */
        patch.pending = 'apply';
        patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
        await until('pending on screen', () => status.text === 'Patch pending — reboot to activate' &&
            byName.wocEnable.visible === false && byName.wocDisable.visible === false &&
            byName.wocRestart.visible === true && byName.wocRestart.enabled === true);
        console.log('ok   a pending patch from the daemon: its line, no Enable or Disable, the restart offered');

        /* Before the head-unit start that starts the daemon: from the marker. */
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: false });
        await until('closed', () => patch._clients.size === 1);
        await patch.close();
        fs.writeFileSync(PENDING, JSON.stringify({ action: 'apply' }) + '\n');
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: true });
        await until('pending from the marker', () => status.text === 'Patch pending — reboot to activate' &&
            byName.wocEnable.visible === false && byName.wocDisable.visible === false && byName.wocRestart.visible === false);
        console.log('ok   installed, the daemon not yet running: the marker\'s pending patch, no buttons');

        /* The daemon up with the pending patch: the restart press reboots once. */
        patch = new FakePatch(PSOCK);
        await patch.listen();
        patch.pending = 'apply';
        patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
        await until('restart offered', () => byName.wocRestart.visible === true && byName.wocRestart.enabled === true);
        byName.wocRestart.emit('action');
        await until('rebooted once', () => patch.reboots === 1);
        await until('restarting on screen', () => status.text === 'Restarting head unit…' && byName.wocRestart.enabled === false);
        console.log('ok   pressing the restart button reboots the unit once');

        /* ---- the Logs page ---- */
        const lserver = new FakeLogs(LSOCK);
        await lserver.listen();
        const main = byName.ST_OnlineApps_WazeCluster;
        const logsState = byName.ST_OnlineApps_WazeClusterLogs;
        await until('the Logs button', () => byName.wocLogs.visible === true);
        byName.wocLogs.emit('action');
        await until('Logs opened', () => rhmi.opened.indexOf('ST_OnlineApps_WazeClusterLogs') >= 0);
        const inactiveBefore = inactiveReports;
        main.emit('visible', { visible: false });
        await sleep(100);
        logsState.emit('visible', { visible: true });
        await until('logs socket open', () => lserver._clients.size === 1);
        await sleep(900);
        assert.strictEqual(inactiveReports, inactiveBefore, 'moving to the Logs page keeps the app shown');
        /* the page's patch connection and the HUD build's profile sync (its own patchd connection,
         * src/profile_sync.js): both stay open */
        assert.strictEqual(patch._clients.size, 2, 'and its sockets open');
        await until('logs state shown', () => byName.wocLogsStatus.text === 'No logs saved' &&
            byName.wocLogsUrl.text === lserver.url && byName.wocLogsSave.enabled === true);
        const qr1 = byName.wocLogsQr.text;
        assert(qr1 && rhmi.handles.has(qr1), 'the QR code shown through a resource handle');
        assert.deepStrictEqual(fs.readFileSync(qr1).slice(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        assert.strictEqual(fs.statSync(qr1).mode & 0o777, 0o644, 'the HMI reads it');
        console.log('ok   Logs opens the Logs page; the app stays shown; the page shows the address and its QR code');

        byName.wocLogsSave.emit('action');
        await until('saved', () => /^Saved woc-logs-/.test(byName.wocLogsStatus.text) &&
            /^woc-logs-\d{8}T\d{6}Z\.tar\.gz · 412 KB$/.test(byName.wocLogsRow1.text));
        assert.strictEqual(lserver.count('save'), 1);
        assert.strictEqual(byName.wocLogsRow2.text, '');
        console.log('ok   Save logs saves once and lists the archive');

        lserver.url = 'http://172.16.222.97:8475/fedcba9876543210fedcba9876543210/';
        lserver.announce();
        await until('a new QR code', () => byName.wocLogsUrl.text === lserver.url && byName.wocLogsQr.text !== qr1);
        await until('the old one gone', () => !fs.existsSync(qr1) && !rhmi.handles.has(qr1));
        lserver.url = null;
        lserver.announce();
        await until('no address', () => byName.wocLogsUrl.text === 'Wi-Fi hotspot off');
        const blank = byName.wocLogsQr.text;
        await until('blank code', () => rhmi.handles.has(blank) && fs.existsSync(blank));
        console.log('ok   a new address gets a new QR code, the old one removed; no address: a blank one');

        /* an overlay takes the screen (ROOT_APP gone) and gives it back; the
         * Logs page says nothing of its own */
        lserver.url = 'http://172.16.222.97:8475/0123456789abcdef0123456789abcdef/';
        lserver.announce();
        rhmi.emit('applicationStackChanged', { OVERLAY: 1 });
        await until('hidden: logs socket closed', () => lserver._clients.size === 0);
        rhmi.emit('applicationStackChanged', { ROOT_APP: 1 });
        await until('back: logs socket open', () => lserver._clients.size === 1 && byName.wocLogsUrl.text === lserver.url &&
            byName.wocLogsStatus.text !== 'Connecting…');
        console.log('ok   back from an overlay on the Logs page, the logs socket opens again');

        logsState.emit('visible', { visible: false });
        main.emit('visible', { visible: true });
        await until('logs socket closed', () => lserver._clients.size === 0);
        rhmi.emit('applicationStackChanged', { OVERLAY: 1 });
        await sleep(50);
        rhmi.emit('applicationStackChanged', { ROOT_APP: 1 });
        await sleep(200);
        assert.strictEqual(lserver._clients.size, 0, 'back on the main page: no logs socket');

        /* left from the Logs page, launched again from the tile: the main
         * page, no logs socket (which would start the page server) */
        byName.wocLogs.emit('action');
        main.emit('visible', { visible: false });
        logsState.emit('visible', { visible: true });
        await until('on the Logs page', () => lserver._clients.size === 1);
        rhmi.emit('applicationStackChanged', { OTHER_APP: 1 });
        await until('left: logs socket closed', () => lserver._clients.size === 0);
        rhmi.emit('applicationStackChanged', { ROOT_APP: 1 });
        OnlineApp.instance.emit('entryPointExecute', APP_JSON.application.entryPoints[0].uuid);
        await sleep(400);
        assert.strictEqual(lserver._clients.size, 0, 'a tile launch opens no logs socket');
        assert.strictEqual(patch._clients.size, 2, 'the main page\'s sockets are open');   /* + the HUD build's profile sync */
        console.log('ok   launched from the tile after leaving on the Logs page: the main page, no logs socket');
        assert.strictEqual(patch._clients.size, 2, 'the main page keeps its sockets');   /* + the HUD build's profile sync */
        console.log('ok   leaving the Logs page closes the logs socket');
        await lserver.close();
    } finally {
        await render.close();
        await patch.close();
        [RSOCK, PSOCK, PENDING, LSOCK].forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* gone */ } });
    }
}

/* The app's sockets keep retrying, so the run ends here. */
main().then(() => {
    console.log('all passed');
    exit(0);
}, (err) => {
    console.log(`FAIL ${err && err.stack}`);
    exit(1);
});
