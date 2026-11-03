// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * robertn_waze_cluster - the control panel for the native
 * waze-on-cluster tool, which puts the CarPlay cluster map on the instrument
 * cluster. It drives the tool entirely from the HMI, so no shell is needed.
 *
 * One LT_State_Wide page: a status line combining the patch state and the
 * render state; the cluster setting the map needs; Show map on (Cluster or
 * HUD; each press switches, saved for the next start);
 * HUD map size (Standard, 70 %, 85 %, 40 %; enabled while the
 * map goes to the HUD); Enable map and Disable
 * map, which apply and revert the carplay patch; the diagnostic capture
 * button and its status; Logs, which opens the Logs page; and a scrolling
 * list of both tools' log lines, newest first, one per LT_Label_1Row, redrawn
 * at most every LIST_RENDER_MS. Once patched, the render puts the map on the
 * cluster whenever CarPlay streams it, with no button.
 *
 * The Logs page (logs_control.js): Save logs, its status, the QR code of the
 * address a phone on the car's hotspot downloads the saved archives from,
 * that address, and the archives. The app holds the logs socket while the
 * page is visible; the QR code is a PNG in QR_DIR (RAM), replaced when the
 * address changes.
 *
 * Enable map shows for an unpatched or unknown state and Disable map for a
 * patch, both only with no change pending (waze_cluster_control.js
 * canEnable/canDisable); capture is enabled while the patch daemon is
 * reachable. The app connects both sockets while one of its pages is visible
 * and closes them when it is hidden or the app shuts down; the tools keep
 * running. Moving between its pages hides one before the other shows, so a
 * hide counts only after HIDE_SETTLE_MS. waze_cluster_control.js holds the
 * protocol.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { WazeClusterControl, MAX_LINES } = require('./waze_cluster_control.js');
const { LogsControl, ROWS: LOGS_ROWS } = require('./logs_control.js');
const { qrPng } = require('./qr.js');
const { ProfileSync } = require('./profile_sync.js');

const logger = logging.getSDKLogger();

const STATE_NAME = 'ST_OnlineApps_WazeCluster';
const STATUS_NAME = 'wocStatus';
const SETUP_NAME = 'wocSetup';
const ENABLE_NAME = 'wocEnable';
const DISABLE_NAME = 'wocDisable';
const RESTART_NAME = 'wocRestart';
const DISPLAY_NAME = 'wocDisplay';
const HUD_SIZE_NAME = 'wocHudSize';
const CAPTURE_NAME = 'wocCapture';
const CAPTURE_STATUS = 'wocCaptureStatus';
const LOGS_NAME = 'wocLogs';
const LOGS_STATE = 'ST_OnlineApps_WazeClusterLogs';
const LOGS_SAVE = 'wocLogsSave';
const LOGS_STATUS = 'wocLogsStatus';
const LOGS_QR = 'wocLogsQr';
const LOGS_URL = 'wocLogsUrl';
const LOGS_ROW_NAMES = Array.from({ length: LOGS_ROWS }, (_, i) => `wocLogsRow${i + 1}`);
const ROW_NAMES = Array.from({ length: MAX_LINES }, (_, i) => `wocRow${String(i + 1).padStart(2, '0')}`);
const LIST_RENDER_MS = 500;
const ROW_CHARS = 90;
const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const QR_DIR = path.join(fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir(),
    `robertn_waze_cluster_qr_${typeof process.getuid === 'function' ? process.getuid() : 'x'}`);
/* in Map view the stock map is the fallback while CarPlay's cluster stream
 * is not live; the menu names are the HMI's en_GB ones */
const SETUP_TEXT = 'Set Instrument cluster > Central display area to Map view';

/* A line as one row: no line breaks, at most ROW_CHARS characters. */
function oneRow(line) {
    const flat = line.replace(/\s+/g, ' ');
    return flat.length > ROW_CHARS ? `${flat.slice(0, ROW_CHARS - 1)}…` : flat;
}

/* RHMI event values arrive as booleans, or as 1/0 on some HMIs. */
function isTrue(raw) {
    return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

class WazeClusterApp extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._visible = false;
        this._pages = { main: false, logs: false };
        this._shownPage = 'main';   /* the page last shown, which shows again when the app does */
        this._hideTimer = null;
        this._qr = { url: undefined, file: null, chain: Promise.resolve() };
        this._sawForeground = false;
        this._shutdownPromise = null;
        this._listTimer = null;
        this._control = new WazeClusterControl({ log: logger });
        this._control.on('change', () => {
            this._render();
            this._scheduleLists();
        });
        this._control.on('log', () => this._scheduleLists());
        this._logs = new LogsControl({ log: logger });
        this._logs.on('change', () => this._renderLogs());
        /* the display choice per driver profile, page shown or not */
        this._profiles = new ProfileSync({ control: this._control, log: logger });
        this._profiles.start();

        this.on('initialized', () => {
            this._appInitialized()
                .catch((err) => logger.error(`robertn_waze_cluster init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) {
                this._setVisible(false);
            }
        });
    }

    _appInitialized() {
        logger.info(`robertn_waze_cluster ${this.getAppId()} v${this._packageJson.version} starting`);
        if (!this.rhmiApplication) {
            logger.info('no RhmiApplication for this start reason; initializing without a screen');
            return this.initialized();
        }
        const foregroundStart = this._startedForeground();
        return this._setupRhmi()
            .then(() => this._registerEntryPoints())
            .then(() => {
                // A foreground start declares itself ACTIVE before initialized()
                // reports the first app status, so the manager keeps it running.
                if (foregroundStart) {
                    this.registerActive();
                }
                return this.initialized();
            })
            .then(() => {
                if (foregroundStart) {
                    this._sawForeground = true;
                    this._setVisible(true);
                }
                const lastUuid = this.getLastExecutedEntryPointUuid &&
                    this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            });
    }

    _startedForeground() {
        const FOREGROUND_REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK',
            'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return FOREGROUND_REASONS.includes(reason);
    }

    /* ---- RHMI ---- */
    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._state = rhmi.getByName(STATE_NAME);
        this._logsState = rhmi.getByName(LOGS_STATE);
        if (!this._state || !this._logsState) {
            return Promise.reject(new Error(`uiDescription has no ${STATE_NAME} or ${LOGS_STATE}`));
        }
        const names = [STATUS_NAME, SETUP_NAME, DISPLAY_NAME, HUD_SIZE_NAME, ENABLE_NAME, DISABLE_NAME, RESTART_NAME,
            CAPTURE_NAME, CAPTURE_STATUS, LOGS_NAME, LOGS_SAVE, LOGS_STATUS, LOGS_QR, LOGS_URL].concat(ROW_NAMES, LOGS_ROW_NAMES);
        names.forEach((name) => { this._components[name] = rhmi.getByName(name); });
        const missing = names.filter((name) => !this._components[name]);
        if (missing.length) {
            return Promise.reject(new Error(`uiDescription lacks ${missing.join(', ')}`));
        }
        this._bind(ENABLE_NAME, () => this._control.enableMap());
        this._bind(DISABLE_NAME, () => this._control.disableMap());
        this._bind(RESTART_NAME, () => this._control.requestRestart());
        this._bind(DISPLAY_NAME, () => this._control.cycleDisplay());
        this._bind(HUD_SIZE_NAME, () => this._control.cycleHudSize());
        this._bind(CAPTURE_NAME, () => this._control.capture());
        this._bind(LOGS_NAME, () => Promise.resolve(rhmi.openState(LOGS_STATE))
            .catch((err) => logger.warn(`openState ${LOGS_STATE} failed: ${err && err.message}`)));
        this._bind(LOGS_SAVE, () => this._logs.save());
        // Presses also arrive as the application's raw 'userEvent'; both paths
        // land in _press, which keeps a press delivered twice to one.
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) {
                this._press(entry.name, entry.handler);
            }
        });
        rhmi.on('applicationStackChanged', (stack) => {
            // The app holds the foreground while the stack has a ROOT_APP slot;
            // the empty stack seen during startup is ignored.
            const keys = stack && typeof stack === 'object' ? Object.keys(stack) : [];
            if (!keys.length) {
                return;
            }
            if (Object.prototype.hasOwnProperty.call(stack, 'ROOT_APP')) {
                this._sawForeground = true;
                this._setVisible(true);
            } else if (this._sawForeground) {
                this._setVisible(false);
            }
        });
        rhmi.on('restoreHmi', () => {
            logger.info('RESTORE_HMI: re-pushing page content');
            this._written = {};
            this._qr.url = undefined;
            this._render();
            this._renderLists();
            this._renderLogs();
        });
        this._state.on('visible', (event) => this._pageVisible('main', isTrue(event && event.visible)));
        this._logsState.on('visible', (event) => this._pageVisible('logs', isTrue(event && event.visible)));
        this._removeStaleQr();
        return Promise.all([this._state.updateResources(), this._logsState.updateResources()]).then(() => {
            logger.info(`page ready: ${names.length} components found`);
            this._render();
            this._renderLists();
            this._renderLogs();
        });
    }

    _bind(name, handler) {
        const comp = this._components[name];
        let id = null;
        try {
            id = comp.getId();
        } catch (e) {
            id = null;
        }
        if (id !== null) {
            this._actionById[Number(id)] = { name, handler };
        }
        logger.info(`BIND OK: ${name} (id ${id})`);
        comp.on('action', () => this._press(name, handler));
    }

    _press(name, handler) {
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < PRESS_DEDUPE_MS) {
            return;
        }
        this._lastPress[name] = now;
        logger.info(`BUTTON ACTION ${name}`);
        try {
            handler();
        } catch (err) {
            logger.warn(`${name} failed: ${err && err.message}`);
        }
    }

    /* The app manager inserts the public tile from application.json and hands
     * it to the app at start; the SDK emits 'entryPointExecute' on a tap. */
    _registerEntryPoints() {
        const descriptions = (this.appDescription &&
            this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find(
            (ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._state))
            .then(() => Promise.resolve()
                .then(() => ours.entryPoint.setText(description.textId))
                .then(() => (description.icon ? ours.entryPoint.setIcon(description.icon) : undefined))
                .catch((err) => logger.warn(`entry point text/icon: ${err && err.message}`)))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${description.name} ENABLED`));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._sawForeground = true;
        /* the tile opens the main page, whichever page the app was left on;
         * its stack change may have come first and opened the Logs page's socket */
        this._shownPage = 'main';
        this._pages.logs = false;
        this._logs.close();
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    /* ---- visibility ---- */
    /* One page shown or hidden. The logs socket follows the Logs page; the
     * app counts as hidden once neither page has shown for HIDE_SETTLE_MS. */
    _pageVisible(page, visible) {
        if (this._shutdownPromise) {
            return;
        }
        this._pages[page] = visible;
        if (visible) {
            this._shownPage = page;
        }
        if (page === 'logs') {
            if (visible) {
                this._logs.open();
            } else {
                this._logs.close();
            }
        }
        clearTimeout(this._hideTimer);
        this._hideTimer = null;
        if (visible) {
            this._sawForeground = true;
            this._setVisible(true);
        } else if (!this._pages.main && !this._pages.logs) {
            this._hideTimer = setTimeout(() => {
                this._hideTimer = null;
                this._setVisible(false);
            }, HIDE_SETTLE_MS);
        }
    }

    _setVisible(visible) {
        if (!visible) {
            this._pages = { main: false, logs: false };
            this._logs.close();
        }
        if (this._shutdownPromise || this._visible === visible) {
            return;
        }
        this._visible = visible;
        logger.info(`page ${visible ? 'visible' : 'hidden'}`);
        this._reportVisibilityStatus(visible);
        if (visible) {
            this._control.open();
            /* back from an overlay or another app on the Logs page, which
             * says nothing of its own */
            if (this._shownPage === 'logs') {
                this._pages.logs = true;
                this._logs.open();
            }
        } else {
            this._control.close();
        }
    }

    _reportVisibilityStatus(visible) {
        if (!this._initialized || !this._appStatusService) {
            return;
        }
        const reports = visible ?
            [this.registerActive(), this.registerHmiVisible()] :
            [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((report) => Promise.resolve(report).catch((err) =>
            logger.warn(`app status report failed: ${err && err.message}`)));
    }

    /* ---- rendering ---- */
    /* Writes text into a component's row unless it already shows it. */
    _write(name, text) {
        if (this._written[name] !== text) {
            this._written[name] = text;
            Promise.resolve(this._components[name].setValue(0, 'Text', text, 'Text'))
                .catch((err) => logger.warn(`${name} render failed: ${err && err.message}`));
        }
    }

    /* Enables a button unless it already holds that state. */
    _setEnabled(name, enabled) {
        const key = `enabled:${name}`;
        if (this._written[key] !== enabled) {
            this._written[key] = enabled;
            Promise.resolve(this._components[name].setEnabled(enabled))
                .catch((err) => logger.warn(`${name} enable failed: ${err && err.message}`));
        }
    }

    /* Shows or hides a component unless it already holds that state. */
    _setVisibleComp(name, visible) {
        const key = `visible:${name}`;
        if (this._written[key] !== visible) {
            this._written[key] = visible;
            Promise.resolve(this._components[name].setVisible(visible))
                .catch((err) => logger.warn(`${name} visibility failed: ${err && err.message}`));
        }
    }

    _render() {
        if (!this._state || this._shutdownPromise) {
            return;
        }
        this._write(STATUS_NAME, this._control.statusText());
        this._write(SETUP_NAME, SETUP_TEXT);
        /* Cluster, HUD, or both: each press moves the map to the next one */
        this._write(DISPLAY_NAME, this._control.displayText());
        this._setEnabled(DISPLAY_NAME, this._control.canChangeDisplay());
        /* the HUD map's size: enabled while the map goes to the HUD */
        this._write(HUD_SIZE_NAME, this._control.hudSizeText());
        this._setEnabled(HUD_SIZE_NAME, this._control.canChangeHudSize());
        this._write(CAPTURE_NAME, this._control.captureButtonText());
        this._write(CAPTURE_STATUS, this._control.captureText());
        const patch = this._control.connectedPatch();
        /* While a reboot is underway no patch operation should start. */
        const restarting = this._control.restartRequested();
        const enable = this._control.canEnable();
        const disable = this._control.canDisable();
        this._setVisibleComp(ENABLE_NAME, enable);
        this._setEnabled(ENABLE_NAME, enable);
        this._setVisibleComp(DISABLE_NAME, disable);
        this._setEnabled(DISABLE_NAME, disable);
        this._setEnabled(CAPTURE_NAME, patch && !restarting && this._control.captureState.state !== 'closing');
        /* The restart button appears only while a patch is written and waiting
         * for a head-unit start; it is disabled once pressed so one press does
         * one reboot. On units where carplay restarts at once it never shows. */
        const needsRestart = this._control.restartNeeded();
        this._setVisibleComp(RESTART_NAME, needsRestart);
        this._setEnabled(RESTART_NAME, needsRestart && patch && !restarting);
    }

    _renderLogs() {
        if (!this._logsState || this._shutdownPromise) {
            return;
        }
        this._write(LOGS_STATUS, this._logs.statusText());
        this._write(LOGS_URL, this._logs.urlText());
        this._setEnabled(LOGS_SAVE, this._logs.canSave());
        const rows = this._logs.rows();
        LOGS_ROW_NAMES.forEach((name, i) => this._write(name, oneRow(rows[i])));
        this._showQr(this._logs.url());
    }

    /* Writes url's QR code (none: a blank square) as a new file and shows it,
     * then removes the one it replaced. */
    _showQr(url) {
        const rhmi = this.rhmiApplication;
        if (this._qr.url === url || !rhmi) {
            return this._qr.chain;
        }
        this._qr.url = url;
        this._qr.chain = this._qr.chain.then(() => {
            /* the HMI reads the picture: the folder and the file world-readable */
            try {
                fs.mkdirSync(QR_DIR);
            } catch (e) {
                if (e.code !== 'EEXIST') {
                    throw e;
                }
            }
            fs.chmodSync(QR_DIR, 0o755);
            const file = path.join(QR_DIR, `qr_${Date.now()}.png`);
            fs.writeFileSync(file, qrPng(url).png);
            fs.chmodSync(file, 0o644);
            const bundle = rhmi.getResourceBundle();
            const old = this._qr.file;
            return Promise.resolve(bundle.createResourceHandles([file]))
                .then(() => this._components[LOGS_QR].setValue(0, 'Graphic', file, 'ResourceId'))
                .then(() => rhmi.flush())
                .then(() => {
                    this._qr.file = file;
                    return old ? this._retireQr(bundle, old) : undefined;
                });
        }).catch((err) => {
            this._qr.url = undefined;
            logger.warn(`QR code failed: ${err && err.message}`);
        });
        return this._qr.chain;
    }

    _retireQr(bundle, file) {
        return Promise.resolve()
            .then(() => bundle.destroyResourceHandles([file]))
            .catch((err) => logger.warn(`QR handle ${file}: ${err && err.message}`))
            .then(() => {
                try {
                    fs.unlinkSync(file);
                } catch (e) {
                    /* gone already */
                }
            });
    }

    _removeStaleQr() {
        try {
            fs.readdirSync(QR_DIR).filter((n) => /^qr_\d+\.png$/.test(n))
                .forEach((n) => fs.unlinkSync(path.join(QR_DIR, n)));
        } catch (e) {
            /* no folder yet */
        }
    }

    _scheduleLists() {
        if (!this._listTimer) {
            this._listTimer = setTimeout(() => {
                this._listTimer = null;
                this._renderLists();
            }, LIST_RENDER_MS);
        }
    }

    _renderLists() {
        if (!this._state || this._shutdownPromise) {
            return;
        }
        /* Rows are only written, never hidden: on this HMI a row hidden at
         * run time leaves the page without its other rows (mgu-emulator). */
        const rows = this._control.rows();
        ROW_NAMES.forEach((name, i) => this._write(name, oneRow(rows[i] || '')));
    }

    /* ---- shutdown ---- */
    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        logger.info(`robertn_waze_cluster shutdown: ${JSON.stringify(reason)}`);
        clearTimeout(this._listTimer);
        clearTimeout(this._hideTimer);
        this._control.close();
        this._logs.close();
        if (this._qr.file) {
            try {
                fs.unlinkSync(this._qr.file);
            } catch (e) {
                /* gone already */
            }
        }
        this._profiles.stop();
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) =>
                logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new WazeClusterApp();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`robertn_waze_cluster failed to start: ${err && err.message}`);
});
