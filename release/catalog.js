// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * The published catalog (mgu-store docs/PUBLISHING.md, "2. Catalog"):
 * schema 2, or 1. Parse
 * and check a catalog, compare versions. No I/O.
 */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KINDS = ['app', 'tool'];

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        if (pa[i] !== pb[i]) {
            return pa[i] < pb[i] ? -1 : 1;
        }
    }
    return 0;
}

/* Parses catalog text; throws with a reason when it is unusable. */
function parse(text) {
    let catalog;
    try {
        catalog = JSON.parse(text);
    } catch (e) {
        throw new Error('catalog is not JSON');
    }
    if (!catalog || (catalog.schema !== 1 && catalog.schema !== 2) || !Array.isArray(catalog.components)) {
        throw new Error('catalog schema is not 1 or 2');
    }
    const seen = new Set();
    catalog.components.forEach((c) => {
        const a = c && c.artifact;
        if (!c || !ID.test(c.id) || KINDS.indexOf(c.kind) < 0 || !SEMVER.test(c.version) ||
            !a || typeof a.name !== 'string' || a.name !== `${c.id}@${c.version}.tgz` ||
            !SHA256.test(a.sha256) || !(a.size > 0)) {
            throw new Error(`catalog entry ${c && c.id} is malformed`);
        }
        const req = c.requires === undefined ? {} : c.requires;
        if ((c.build !== undefined && !(c.build === 'unit' && c.kind === 'app')) ||
            !req || typeof req !== 'object' || Array.isArray(req) ||
            Object.keys(req).some((k) => !ID.test(k) || k === c.id || !SEMVER.test(req[k]))) {
            throw new Error(`catalog entry ${c.id}: build must be "unit" (an app), requires must map ids to x.y.z`);
        }
        if (seen.has(c.id)) {
            throw new Error(`catalog lists ${c.id} twice`);
        }
        seen.add(c.id);
    });
    return catalog;
}

module.exports = { parse, compareVersions, SEMVER };
