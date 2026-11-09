// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* BMW's own HUD arrows for Waze (README.md "HUD arrows", experimental,
 * off by default). Waze sends CarPlay no iAP2 route guidance, so carplay never calls
 * the navigation's ProjectedModeGuiding for it, which is how Apple Maps' and
 * Google Maps' turns reach the HUD. waze-on-cluster reads Waze's next turn
 * and writes it to /run/waze-on-cluster/hud.json (every second while it
 * runs); this service makes carplay's calls with it:
 *   setGuidanceState(ACTIVE, CAR_PLAY), then updateEventsOnRoute([the turn])
 *   on each change; setGuidanceState(INACTIVE) and an empty list when the
 *   reading goes empty or stale (3 s), and on stop.
 * The event is built as carplay builds the next manoeuvre (carplay 22.28.3,
 * RouteGuidanceConverters): uid the manoeuvre's number, guidingStep GS2,
 * formattedDistance the displayed number and unit with rawDistance 1.0,
 * everything else empty or nil.
 *
 * It gives way: while the navigation's waypoints or current road are set
 * (carplay fills them for Apple's or Google's guidance; we never do) or
 * BMW's own guidance is active, it sends nothing, not even INACTIVE, which
 * would reset what the other source shows.
 *
 *   node hudguide.js          the service
 *   node hudguide.js --dry    print what it would send for each reading */
'use strict';

var fs = require('fs');
var pmgSchema = require('./pmg_schema.js');

var IFACES = '/etc/oap/someip/someip-interfaces.json';
var PMG = 'de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding';
var GUIDANCE = '/usr/lib/oap-mainapp/src-gen/de_bmw_infotainment_navigation_guiding_Guidance.json';
var HUD_JSON = '/run/waze-on-cluster/hud.json';
var STALE_MS = 3000, TICK_MS = 300, CALL_MS = 2000;

function log(m) { console.log('hudguide: ' + m); }

/* A zero value for a compact schema: the enum's 0 item (else its first), a
 * union's first member (nil for the optionals), empty arrays and strings. */
function zero(s) {
    switch (s.t) {
    case 'Struct': var o = {}; s.e.forEach(function (m) { o[m.n] = zero(m); }); return o;
    case 'Union': var u = {}; u[s.e[0].n] = zero(s.e[0]); return u;
    case 'Enum':
        var ks = Object.keys(s.e), z = ks.filter(function (k) { return s.e[k] === 0; });
        return z.length ? z[0] : ks[0];
    case 'ArrayD': return [];
    case 'Map': return {};
    case 'Bool': return false;
    case 'Utf8D': case 'Utf16D': return '';
    case 'ByteBuffer': return [];
    case 'UInt64': case 'Int64': return '0';   /* someip.node takes 64-bit integers as strings */
    default: return 0;
    }
}

/* "450 m" -> {distance: "450", unit: "METER"}; nothing for an unknown unit. */
function parseDistance(t) {
    var m = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*(m|km|ft|mi|yd)\s*$/.exec(t || '');
    if (!m) return null;
    var unit = { m: 'METER', km: 'KM', ft: 'FEET', mi: 'MILE_US', yd: 'YARD' }[m[2]];
    return { distance: m[1], unit: unit };
}

var TURNS = {
    straight: 'STRAIGHT_ON', slight_left: 'SLIGHT_LEFT', left: 'LEFT', sharp_left: 'HARD_LEFT',
    slight_right: 'SLIGHT_RIGHT', right: 'RIGHT', sharp_right: 'HARD_RIGHT', uturn_left: 'UTURN_LEFT', uturn_right: 'UTURN_RIGHT'
};

function metres(d) {
    var v = parseFloat(d.distance.replace(',', '.'));
    return v * ({ METER: 1, KM: 1000, FEET: 0.3048, MILE_US: 1609.344, YARD: 0.9144 }[d.unit] || 1);
}

/* The GuidanceEventUnion value for a reading, or null for a manoeuvre the
 * HUD has no event for (merge). */
function eventFor(unionSchema, r, uid) {
    var kind, extra = {}, mm = /^roundabout_([0-9]+)$/.exec(r.maneuver);
    if (TURNS[r.maneuver]) { kind = 'intersection'; extra.direction = TURNS[r.maneuver]; }
    else if (r.maneuver === 'keep_left' || r.maneuver === 'keep_right') {
        kind = 'branch'; extra.branchType = r.maneuver === 'keep_left' ? 'BRANCH_LEFT' : 'BRANCH_RIGHT';
    } else if (mm) {
        /* carplay without a junction angle: 90, 0, 270 for exits 1, 2, 3+ (right-hand traffic), 0 as 360 */
        var n = +mm[1];
        kind = 'roundabout'; extra.exitNumber = n; extra.exitAngle = n === 1 ? 90 : n === 2 ? 360 : 270; extra.driveDirection = 'RIGHT';
    } else if (r.maneuver === 'arrive') { kind = 'destinationManeuver'; extra.position = 'CENTER'; extra.isCheckeredFlag = true; }
    else return null;
    var member = unionSchema.e.filter(function (m) { return m.n === kind; })[0];
    if (!member) return null;
    var ev = zero(member);
    Object.keys(extra).forEach(function (k) { ev[k] = extra[k]; });
    ev.uid = String(uid);
    ev.sourceId = { simpleId: { id: '0' } };
    ev.guidingStep = 'GS2';
    ev.combinedManeuverType = 'SINGLE';
    var d = parseDistance(r.distance);
    ev.formattedDistance = d ? { distance: d.distance, unit: d.unit, rawDistance: 1.0 } : { distance: ' ', unit: 'NONE', rawDistance: 1.0 };
    var out = {};
    out[kind] = ev;
    return out;
}

/* The reading, or an empty one when the file is missing or stale. */
function readHud(path, now) {
    try {
        var st = fs.statSync(path);
        if (now - st.mtime.getTime() > STALE_MS) return { maneuver: '', distance: '' };
        if (st.size > 4096) return { maneuver: '', distance: '' };
        var j = JSON.parse(fs.readFileSync(path, 'utf8'));
        return { maneuver: String(j.maneuver || ''), distance: String(j.distance || '') };
    } catch (e) {
        return { maneuver: '', distance: '' };
    }
}

/* What to send for a reading: decided apart from SOME/IP, for the tests.
 * state: {active, key, uid, lastManeuver, lastMetres}; returns the calls in order. */
function step(state, unionSchema, r, foreign) {
    var calls = [];
    if (foreign) {
        if (state.active) log('another source guides the HUD: giving way');
        state.active = false; state.key = '';
        return calls;
    }
    var ev = null;
    if (r.maneuver) {
        /* a new manoeuvre: another kind, or the distance went up (the next one, same kind) */
        var d = parseDistance(r.distance), m = d ? metres(d) : -1;
        if (r.maneuver !== state.lastManeuver || (m >= 0 && state.lastMetres >= 0 && m > state.lastMetres + 30)) state.uid++;
        state.lastMetres = m;
        ev = eventFor(unionSchema, r, state.uid);
        state.lastManeuver = r.maneuver;
    } else {
        state.lastManeuver = '';
    }
    if (ev) {
        if (!state.active) calls.push(['setGuidanceState', { guidanceState: 'ACTIVE', guidingProvider: 'CAR_PLAY' }]);
        var key = JSON.stringify(ev);
        if (!state.active || key !== state.key) calls.push(['updateEventsOnRoute', { eors: [ev] }]);
        state.active = true; state.key = key;
    } else if (state.active && r.maneuver) {
        /* a manoeuvre the HUD has no event for (merge): no arrow, still guiding */
        if (state.key !== '[]') calls.push(['updateEventsOnRoute', { eors: [] }]);
        state.key = '[]';
    } else if (state.active) {
        calls.push(['updateEventsOnRoute', { eors: [] }]);
        calls.push(['setGuidanceState', { guidanceState: 'INACTIVE', guidingProvider: 'CAR_PLAY' }]);
        state.active = false; state.key = '';
    }
    return calls;
}

function nonEmpty(v, f) {
    if (f === 'waypoints') return Array.isArray(v) && v.length > 0;
    return !!(v && v.elements && v.elements.length);
}

function main(dry) {
    var schema = pmgSchema(JSON.parse(fs.readFileSync(IFACES, 'utf8')), PMG);
    var unionSchema = schema.methods.updateEventsOnRoute.schema.e[0].e;
    var state = { active: false, key: '', uid: 0, lastManeuver: '', lastMetres: -1, loggedUid: -1 };
    if (dry) {
        var last = '';
        setInterval(function () {
            var r = readHud(HUD_JSON, Date.now()), k = JSON.stringify(r);
            if (k === last) return;
            last = k;
            step(state, unionSchema, r, false).forEach(function (c) { log(c[0] + ' ' + JSON.stringify(c[1])); });
        }, TICK_MS);
        return;
    }
    var someip = require('/usr/lib/someip.node');
    var pmg, g = null, other = { waypoints: false, currentRoad: false }, bmwGuiding = false, stopping = false;
    var inflight = Promise.resolve(), busy = false, fails = 0, quietUntil = 0;
    function foreign() { return other.waypoints || other.currentRoad || bmwGuiding; }
    var CLEAR = [['updateEventsOnRoute', { eors: [] }], ['setGuidanceState', { guidanceState: 'INACTIVE', guidingProvider: 'CAR_PLAY' }]];
    /* In order; stops before a call once another source guides (it would reset what that source shows). */
    function send(calls, evenIfForeign) {
        return calls.reduce(function (p, c) {
            return p.then(function () {
                if (foreign() && !evenIfForeign) throw new Error('another source started guiding');
                return pmg.callMethod(c[0], c[1], CALL_MS).then(function () {
                    if (c[0] === 'setGuidanceState') log('setGuidanceState ' + c[1].guidanceState);
                    else if (!c[1].eors.length) log('updateEventsOnRoute: none');
                    else if (c[1].eors[0] && JSON.stringify(c[1].eors[0]).indexOf('"uid":"' + state.uid + '"') >= 0 && state.loggedUid !== state.uid) {
                        state.loggedUid = state.uid;
                        log('updateEventsOnRoute ' + JSON.stringify(c[1].eors[0]).slice(0, 160));
                    }
                });
            });
        }, Promise.resolve());
    }
    function tick() {
        var now = Date.now();
        if (busy || stopping || now < quietUntil) return;
        var was = { active: state.active, key: state.key };
        var calls = step(state, unionSchema, readHud(HUD_JSON, now), foreign());
        if (!calls.length) return;
        busy = true;
        inflight = send(calls).then(function () { fails = 0; }, function (e) {
            /* send it all again, from where it was, after a pause */
            state.active = was.active; state.key = '';
            if (/another source/.test(String(e))) { state.active = false; return; }
            fails++;
            quietUntil = Date.now() + 5000;
            log('call failed (' + fails + '): ' + e + '; again in 5 s');
            if (fails >= 5) {
                log('giving up after 5 failures');
                stopping = true;
                return send(CLEAR).catch(function () {}).then(function () { process.exit(1); });
            }
        }).then(function () { busy = false; });
    }
    function stop() {
        if (stopping) return;
        stopping = true;
        var t = setTimeout(function () { process.exit(0); }, 4000);
        inflight.then(function () {
            return state.active ? send(CLEAR) : null;
        }).catch(function (e) { log('clearing on stop: ' + e); })
            .then(function () { clearTimeout(t); process.exit(0); });
    }
    /* the giving-way flags: read now, and again whenever the navigation comes back */
    function readFlags() {
        var reads = ['waypoints', 'currentRoad'].map(function (f) {
            return pmg.getValue(f, CALL_MS).then(function (v) { other[f] = nonEmpty(v, f); });
        });
        if (g) reads.push(g.getValue('guidanceState', CALL_MS).then(setBmw));
        return Promise.all(reads);
    }
    function setBmw(v) { bmwGuiding = v === 'ACTIVE' || v === 'CALCULATING_ROUTE'; }
    function retry(what, fn, n) {
        return fn().catch(function (e) {
            if (n <= 1) throw e;
            log(what + ': ' + e + '; again in 2 s');
            return new Promise(function (r) { setTimeout(r, 2000); }).then(function () { return retry(what, fn, n - 1); });
        });
    }
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    Promise.resolve(someip.buildProxy(schema, 'Main_Instance')).then(function (p) {
        pmg = p;
        return pmg.init();
    }).then(function () {
        return Promise.resolve(someip.buildProxy(JSON.parse(fs.readFileSync(GUIDANCE, 'utf8')), 'Main_Instance')).then(function (gp) {
            return gp.init().then(function () { g = gp; });
        });
    }).then(function () {
        return Promise.all(['waypoints', 'currentRoad'].map(function (f) {
            return pmg.subscribe({ name: f, onReceive: function (v) { other[f] = nonEmpty(v, f); } });
        }).concat([g.subscribe({ name: 'guidanceState', onReceive: setBmw })]));
    }).then(function () {
        /* the navigation is offered a while after boot: wait for it, up to 2 min */
        return retry('reading the navigation', readFlags, 60);
    }).then(function () {
        pmg.subscribeToAvailability(function (up) {
            if (!up) return;
            /* a restarted navigation has none of ours: start over */
            state.active = false; state.key = '';
            readFlags().catch(function (e) { log('re-reading after the navigation came back: ' + e); });
        });
        /* a killed predecessor may have left an arrow: clear it, unless another source guides */
        var clear = fs.existsSync(HUD_JSON) && !foreign() ? send(CLEAR) : Promise.resolve();
        return clear.then(function () {
            log('ready: ' + HUD_JSON + ' -> ProjectedModeGuiding');
            setInterval(tick, TICK_MS);
        });
    }).catch(function (e) {
        log('cannot reach the navigation: ' + e);
        process.exit(1);   /* systemd starts it again, within its start limit */
    });
}

module.exports = { zero: zero, parseDistance: parseDistance, eventFor: eventFor, step: step, readHud: readHud };

if (require.main === module) main(process.argv.indexOf('--dry') > 0);
