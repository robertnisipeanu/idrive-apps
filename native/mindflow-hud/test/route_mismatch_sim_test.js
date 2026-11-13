'use strict';
// Closed-loop synthetic drive: real Service -> MapFeed -> RouteMatch/RouteFull -> Runtime,
// a fake renderer, a simulated phone (Android Auto) that reroutes on its own and a
// simulated Vela (no heading knowledge, latency). The car deliberately ignores turns.
// Usage: node test/route_mismatch_sim_test.js [follow|divided|ignore|ignoreGap|longGap|zigzag] [--hz 1|5|10] [--noise none|typical|urban] [--strict] [--trace]   (SIM_LOCAL=1 also logs local-line failures; SIM_NO_BMW=1 drops the BMW position)
const path = require('path'), Module = require('module');
process.env.NODE_PATH = path.resolve(__dirname, '../vendor'); Module._initPaths();
let T = 100000; Date.now = () => T;
const E = require('events');
const { Service } = require('../service'), { MapFeed } = require('../map_feed'), { Runtime } = require('../runtime');
const { RouteMatch } = require('../route_match'), scene = require('../scene');

const O = [-9.14, 38.72], K = 111320 * Math.cos(O[1] * Math.PI / 180);
const geo = p => [O[0] + p[0] / K, O[1] + p[1] / 111320], loc = c => [(c[0] - O[0]) * K, (c[1] - O[1]) * 111320];
const B = 150, IMIN = -2, IMAX = 10, DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const roads = [];
for (let i = IMIN; i <= IMAX; i++) roads.push({ points: [geo([i * B, IMIN * B]), geo([i * B, IMAX * B])], name: 'Av ' + i, width: 2 });
for (let j = IMIN; j <= IMAX; j++) roads.push({ points: [geo([IMIN * B, j * B]), geo([IMAX * B, j * B])], name: 'Rua ' + j, width: 2 });
const roadName = (a, b) => Math.abs(a[0] - b[0]) < 1 ? 'Av ' + Math.round(a[0] / B) : 'Rua ' + Math.round(a[1] / B);
const len = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const DEST = [1200, 1050];

// grid router: Dijkstra over (node, incoming dir), no U-turns; pref breaks ties between L-shapes
function dijkstra(si, sj, sd, pref) {
    const key = (i, j, d) => i + ',' + j + ',' + d, dist = new Map(), prev = new Map(), open = [[0, si, sj, sd]];
    dist.set(key(si, sj, sd), 0);
    const ti = DEST[0] / B, tj = DEST[1] / B;
    while (open.length) {
        open.sort((a, b) => a[0] - b[0]); const [c, i, j, d] = open.shift();
        if (c > dist.get(key(i, j, d))) continue;
        if (i === ti && j === tj) { const out = []; let k = key(i, j, d); while (k) { const [a, b] = k.split(',').map(Number); out.unshift([a * B, b * B]); k = prev.get(k); } return { cost: c, nodes: out }; }
        for (let nd = 0; nd < 4; nd++) {
            if (nd === (d + 2) % 4) continue;
            const ni = i + DIRS[nd][0], nj = j + DIRS[nd][1]; if (ni < IMIN || ni > IMAX || nj < IMIN || nj > IMAX) continue;
            let w = B + (nd !== d ? 20 : 0);
            if (pref === 'nfirst' && nd % 2 === 1) w += 0.01 * (IMAX - j);
            if (pref === 'efirst' && nd % 2 === 0) w += 0.01 * (IMAX - i);
            const nk = key(ni, nj, nd), nc = c + w;
            if (!dist.has(nk) || nc < dist.get(nk)) { dist.set(nk, nc); prev.set(nk, key(i, j, d)); open.push([nc, ni, nj, nd]); }
        }
    }
    return null;
}
function nextNode(p, d) {
    const [dx, dy] = DIRS[d];
    if (dx) { const i = dx > 0 ? Math.floor(p[0] / B + 1e-3) + 1 : Math.ceil(p[0] / B - 1e-3) - 1; return [i, Math.round(p[1] / B)]; }
    const j = dy > 0 ? Math.floor(p[1] / B + 1e-3) + 1 : Math.ceil(p[1] / B - 1e-3) - 1; return [Math.round(p[0] / B), j];
}
// dirs = allowed starting directions (phone: car heading; Vela: both ways along the snapped street)
function routeFrom(p, dirs, pref) {
    let best = null;
    for (const d of dirs) {
        const [i, j] = nextNode(p, d); if (i < IMIN || i > IMAX || j < IMIN || j > IMAX) continue;
        const r = dijkstra(i, j, d, pref); if (!r) continue;
        const first = [i * B, j * B], cost = r.cost + len(p, first);
        if (!best || cost < best.cost) best = { cost, points: [p.slice()].concat(r.nodes) };
    }
    if (!best) return null;
    const pts = best.points, steps = []; let along = 0;
    for (let k = 1; k < pts.length; k++) {
        along += len(pts[k - 1], pts[k]);
        if (k < pts.length - 1) {
            const u = [pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]], v = [pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]], z = u[0] * v[1] - u[1] * v[0];
            if (Math.abs(z) > 1e-6) steps.push({ along, side: z > 0 ? 'left' : 'right', road: roadName(pts[k], pts[k + 1]), at: pts[k] });
        }
    }
    return { points: pts, steps, length: along };
}
// snap to the nearest street (a router snaps noisy origins too); both axes near a junction
function snapStreet(p) {
    const dv = Math.abs(p[0] - Math.round(p[0] / B) * B), dh = Math.abs(p[1] - Math.round(p[1] / B) * B);
    if (dv < 15 && dh < 15) return { p: [Math.round(p[0] / B) * B, Math.round(p[1] / B) * B], dirs: [0, 1, 2, 3] };
    return dv <= dh ? { p: [Math.round(p[0] / B) * B, p[1]], dirs: [0, 2] } : { p: [p[0], Math.round(p[1] / B) * B], dirs: [1, 3] };
}
function projectOn(points, p) {
    let best = null, along = 0;
    for (let k = 1; k < points.length; k++) {
        const a = points[k - 1], b = points[k], dx = b[0] - a[0], dy = b[1] - a[1], n = dx * dx + dy * dy, l = Math.sqrt(n);
        const t = n ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / n)) : 0, d = Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
        if (!best || d < best.d - 0.01) best = { d, along: along + t * l, k }; along += l;
    }
    return best;
}
function pointAt(points, s) {
    for (let k = 1; k < points.length; k++) { const l = len(points[k - 1], points[k]); if (s <= l) { const t = l ? s / l : 0; return { p: [points[k - 1][0] + t * (points[k][0] - points[k - 1][0]), points[k - 1][1] + t * (points[k][1] - points[k - 1][1])], d: Math.atan2(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]) }; } s -= l; }
    const n = points.length; return { p: points[n - 1].slice(), d: Math.atan2(points[n - 1][0] - points[n - 2][0], points[n - 1][1] - points[n - 2][1]), end: true };
}
// cyan line's next turn ahead of the car
function cyanTurn(coords, car) {
    const pts = coords.map(loc), pr = projectOn(pts, car); if (!pr) return null;
    // walk from the car's projection onto the line (not from the car itself: with GPS error the
    // car sits metres beside the line and car->next vertex would read as a sharp turn)
    let s = 0, prev = pointAt(pts, pr.along).p, h0 = null;
    for (let k = pr.k; k < pts.length; k++) {
        const l = len(prev, pts[k]); if (l < 0.5) { prev = pts[k]; continue; }
        const h = Math.atan2(pts[k][0] - prev[0], pts[k][1] - prev[1]);
        if (h0 !== null) { const dd = Math.atan2(Math.sin(h - h0), Math.cos(h - h0)); if (Math.abs(dd) > 0.6) return { off: pr.d, dist: s, side: dd < 0 ? 'left' : 'right' }; }
        h0 = h; s += l; prev = pts[k];
    }
    return { off: pr.d, end: s };
}

// seeded RNG so every run is reproducible
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// GPS error: slowly drifting bias (AR(1), sigma/tau), per-fix white jitter, and multipath jumps
const NOISE = {
    none: { sigma: 0, tau: 5, white: 0, jumpPerS: 0 },
    typical: { sigma: 4, tau: 5, white: 1, jumpPerS: 0 },
    // stress level (reported; fails only with --strict): 1 Hz cannot separate these jumps from motion
    urban: { stress: true, sigma: 8, tau: 8, white: 2, jumpPerS: 1 / 40, jump: [20, 35], jumpS: [1, 3] },
};
function gpsError(model, seed) {
    const r = rng(seed), g = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
    let bx = g() * model.sigma, by = g() * model.sigma, jump = null;
    return (dt, t) => {
        const a = Math.exp(-dt / model.tau), k = Math.sqrt(1 - a * a) * model.sigma;
        bx = bx * a + k * g(); by = by * a + k * g();
        if (!jump && model.jumpPerS && r() < model.jumpPerS * dt) { const m = model.jump[0] + r() * (model.jump[1] - model.jump[0]), d = r() * 2 * Math.PI; jump = { x: m * Math.sin(d), y: m * Math.cos(d), until: t + 1000 * (model.jumpS[0] + r() * (model.jumpS[1] - model.jumpS[0])) }; }
        if (jump && t >= jump.until) jump = null;
        return [bx + g() * model.white + (jump ? jump.x : 0), by + g() * model.white + (jump ? jump.y : 0), !!jump];
    };
}

const SCENARIOS = {
    // control: the driver follows the phone exactly
    follow: { drive: 'phone', vela: 1200, gap: 0, phoneDelay: 2000 },
    // follows the phone but drives 12 m right of the route's centre line (dual carriageway)
    divided: { drive: 'phone', vela: 1200, gap: 0, phoneDelay: 2000, lane: 12 },
    // driver ignores several turns; phone reroutes 2 s after leaving its route
    ignore: { drive: [[0, -100], [0, 300], [300, 300], [300, 600], [750, 600], [750, 450], [1050, 450], [1050, 1050], [1200, 1050]], vela: 1200, gap: 0, phoneDelay: 2000 },
    // Defensive (not observed in live tests): AA blanks the maneuver for 4 s while recalculating, and Vela is slow
    ignoreGap: { drive: [[0, -100], [0, 300], [300, 300], [300, 600], [750, 600], [750, 450], [1050, 450], [1050, 1050], [1200, 1050]], vela: 3000, gap: 4000, phoneDelay: 2000 },
    // Defensive (not observed in live tests): AA shows nothing for 8 s; map must stay, no line is invented
    longGap: { drive: [[0, -100], [0, 300], [300, 300], [300, 600], [750, 600], [750, 450], [1050, 450], [1050, 1050], [1200, 1050]], vela: 1500, gap: 8000, phoneDelay: 2000 },
    // quick successive misses: turns one block after another
    zigzag: { drive: [[0, -100], [0, 150], [150, 150], [150, 300], [300, 300], [300, 450], [450, 450], [450, 600], [600, 600], [600, 1050], [1200, 1050]], vela: 1500, gap: 1500, phoneDelay: 1500 },
};

async function run(name, cfg, trace, gpsHz, noiseName) {
    const gpsEvery = Math.round(10 / gpsHz), err = gpsError(NOISE[noiseName], 12345 + gpsHz);
    T = 100000;
    const log = [], ev = (m) => log.push(((T - 100000) / 1000).toFixed(1).padStart(6) + 's  ' + m);
    // simulated Vela: lon/lat only, routes both ways along the snapped street, two alternatives
    const pending = [];
    const vela = { compute(from, to) {
        const sn = snapStreet(loc([from.longitude, from.latitude])), p = sn.p, dirs = sn.dirs;
        const cands = ['efirst', 'nfirst'].map((pref, idx) => { const r = routeFrom(p, dirs, pref); return r && {
            coordinates: r.points.map(geo), steps: r.steps.map(s => ({ along: s.along, road: s.road, maneuver: { type: 'turn', side: s.side } })),
            duration_s: r.length / 12 + idx * 5, distance_m: r.length, alternative_index: idx }; }).filter(Boolean);
        stats.velaCalls++; ev('vela request from (' + p.map(Math.round) + ')');
        return new Promise(res => pending.push({ due: T + cfg.vela, res: () => res({ candidates: cands }) }));
    } };
    const feed = new MapFeed({ clock: () => T * 1e6, wall: () => T });
    feed.mapboxToken = () => 'pk.fixturetoken123';
    const svc = new Service({ file: path.join(__dirname, 'absent-settings'), vela, mapFeed: feed, runtime: { applySettings() {} }, destinationCapture: { state: {}, start: () => true } });
    feed.full = svc.full; feed.match = svc.match = new RouteMatch({ wall: () => T }); feed.maneuver = () => svc.currentGuidance();
    svc.full.wall = () => T;
    const fr = svc.full.fetchRoute; svc.full.fetchRoute = (...a) => fr(...a).then(r => { ev('vela route adopted (' + a[4] + ')'); return r; }, e => { stats.rejected++; ev('vela route REJECTED: ' + e.message); throw e; });
    class CR extends E { constructor() { super(); this.ready = true; this.id = 0; } mesh() { return ++this.id; } asset() { return ++this.id; } pixels() { return true; } part() { return true; } bind() {} uniform() {} geometry(l, id) { stats.uploads++; tickUploads.add(l + ':' + id); return true; } set() {} drop() {} close() {} connect() {} }
    const rt = new Runtime({ client: new CR(), rebaseM: 800, clock: () => T, feed: 'map://feed', fetch: u => feed.fetch(u), guidance: () => svc.currentGuidance(), settings: { enabled: true },
        roadSource: { near: () => { stats.tileFetches++; return new Promise(res => pending.push({ due: T + 2500, res: () => res(roads) })); } }, cameraFeed: { ensure() {}, snapshot: () => ({ status: 'unavailable' }) } });
    const tickUploads = new Set();
    const stats = { mismatchTicks: 0, mismatchEntries: 0, lastState: null, noCyanRun: 0, noCyanWithPhone: 0, rebases: 0, rebaseTorn: 0, earlyHides: 0, phoneReroutes: 0, rejected: 0, tileFetches: 0, noRoads: 0, velaCalls: 0, uploads: 0, hides: 0, clears: 0, ticks: 0, hidden: 0, cls: {}, worst: {}, run: null, gens: 0, polls: {} };
    const hide = rt.hide.bind(rt), clear = rt.clear.bind(rt);
    rt.hide = () => { if (rt.visible) { stats.hides++; if (!carState().end && carS < carLen - 60) stats.earlyHides++; ev('MAP HIDDEN (trip=' + rt.trip + ', feed route=' + (rt.route ? (rt.route.mapOnly ? 'mapOnly' : rt.route.coordinates.length + 'pts') : 'none') + ')'); } hide(); };
    rt.clear = () => { stats.clears++; clear(); };
    let drawn = null; const build = scene.build;
    const lr = require('../route_local'), lb = lr.build; if (process.env.SIM_LOCAL) lr.build = (...a) => { const r = lb(...a); if (!r.coordinates) ev('local line failed: ' + r.reason + ' (pose heading ' + Math.round(a[2][2] * 180 / Math.PI) + ')'); return r; };
    scene.build = (r, route, o, pose, s) => { drawn = { coords: route.mapOnly ? null : route.coordinates, local: !!route.localFallback || route.coordinates !== rt.route.coordinates }; return build(r, route, o, pose, s); };

    // car
    let carPath = cfg.drive === 'phone' ? null : cfg.drive.map(p => p.slice()), carS = 0;
    const speed = 12;
    // phone
    let phoneRoute = routeFrom([0, -100], [0], 'nfirst'), offSince = null, blankUntil = 0;
    if (!carPath) carPath = phoneRoute.points.map(p => p.slice());
    const carState = () => pointAt(carPath, carS);
    let carLen = 0; for (let k = 1; k < carPath.length; k++) carLen += len(carPath[k - 1], carPath[k]);
    function phoneManeuver(car) {
        if (T < blankUntil) return null;
        const pr = projectOn(phoneRoute.points, car.p);
        const st = phoneRoute.steps.find(s => s.along > pr.along + 5);
        if (!st) return { kind: 'destinationManeuver', distance: String(Math.max(0, Math.round((phoneRoute.length - pr.along) / 10) * 10)), unit: 'METER' };
        return { kind: 'intersection', direction: st.side.toUpperCase(), distance: String(Math.max(0, Math.round((st.along - pr.along) / 10) * 10)), unit: 'METER', text: st.road, _at: st.at };
    }
    svc.full.setDestination(geo(DEST));
    // BMW CurrentLocation model (an assumption): on the
    // road centre line, BMW_LAG_S behind the car, with 2 m of its own noise; no multipath jumps.
    const bmwRand = rng(777 + gpsHz), bmwHistory = [];
    const bmwCurrent = (car, heading) => {
        bmwHistory.push([T, car.p.slice()]); while (bmwHistory.length > 1 && T - bmwHistory[1][0] >= 400) bmwHistory.shift();
        const p = bmwHistory[0][1], q = geo([p[0] + (bmwRand() - .5) * 4, p[1] + (bmwRand() - .5) * 4]);
        return process.env.SIM_NO_BMW ? undefined : { coordinatesValid: true, latitude: q[1], longitude: q[0], heading };
    };
    let laneVec = null, phoneShown = null, lastCls = null, clsSince = T, prevGen = null;
    for (let step = 0; step < 4000; step++) {
        T += 100;
        carS += speed * 0.1;
        const car = carState(), heading = ((car.d * 180 / Math.PI) + 360) % 360;
        if (car.end) break;
        for (let i = pending.length - 1; i >= 0; i--) if (pending[i].due <= T) { pending[i].res(); pending.splice(i, 1); }
        if (step % gpsEvery === 0) {
            // the lane offset follows the car round a corner over ~1.5 s (it does not swing instantly)
            const target = [Math.cos(car.d), -Math.sin(car.d)], kk = 1 - Math.exp(-(gpsEvery / 10) / 1.5);
            laneVec = laneVec ? [laneVec[0] + (target[0] - laneVec[0]) * kk, laneVec[1] + (target[1] - laneVec[1]) * kk] : target;
            const right = laneVec, lane = cfg.lane || 0, e = err(gpsEvery / 10, T);
            const c = geo([car.p[0] + right[0] * lane + e[0], car.p[1] + right[1] * lane + e[1]]);
            feed.position({ raw: { fixType: 'FIX_3D', position: { coordinatesValid: true, longitude: c[0], latitude: c[1] } }, current: bmwCurrent(car, heading) });
        }
        if (step % 10 === 0) {
            // phone off-route detection and reroute (it knows the heading)
            const pr = projectOn(phoneRoute.points, car.p);
            if (pr.d > 20) { if (offSince === null) offSince = T; if (T - offSince >= cfg.phoneDelay) {
                const d = Math.round(car.d / (Math.PI / 2)); phoneRoute = routeFrom(car.p, [((d % 4) + 4) % 4], 'nfirst'); offSince = null;
                blankUntil = T + cfg.gap; stats.phoneReroutes++; ev('phone rerouted' + (cfg.gap ? ' (maneuver blank ' + cfg.gap / 1000 + ' s)' : '')); } }
            else offSince = null;
            phoneShown = phoneManeuver(car);
            svc.setGuidance(phoneShown ? Object.assign({}, phoneShown, { _at: undefined }) : null);
        }
        if (step % 5 === 0) {
            await rt.poll();
            const gen = rt.trip; if (gen !== prevGen) { if (prevGen !== null) { stats.gens++; ev('feed generation ' + prevGen + ' -> ' + gen); } prevGen = gen; }
            const k = rt.route ? (rt.route.mapOnly ? 'mapOnly' : rt.route.localFallback ? 'clipped(mismatch)' : 'route') : 'none'; stats.polls[k] = (stats.polls[k] || 0) + 1;
        }
        drawn = null; tickUploads.clear(); const rb = rt.rebases || 0, visibleBefore = rt.visible;
        rt.tick(); await new Promise(r => setImmediate(r));
        if (drawn) rt.lastDrawn = drawn;   // record every build, not only those on sampling ticks
        if (svc.match.state === 'mismatch') { stats.mismatchTicks++; if (stats.lastState !== 'mismatch') { stats.mismatchEntries++; ev('line clipped (mismatch) ' + JSON.stringify(svc.match.last) + ' carOffLine=' + (svc.full.route ? Math.round(projectOn(svc.full.route.coordinates.map(loc), loc([feed.fix.lon, feed.fix.lat])).d) : '-') + 'm hdg=' + Math.round(feed.heading) + ' trueHdg=' + Math.round(((carState().d * 180 / Math.PI) + 360) % 360) + ' dr=' + !!feed.fix.deadReckoned + ' jumps=' + (feed.jumps || 0)); } }
        stats.lastState = svc.match.state;
        if ((rt.rebases || 0) > rb) {
            // a re-centre must replace every drawn part plus the labels in that same tick
            stats.rebases++; const need = (rt.lastFrame ? rt.lastFrame.parts.length : 0) + 1;
            if (tickUploads.size < need || (visibleBefore && !rt.visible)) { stats.rebaseTorn++; ev('REBASE TORN: ' + tickUploads.size + '/' + need + ' parts replaced'); }
            else ev('re-centred map frame (' + need + ' parts replaced in one tick)');
        }
        stats.ticks++; if (!rt.visible) stats.hidden++; else if (!rt.roads.length) { stats.noRoads++; if (!stats.blankAt) stats.blankAt = T; } if (rt.roads.length && stats.blankAt) { ev('road map blank for ' + ((T - stats.blankAt) / 1000).toFixed(1) + ' s'); stats.blankAt = 0; }
        if (step % 5 === 0) {
            // classify what the cyan line says versus what the phone currently says
            const ph = phoneManeuver(car); let cls;
            const dl = rt.lastDrawn;
            if (!rt.visible) cls = 'MAP_HIDDEN';
            else if (!dl || !dl.coords) cls = 'no_cyan';
            else {
                const ct = cyanTurn(dl.coords, car.p);
                if (!ct || ct.off > 30) cls = 'cyan_off_car_road';
                else if (!ph || ph.kind !== 'intersection') cls = ph ? 'agree' : 'no_phone';
                else {
                    const pd = Number(ph.distance), ps = ph.direction.toLowerCase();
                    if (ct.dist !== undefined && Math.abs(ct.dist - pd) <= 45 && ct.side === ps) cls = 'agree';
                    else if (ct.end !== undefined && ct.end < pd + 20) cls = 'short';   // ends at/before the phone's turn: consistent, just not complete
                    else cls = 'CONFLICT';
                }
            }
            stats.cls[cls] = (stats.cls[cls] || 0) + 1;
            if (!(cls === 'no_cyan' && ph && svc.currentGuidance())) stats.noCyanRun = 0;
            // one 0.5 s sample of latency after the turn arrives is allowed (a 250 ms line probe)
            else if (T - 100000 > 5000 && ++stats.noCyanRun > 1) { stats.noCyanWithPhone++; ev('NO CYAN while the phone shows ' + ph.kind + ' ' + (ph.direction || '') + ' ' + ph.distance + 'm'); }
            if (cls !== lastCls) {
                if (lastCls) stats.worst[lastCls] = Math.max(stats.worst[lastCls] || 0, T - clsSince);
                if (trace) ev('cyan: ' + cls + (rt.lastDrawn ? (rt.lastDrawn.local ? ' [local]' : ' [vela]') + ' ' + JSON.stringify(rt.lastDrawn.coords ? cyanTurn(rt.lastDrawn.coords, car.p) : null, (k, v) => typeof v === 'number' ? Math.round(v) : v) : '') + (ph && ph.kind === 'intersection' ? '   phone ' + ph.direction + ' ' + ph.distance + 'm' : ph ? '' : '   phone blank') + '   match=' + svc.match.state);
                lastCls = cls; clsSince = T;
            }
        }
    }
    if (lastCls) stats.worst[lastCls] = Math.max(stats.worst[lastCls] || 0, T - clsSince);
    scene.build = build; rt.stop();
    const total = Object.values(stats.cls).reduce((a, b) => a + b, 0), pct = k => ((stats.cls[k] || 0) * 100 / total).toFixed(0) + '%';
    console.log('\n=== ' + name + ' @ ' + gpsHz + ' Hz GPS, ' + noiseName + ' error === clipped ' + stats.mismatchEntries + 'x / ' + (stats.mismatchTicks / 10).toFixed(1) + ' s, drive ' + ((T - 100000) / 1000).toFixed(0) + ' s, vela calls ' + stats.velaCalls + ' (rejected ' + stats.rejected + ', phone reroutes ' + stats.phoneReroutes + '), map hidden ' + stats.hides + 'x (before arrival ' + stats.earlyHides + '), re-centres ' + stats.rebases + ' (torn ' + stats.rebaseTorn + '), renderer clears ' + stats.clears + ', generation flips ' + stats.gens + ', hidden ' + (stats.hidden * 100 / stats.ticks).toFixed(1) + '% of frames, roads blank ' + (stats.noRoads / 10).toFixed(1) + ' s total, tile fetches ' + stats.tileFetches);
    console.log('  feed polls: ' + JSON.stringify(stats.polls));
    console.log('  cyan vs phone: ' + Object.keys(stats.cls).sort().map(k => k + ' ' + pct(k) + ' (longest ' + ((stats.worst[k] || 0) / 1000).toFixed(1) + ' s)').join(', '));
    if (trace) log.forEach(l => console.log('   ' + l));
    // Pass/fail: the map must never be wiped by guidance/route changes, the road map is only
    // blank while the first tiles load, and the cyan line never contradicts the phone or sits
    // off the car's road for longer than one renderer rebuild plus one GPS fix (~2 s).
    const fail = [];
    if (stats.clears) fail.push('renderer cleared ' + stats.clears + 'x');
    if (stats.noCyanWithPhone) fail.push('no cyan line for ' + (stats.noCyanWithPhone / 2) + ' s while the phone showed a turn');
    if (stats.earlyHides) fail.push('map hidden ' + stats.earlyHides + 'x before arrival');
    if (stats.rebaseTorn) fail.push(stats.rebaseTorn + ' re-centres not replaced in one tick');
    if (!stats.rebases) fail.push('drive never re-centred the map frame (check not exercised)');
    if (stats.noRoads > 30) fail.push('road map blank ' + (stats.noRoads / 10).toFixed(1) + ' s');
    for (const k of ['CONFLICT', 'cyan_off_car_road']) if ((stats.worst[k] || 0) > 2000) fail.push(k + ' for ' + (stats.worst[k] / 1000).toFixed(1) + ' s');
    if (stats.velaCalls > 1 + stats.phoneReroutes + 2) fail.push(stats.velaCalls + ' Vela calls for ' + stats.phoneReroutes + ' phone reroutes');
    // driver follows the phone: GPS error must not clip the line or trigger a reroute
    if (cfg.drive === 'phone' && stats.velaCalls !== 1) fail.push('following the phone must not reroute (' + stats.velaCalls + ' Vela calls)');
    if (cfg.drive === 'phone' && stats.mismatchTicks > 0) fail.push('line falsely clipped ' + stats.mismatchEntries + 'x for ' + (stats.mismatchTicks / 10).toFixed(1) + ' s while following the phone');
    stats.fail = fail;
    const stress = NOISE[noiseName].stress && !process.argv.includes('--strict');
    console.log(fail.length ? (stress ? '  STRESS (not failing) ' : '  FAIL ') + name + ': ' + fail.join('; ') : '  PASS ' + name);
    if (stress) stats.fail = [];
    return stats;
}
(async () => {
    const pick = process.argv[2] && !process.argv[2].startsWith('--') ? [process.argv[2]] : Object.keys(SCENARIOS), trace = process.argv.includes('--trace');
    const rates = process.argv.includes('--hz') ? [Number(process.argv[process.argv.indexOf('--hz') + 1])] : [1, 5, 10];
    let failed = 0;
    const noises = process.argv.includes('--noise') ? [process.argv[process.argv.indexOf('--noise') + 1]] : Object.keys(NOISE);
    for (const n of pick) for (const nz of noises) for (const hz of rates) if ((await run(n, SCENARIOS[n], trace, hz, nz)).fail.length) failed++;
    if (failed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
