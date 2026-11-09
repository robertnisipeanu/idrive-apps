// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* hudguide.js and pmg_schema.js on a small synthetic interface file shaped
 * like the unit's (no BMW data): the conversion, the events built for each
 * reading, and the calls made as readings come and go. */
'use strict';
var assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
var conv = require('../pmg_schema.js'), hg = require('../hudguide.js');

var T = 'x.GuidingTypes.';
var all = {
    datatypes: {},
    instanceIDs: { 'x.Pmg': { Main_Instance: 128 } },
    interfaces: { 'x.Pmg': { name: 'Pmg', serviceId: 1, version: { major: 1, minor: 3 },
        methods: { updateEventsOnRoute: { methodId: 13, inputs: [{ name: 'eors', dataRef: T + 'U', dimension: 1 }], outputs: [] } },
        fields: { waypoints: { dataRef: 'UInt8', dimension: 1, getter: { id: 5 }, notifier: { id: 32771, eventgroups: [3] } } } } }
};
function def(n, d) { all.datatypes[T + n] = Object.assign({ name: n }, d); }
def('Unit', { type: 'enum', items: { NONE: 0, KM: 1, METER: 4 }, enumWidth: 1 });
def('Turn', { type: 'enum', items: { NONE: 0, STRAIGHT_ON: 1, LEFT: 2, RIGHT: 5 } });
def('Step', { type: 'enum', items: { GS0: 0, GS2: 2 } });
def('Comb', { type: 'enum', items: { FIRST: 1, SINGLE: 0 } });
def('Nil', { type: 'enum', items: { NO_VALUE: 0 } });
def('Opt', { type: 'union', members: [{ name: 'nil', dataRef: T + 'Nil' }, { name: 'value', dataRef: 'UInt8' }] });
def('Src', { type: 'union', members: [{ name: 'simpleId', dataRef: T + 'Sid' }, { name: 'trafficId', dataRef: 'UInt64' }] });
def('Sid', { type: 'struct', members: [{ name: 'id', dataRef: 'UInt64' }] });
def('Fd', { type: 'struct', members: [{ name: 'distance', dataRef: 'Utf8D' }, { name: 'unit', dataRef: T + 'Unit' }, { name: 'rawDistance', dataRef: 'Double' }] });
def('Ev', { type: 'struct', members: [{ name: 'uid', dataRef: 'UInt64' }, { name: 'distanceToDestination', dataRef: 'Double' }, { name: 'sourceId', dataRef: T + 'Src' }] });
def('Panel', { type: 'struct', extends: T + 'Ev', members: [{ name: 'formattedDistance', dataRef: T + 'Fd' }, { name: 'guidingStep', dataRef: T + 'Step' },
    { name: 'combinedManeuverType', dataRef: T + 'Comb' }, { name: 'tags', dataRef: 'Utf8D', dimension: 1, arrayMaxLength: 9 }] });
def('Inter', { type: 'struct', extends: T + 'Panel', members: [{ name: 'direction', dataRef: T + 'Turn' }, { name: 'roadlinks', dataRef: T + 'Opt' }] });
def('Round', { type: 'struct', extends: T + 'Panel', members: [{ name: 'exitAngle', dataRef: 'UInt16' }, { name: 'exitNumber', dataRef: 'UInt8' }] });
def('U', { type: 'union', members: [{ name: 'pointOfInterest', dataRef: T + 'Ev' }, { name: 'intersection', dataRef: T + 'Inter' }, { name: 'roundabout', dataRef: T + 'Round' }] });

var s = conv(all, 'x.Pmg');
var u = s.methods.updateEventsOnRoute.schema.e[0];
assert.strictEqual(u.t, 'ArrayD');
assert.strictEqual(u.e.t, 'Union');
var inter = u.e.e[1];
assert.deepStrictEqual(inter.e.map(function (m) { return m.n; }),
    ['uid', 'distanceToDestination', 'sourceId', 'formattedDistance', 'guidingStep', 'combinedManeuverType', 'tags', 'direction', 'roadlinks'], 'extends: the parents\' members first');
assert.strictEqual(inter.e[3].e[1].w, 1, 'an enum width other than 4 is kept');
assert.strictEqual(inter.e[7].w, undefined, 'the default width is left out');
assert.deepStrictEqual(inter.e[6], { n: 'tags', t: 'ArrayD', e: { t: 'Utf8D' }, xl: 9 });
assert.deepStrictEqual(s.fields.waypoints, { schema: { t: 'ArrayD', e: { t: 'UInt8' } }, getter: { id: 5 }, event: { id: 32771, groups: [3] } });

assert.deepStrictEqual(hg.parseDistance('450 m'), { distance: '450', unit: 'METER' });
assert.deepStrictEqual(hg.parseDistance('1,5 km'), { distance: '1,5', unit: 'KM' });
assert.strictEqual(hg.parseDistance('?'), null);

var ev = hg.eventFor(u.e, { maneuver: 'right', distance: '450 m' }, 7);
assert.deepStrictEqual(ev, { intersection: { uid: '7', distanceToDestination: 0, sourceId: { simpleId: { id: '0' } },
    formattedDistance: { distance: '450', unit: 'METER', rawDistance: 1 }, guidingStep: 'GS2', combinedManeuverType: 'SINGLE', tags: [],
    direction: 'RIGHT', roadlinks: { nil: 'NO_VALUE' } } });
var rb = hg.eventFor(u.e, { maneuver: 'roundabout_2', distance: '' }, 1).roundabout;
assert.strictEqual(rb.exitNumber, 2);
assert.strictEqual(rb.exitAngle, 360);
assert.strictEqual(rb.formattedDistance.unit, 'NONE');
assert.strictEqual(hg.eventFor(u.e, { maneuver: 'merge', distance: '' }, 1), null, 'no event for merge');
assert.strictEqual(hg.eventFor(u.e, { maneuver: 'keep_left', distance: '' }, 1), null, 'no branch in this schema: nothing, not a throw');

var st = { active: false, key: '', uid: 0, lastManeuver: '', lastMetres: -1 };
function names(c) { return c.map(function (x) { return x[0] + (x[1].guidanceState ? ':' + x[1].guidanceState : ':' + x[1].eors.length); }); }
assert.deepStrictEqual(names(hg.step(st, u.e, { maneuver: 'right', distance: '450 m' }, false)), ['setGuidanceState:ACTIVE', 'updateEventsOnRoute:1']);
assert.deepStrictEqual(names(hg.step(st, u.e, { maneuver: 'right', distance: '450 m' }, false)), [], 'unchanged: nothing sent');
assert.deepStrictEqual(names(hg.step(st, u.e, { maneuver: 'right', distance: '400 m' }, false)), ['updateEventsOnRoute:1']);
assert.strictEqual(st.uid, 1, 'a distance tick keeps the uid');
hg.step(st, u.e, { maneuver: 'right', distance: '900 m' }, false);
assert.strictEqual(st.uid, 2, 'the distance went up: the next manoeuvre');
hg.step(st, u.e, { maneuver: 'left', distance: '800 m' }, false);
assert.strictEqual(st.uid, 3, 'another kind: the next manoeuvre');
assert.deepStrictEqual(names(hg.step(st, u.e, { maneuver: 'merge', distance: '' }, false)), ['updateEventsOnRoute:0'], 'unmapped: no arrow, still ACTIVE');
assert.strictEqual(st.active, true);
assert.deepStrictEqual(names(hg.step(st, u.e, { maneuver: 'merge', distance: '' }, false)), [], 'unmapped again: nothing');
assert.deepStrictEqual(names(hg.step(st, u.e, { maneuver: '', distance: '' }, false)), ['updateEventsOnRoute:0', 'setGuidanceState:INACTIVE']);
assert.deepStrictEqual(names(hg.step(st, u.e, { maneuver: '', distance: '' }, false)), [], 'already clear');
hg.step(st, u.e, { maneuver: 'left', distance: '80 m' }, false);
assert.deepStrictEqual(names(hg.step(st, u.e, { maneuver: 'left', distance: '70 m' }, true)), [], 'giving way: nothing, not even INACTIVE');
assert.strictEqual(st.active, false);
assert.deepStrictEqual(names(hg.step(st, u.e, { maneuver: 'left', distance: '60 m' }, false)), ['setGuidanceState:ACTIVE', 'updateEventsOnRoute:1'], 'back once free');

var f = path.join(os.tmpdir(), 'hudguide-test.json');
fs.writeFileSync(f, '{"maneuver":"left","distance":"30 m","at":1}\n');
assert.deepStrictEqual(hg.readHud(f, Date.now()), { maneuver: 'left', distance: '30 m' });
assert.deepStrictEqual(hg.readHud(f, Date.now() + 5000), { maneuver: '', distance: '' }, 'stale');
fs.unlinkSync(f);
assert.deepStrictEqual(hg.readHud(f, Date.now()), { maneuver: '', distance: '' }, 'missing');
console.log('hudguide_test: all passed');
