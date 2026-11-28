// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/**
 * What the main page's preview shows for each row the controller stops on:
 * a picture and a few lines that say what the row does, as BMW's own
 * settings pages do. The page is a narrow list with the preview on its
 * right (LT_State_Regular_ContentHidden); the preview is one component of
 * type "preview" (LT_PreviewTable_1Graphic_1TextBottom: the picture across
 * the whole area, up to three lines of text over its bottom third), named
 * by the page's Preview property, and the app writes its Description and
 * Illustration cells when a row takes the focus.
 *
 * Show on is a value list: each of its choices has its own preview while
 * the list is open, and its name has one while it is closed. The Logs page
 * has its own preview, the same way, its picture the QR code.
 *
 * The pictures are package/previews/<image>.png, 957 × 639 (the preview's
 * size in the HMI's 1920 × 720 units; smaller displays scale the whole page
 * down alike), drawn by tools/previews.swift. The texts are words of the
 * app's languages (src/i18n.js), each kept to three lines of the preview
 * (tools/test_i18n.js).
 */
const { t } = require('./i18n.js');

/* The rows by component name: the picture and the text. */
const ROWS = {
    wocShowOn: { image: 'cluster', text: () => t('Where the phone\'s map shows. Open the list to see what each choice does.') },
    wocProfile: { image: 'profile', text: () => t('Ticked, this driver profile keeps its own Show on, HUD size and HUD position.') },
    wocGuide: { image: 'turn-box', text: () => t('Ticked, BMW\'s turn-by-turn box on the cluster is hidden while the map shows.') },
    wocLogs: { image: 'logs', text: () => t('Opens the Logs page: save the logs to report a problem, and download them on your phone.') },
    wocHudKeep: { image: 'hud-keep', text: () => t('Ticked, the map stays on the HUD while BMW\'s media and list pop-ups show.') },
    wocHudSize: { image: 'hud-size', text: () => t('How wide the map is on the HUD.') },
    wocHudLeft: { image: 'hud-move', text: () => t('Moves the map on the HUD, a step at a time.') },
    wocHudRight: { image: 'hud-move', text: () => t('Moves the map on the HUD, a step at a time.') },
    wocHudUp: { image: 'hud-move', text: () => t('Moves the map on the HUD, a step at a time.') },
    wocHudDown: { image: 'hud-move', text: () => t('Moves the map on the HUD, a step at a time.') },
    wocHudCentre: { image: 'hud-centre', text: () => t('Puts the map back in the middle of the HUD.') },
    wocEnable: { image: 'phone-patch', text: () => t('Turns the map on for CarPlay. Only needed when its Status isn\'t Patched.') },
    wocDisable: { image: 'phone-unpatch', text: () => t('Turns the map off for CarPlay. It stays off, also after updates, until you press Patch.') },
    wocAaEnable: { image: 'phone-patch', text: () => t('Turns the map on for Android Auto. Only needed when its Status isn\'t Patched.') },
    wocAaDisable: { image: 'phone-unpatch', text: () => t('Turns the map off for Android Auto. It stays off, also after updates, until you press Patch.') },
    wocAaZoomOut: { image: 'zoom', text: () => t('Zoom out shows more of the map, Zoom in bigger text. Applied at the next restart.') },
    wocAaZoomIn: { image: 'zoom', text: () => t('Zoom out shows more of the map, Zoom in bigger text. Applied at the next restart.') },
    wocAaCard: { image: 'phone-card', text: () => t('Ticked, Google Maps\' own turn card at the top of the map is hidden.') },
    wocRestart: { image: 'restart', text: () => t('Restarts the head unit, to apply the changes that wait for it.') }
};

/* The Logs page's rows. Their picture, 'qr', is the QR code of the address
 * the saved logs download from, drawn on the same background (src/qr.js),
 * or the logs picture while there is no address. */
const LOGS_ROWS = {
    wocCapture: { image: 'qr', text: () => t('To look into a problem: start the capture, reconnect the phone, wait for the problem, then press Save logs.') },
    wocLogsSave: { image: 'qr', text: () => t('Saves the map\'s logs and the head unit\'s recent messages in a file, to attach to a problem report.') }
};
[1, 2, 3, 4, 5].forEach((i) => {
    LOGS_ROWS[`wocLogsRow${i}`] = { image: 'qr',
        text: () => t('With a phone on the car\'s Wi-Fi hotspot, scan the code or open the address to download the saved logs.') };
});

/* Show on's choices, in the list's order (SHOWN_ON of waze_cluster_control.js). */
const SHOW_ON_CHOICES = [
    { image: 'cluster', text: () => t('The map shows on the instrument cluster, in place of BMW\'s, while the phone navigates.') },
    { image: 'hud', text: () => t('The map shows on the head-up display. Still experimental.') },
    { image: 'cluster-hud', text: () => t('The map shows on both: the instrument cluster and the head-up display.') },
    { image: 'off', text: () => t('The map shows on neither: the cluster and the HUD show BMW\'s own content.') }
];

/* What the preview shows for a row (and, for Show on, a choice: row 0 to 3
 * while the list is open, anything else its name): { image, text }, or null
 * for a row without one. */
function preview(name, row) {
    const choice = name === 'wocShowOn' && Number.isInteger(row) && row >= 0 ? SHOW_ON_CHOICES[row] : null;
    const entry = choice || ROWS[name] || LOGS_ROWS[name];
    return entry ? { image: entry.image, text: entry.text() } : null;
}

/* Every picture the previews use, for the app to register at start. */
function images() {
    return [...new Set(Object.values(ROWS).concat(SHOW_ON_CHOICES).map((e) => e.image).concat('logs'))].sort();
}

module.exports = { ROWS, LOGS_ROWS, SHOW_ON_CHOICES, preview, images };
