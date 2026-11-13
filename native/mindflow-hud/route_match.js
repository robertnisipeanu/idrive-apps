// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Keeps the drawn route honest against the phone. The phone (Android Auto, via
// the guidance list) stays authoritative for turns; our route only supplies
// geometry while it agrees. Each update compares the route's next maneuver with
// the phone's: on a clear, repeated disagreement it clips the cyan line before
// the disputed junction and asks route_full to reroute; agreement restores it.
//
// Conventions (VELA-NOTES): several observations >=0.5 s apart; two conflicting
// observations are needed to clip/reroute, preventing flicker; missing data is
// never a disagreement.
const EVIDENCE_GAP_MS = 500;      // observations closer than this are not new evidence
const CONFIRM = 2;                // consecutive agreements/disagreements to act
const SIDE_TOL = null;            // side must match outright
const DIST_TOL_FRAC = 0.5, DIST_TOL_MIN_M = 120;   // distance-to-turn tolerance
const GUIDANCE_GAP_MS = 8000;     // a long gap resets the streak
const PHONE_SETTLE_MS = 1000;     // phone maneuver unchanged this long before Vela is asked
const OFF_ROUTE_M = 30;           // car this far from the line (2 fixes) has left the route
const OFF_HEADING_M = 10, OFF_HEADING_DEG = 50;   // >10 m off and heading >50 deg from the line also counts
const LATERAL_TAU_MS = 15000, LATERAL_MAX_M = 15;   // learned side offset: time constant and cap
const OFF_PERSIST_MS = 800;       // off the line this long (by time) before it counts
const OFF_ROUTE_WAIT_MS = 5000;   // off the route, ask Vela after this even if the phone never recalculates
// what identifies "the same instruction" from the phone (distance excluded: it counts down)
function phoneSignature(m) { return [m.kind, m.direction, m.branch, m.side, m.exit, m.text].join('|'); }

function local(p, o) { return [(p[0] - o[0]) * 111320 * Math.cos(o[1] * Math.PI / 180), (p[1] - o[1]) * 111320]; }
// nearest point on a polyline to c; returns {seg, t, alongM} (alongM = metres from start)
function project(coords, c) {
    var best = null, along = 0;
    for (var i = 1; i < coords.length; i++) {
        var a = local(coords[i - 1], c), b = local(coords[i], c);
        var dx = b[0] - a[0], dy = b[1] - a[1], n = dx * dx + dy * dy;
        var t = n < 1e-9 ? 0 : Math.max(0, Math.min(1, (-a[0] * dx - a[1] * dy) / n));
        var qx = a[0] + t * dx, qy = a[1] + t * dy, d = Math.hypot(qx, qy);
        var segLen = Math.hypot(dx, dy);
        if (!best || d < best.d) best = { d: d, seg: i, t: t, alongM: along + t * segLen };
        along += segLen;
    }
    return best;
}
// metres from the route start to the vertex nearest to point p
function alongTo(coords, p) {
    var o = coords[0], best = null, along = 0;
    for (var i = 1; i < coords.length; i++) {
        var a = local(coords[i - 1], o), b = local(coords[i], o), q = local(p, o);
        var dx = b[0] - a[0], dy = b[1] - a[1], n = dx * dx + dy * dy;
        var t = n < 1e-9 ? 0 : Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / n));
        var qx = a[0] + t * dx, qy = a[1] + t * dy, d = Math.hypot(qx - q[0], qy - q[1]);
        var segLen = Math.hypot(dx, dy);
        if (!best || d < best.d) best = { d: d, alongM: along + t * segLen, seg: i };
        along += segLen;
    }
    return best;
}
function phoneSide(m) {
    if (!m) return null;
    if (m.kind === 'roundabout') return m.side === 'LEFT' ? 'left' : 'right';
    var v = String(m.direction || m.branch || '');
    if (/U_?TURN/.test(v)) return 'uturn';
    if (/STRAIGHT_ON|^NONE$|CONTINUE/.test(v)) return 'straight';
    return /LEFT/.test(v) ? 'left' : /RIGHT/.test(v) ? 'right' : null;
}
function routeSide(step) {
    if (!step) return null;
    if (step.type === 'roundabout' || step.type === 'rotary') return /left/i.test(step.modifier) ? 'left' : 'right';
    var mod = String(step.modifier || '').toLowerCase();
    if (/uturn|u-turn/.test(mod) || step.type === 'uturn') return 'uturn';
    if (/straight/.test(mod) || step.type === 'straight' || step.type === 'continue' || step.type === 'merge') return 'straight';
    return /left/.test(mod) ? 'left' : /right/.test(mod) ? 'right' : null;
}
var UNIT_M = { METER: 1, KM: 1000, MILE_UK: 1609.34, MILE_US: 1609.34, YARD: 0.9144, FEET: 0.3048 };
function phoneMetres(m) {
    if (!m || typeof m.distance !== 'string') return null;
    var n = parseFloat(m.distance.replace(',', '.')), f = UNIT_M[m.unit];
    return isFinite(n) && n > 0 && f ? n * f : null;
}


// Track progress in route order. Nearby later loop segments cannot move the car
// forward by more than the distance supported by its new position sample.
class RouteProgress {
    constructor() { this.route = null; this.along = 0; this.fix = null; }
    update(route, fix) {
        const changed = route !== this.route;
        if (changed) { this.route = route; this.along = 0; this.fix = null; }
        if (!route || !route.coordinates || route.coordinates.length < 2) return;
        if (this.fix && Number.isFinite(fix.at) && fix.at === this.fix.at) return;
        const coords = route.coordinates, here = [fix.lon, fix.lat];
        const moved = this.fix ? Math.hypot.apply(null, local(here, [this.fix.lon, this.fix.lat])) : 0;
        const limit = this.fix ? this.along + Math.max(30, moved * 2 + 10) : Infinity;
        let along = 0, best = null;
        for (let i = 1; i < coords.length; i++) {
            const a = local(coords[i - 1], here), b = local(coords[i], here);
            const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
            if (length > 0 && along + length >= this.along && along <= limit) {
                const lo = Math.max(0, (this.along - along) / length), hi = Math.min(1, (limit - along) / length);
                const t = Math.max(lo, Math.min(hi, (-a[0] * dx - a[1] * dy) / (length * length)));
                const d = Math.hypot(a[0] + t * dx, a[1] + t * dy);
                if (!best || d < best.d - .01) best = { d, along: along + t * length };
            }
            along += length;
        }
        if (best && best.d <= 40) this.along = Math.max(this.along, best.along);
        this.fix = Object.assign({}, fix);
    }
    display(coordinates, fix) {
        if (!coordinates || coordinates.length < 2) return [];
        const here = [fix.lon, fix.lat], out = []; let along = 0;
        // Exclude completed segments before asking the renderer for a nearest point.
        for (let i = 1; i < coordinates.length; i++) {
            const a = coordinates[i - 1], b = coordinates[i], v = local(b, a), length = Math.hypot(v[0], v[1]);
            if (along + length > this.along + .01) {
                if (!out.length) { const t = Math.max(0, (this.along - along) / length); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
                out.push(b);
            }
            along += length;
        }
        // Keep a continuous long line, but stop a later loop before it returns
        // within 35 m of the car and resembles another immediate instruction.
        let travelled = 0;
        for (let i = 1; i < out.length; i++) {
            const a = local(out[i - 1], here), b = local(out[i], here), dx = b[0] - a[0], dy = b[1] - a[1];
            const length = Math.hypot(dx, dy), n = length * length, dot = a[0] * dx + a[1] * dy;
            const disc = dot * dot - n * (a[0] * a[0] + a[1] * a[1] - 35 * 35);
            if (n > 0 && disc >= 0) {
                const t = (-dot - Math.sqrt(disc)) / n;
                if (t >= 0 && t <= 1 && travelled + t * length > 100) {
                    return out.slice(0, i).concat([[out[i - 1][0] + t * (out[i][0] - out[i - 1][0]), out[i - 1][1] + t * (out[i][1] - out[i - 1][1])]]);
                }
            }
            travelled += length;
        }
        return out;
    }
}

class RouteMatch {
    constructor(options) {
        var o = options || {};
        this.wall = o.wall || Date.now;
        this.agree = 0; this.disagree = 0; this.lastAt = 0; this.lastGuidanceAt = 0;
        this.clipIndex = null; this.clipAlong = null; this.state = 'idle'; this.rerouteWanted = false; this.last = null;
        this.phoneSig = null; this.phoneSince = 0; this.phoneFresh = false; this.phoneDist = null; this.offSince = 0; this.lateral = 0; this.lateralAt = 0;
    }
    // route = {coordinates, steps}; phone = the guidance maneuver (or null)
    update(fix, route, phone) {
        var now = this.wall();
        if (!route || !route.coordinates || route.coordinates.length < 2) { this.reset('no route'); return this.result(); }
        if (phone) {
            this.lastGuidanceAt = now;
            var sig = phoneSignature(phone);
            // A change while the old maneuver was still well ahead is a recalculation; a change
            // near 0 m is the phone advancing to its next turn and is not evidence.
            if (sig !== this.phoneSig) { this.phoneFresh = this.phoneSig !== null && this.phoneDist !== null && this.phoneDist > 60; this.phoneSig = sig; this.phoneSince = now; }
            this.phoneDist = phoneMetres(phone);
        }
        else if (now - this.lastGuidanceAt > GUIDANCE_GAP_MS) { this.agree = this.disagree = 0; }   // guidance gap resets streaks
        if (now - this.lastAt < EVIDENCE_GAP_MS) return this.result();                               // not new evidence yet
        this.lastAt = now;

        var proj = project(route.coordinates, [fix.lon, fix.lat]);
        // the next route maneuver ahead of the car
        var nextStep = null, nextAlong = Infinity, carAlong = Number.isFinite(fix.routeAlong) ? fix.routeAlong : proj ? proj.alongM : 0;
        (route.steps || []).forEach(function (s) {
            if (s.type === 'arrive') return;
            var a = alongTo(route.coordinates, s.at);
            if (a && a.alongM > carAlong + .5 && a.alongM < nextAlong) { nextStep = Object.assign({ _along: a.alongM, _seg: a.seg }, s); nextAlong = a.alongM; }
        });

        var ps = phoneSide(phone), rs = routeSide(nextStep);
        var pd = phoneMetres(phone), rd = nextStep ? nextStep._along - carAlong : null;
        this.last = { phoneSide: ps, routeSide: rs, phoneDist: pd, routeDist: rd === null ? null : Math.round(rd) };

        // a disagreement needs both sides known and clearly different, or distances far apart
        // Off the line: the car left the route itself. This needs no phone data, so the cyan line
        // reacts on GPS alone instead of waiting for Android Auto to notice and recalculate.
        // It also stops a stalled route position from "agreeing" with an unrelated later turn.
        // A car that turned away is detected from its heading well before it is 30 m away.
        // Heading difference to the closest-matching route segment within 30 m (near a corner the
        // nearest segment can be the outgoing road, e.g. right lane before a right turn).
        var headingOff = null;
        if (proj && Number.isFinite(fix.heading)) {
            for (var si = Math.max(1, proj.seg - 2); si <= Math.min(route.coordinates.length - 1, proj.seg + 2); si++) {
                var sp = project([route.coordinates[si - 1], route.coordinates[si]], [fix.lon, fix.lat]);
                if (si !== proj.seg && (!sp || sp.d > 30)) continue;
                var sa = local(route.coordinates[si - 1], route.coordinates[si]);
                var sh = (Math.atan2(-sa[0], -sa[1]) * 180 / Math.PI + 360) % 360, off = Math.abs(((fix.heading - sh + 540) % 360) - 180);
                if (headingOff === null || off < headingOff) headingOff = off;
            }
        }
        // Distance from the line is measured from the car's usual side offset: a dual carriageway
        // drawn on its centre line, or slow GPS drift, keeps the car metres to one side for minutes.
        // The offset is learned slowly while on the route (capped), so a real turn-off still shows.
        var dev = proj ? proj.d : 0;
        if (proj) {
            var A = local(route.coordinates[proj.seg - 1], [fix.lon, fix.lat]), Bp = local(route.coordinates[proj.seg], [fix.lon, fix.lat]);
            var side = (Bp[0] - A[0]) * (-A[1]) - (Bp[1] - A[1]) * (-A[0]) >= 0 ? 1 : -1, signed = side * proj.d;
            dev = Math.abs(signed - this.lateral);
        }
        var turnedAway = headingOff !== null && dev > OFF_HEADING_M && headingOff > OFF_HEADING_DEG;
        var offRoute = !!proj && (dev > OFF_ROUTE_M || turnedAway);
        if (proj && !offRoute && this.state !== 'mismatch') {
            var w = Math.min(1, (now - (this.lateralAt || now)) / LATERAL_TAU_MS);
            this.lateral += (Math.max(-LATERAL_MAX_M, Math.min(LATERAL_MAX_M, signed)) - this.lateral) * w;
        }
        this.lateralAt = now;
        // Confirmed by time, not by a count of observations: at 5-10 Hz two noisy fixes are only
        // 0.5 s apart. A clear turn-away (>15 m, >60 deg over a >=10 m course) is decisive at once.
        // At 5-10 Hz a single noisy course can swing; there the turn-away must repeat on the next
        // observation (0.5 s). At ~1 Hz the course spans the whole inter-fix distance and one counts.
        var clearlyNow = turnedAway && dev > 15 && headingOff > 60;
        var clearlyAway = clearlyNow && (this.prevClearly || now - (this.prevObsAt || 0) >= 900);
        this.prevClearly = clearlyNow; this.prevObsAt = now;
        if (offRoute) {
            this.offSince = this.offSince || now; this.agree = 0;
            if (clearlyAway || now - this.offSince >= OFF_PERSIST_MS) this.disagree = Math.max(CONFIRM, this.disagree + 1);
        }
        else this.offSince = 0;
        var decided = !offRoute && ps && rs;
        var sideBad = decided && ps !== rs;
        var phoneRoundabout = phone && phone.kind === 'roundabout';
        var routeRoundabout = nextStep && /^(roundabout|rotary)$/.test(nextStep.type);
        var exitBad = phoneRoundabout && routeRoundabout && Number.isInteger(phone.exit) && phone.exit > 0 && Number.isInteger(nextStep.exit) && nextStep.exit > 0 && phone.exit !== nextStep.exit;
        var distBad = decided && pd !== null && rd !== null && Math.abs(pd - rd) > Math.max(DIST_TOL_MIN_M, DIST_TOL_FRAC * Math.min(pd, rd));
        if (!decided && !offRoute) { /* missing data: no evidence either way */ return this.result(); }

        // A phone maneuver that just changed (Android Auto rerouted) and contradicts the route's
        // side or exit is decisive: clip at once so the local line follows the phone's turn.
        var fresh = this.phoneFresh && now - this.phoneSince <= 2000; this.phoneFresh = false;
        if (offRoute) { /* already counted */ }
        else if (fresh && (sideBad || exitBad)) { this.disagree = CONFIRM; this.agree = 0; }
        else if (sideBad || distBad || exitBad) { this.disagree++; this.agree = 0; }
        else { this.agree++; this.disagree = 0; }

        if (this.disagree >= CONFIRM) {
            // clip before the disputed junction (off the route: drop the line entirely so the
            // local fallback follows the car's own road), and ask for a reroute once
            this.clipIndex = offRoute ? null : nextStep ? nextStep._seg : null;
            this.clipAlong = offRoute ? 0 : nextStep ? Math.max(0, nextStep._along - 8) : 0;
            if (this.state !== 'mismatch') {
                this.rerouteWanted = true; this.state = 'mismatch';
                var why = offRoute ? (turnedAway ? 'turned away' : 'off the line') : fresh ? 'phone recalculated' : sideBad ? 'turn side' : exitBad ? 'roundabout exit' : 'turn distance';
            }
        } else if (this.agree >= CONFIRM) {
            this.clipIndex = null; this.clipAlong = null; this.state = 'agree'; this.rerouteWanted = false;
        }
        return this.result();
    }
    // Stop accumulating evidence while stationary; retain an existing disputed-line cutoff.
    pause() { this.agree = this.disagree = 0; this.lastAt = 0; this.rerouteWanted = false; }
    // the drawn line, clipped before a disputed junction while mismatched
    clip(coordinates) {
        if (this.clipAlong === null) return coordinates;
        if (this.clipAlong <= 0 || coordinates.length < 2) return [];
        var c = [coordinates[0]], along = 0, origin = coordinates[0];
        for (var i = 1; i < coordinates.length; i++) {
            var a = local(coordinates[i - 1], origin), b = local(coordinates[i], origin);
            var length = Math.hypot(b[0] - a[0], b[1] - a[1]);
            if (along + length >= this.clipAlong) {
                var t = length ? (this.clipAlong - along) / length : 0;
                if (t > 0) c.push([coordinates[i - 1][0] + t * (coordinates[i][0] - coordinates[i - 1][0]), coordinates[i - 1][1] + t * (coordinates[i][1] - coordinates[i - 1][1])]);
                return c;
            }
            c.push(coordinates[i]); along += length;
        }
        return c;
    }
    // the service calls this once per update; true means "reroute now"
    takeReroute() { var r = this.rerouteWanted; this.rerouteWanted = false; return r; }
    // Vela is asked only once the phone's maneuver has settled; a request made while
    // Android Auto is still recalculating would be answered for an obsolete turn.
    // Off the route, wait for the phone's recalculated maneuver (one that changed after the car
    // left the line); if the phone never changes, ask anyway after OFF_ROUTE_WAIT_MS.
    phoneSettled() {
        var now = this.wall();
        if (this.offSince && this.phoneSince < this.offSince && now - this.offSince < OFF_ROUTE_WAIT_MS) return false;
        return this.phoneSig !== null && now - this.phoneSince >= PHONE_SETTLE_MS;
    }
    onNewRoute() { this.offSince = 0; this.agree = this.disagree = 0; this.clipIndex = null; this.clipAlong = null; this.state = 'idle'; this.rerouteWanted = false; this.lastAt = 0; }
    reset(why) { this.onNewRoute(); this.state = why || 'idle'; }
    result() { return { state: this.state, clipIndex: this.clipIndex, agree: this.agree, disagree: this.disagree, detail: this.last }; }
}
module.exports = { RouteProgress, RouteMatch, phoneSide, routeSide, phoneMetres, project, alongTo };
