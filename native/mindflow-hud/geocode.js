// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Address string -> [lon, lat] via Mapbox Geocoding v6 (forward), biased to the
// car's current position. Used to turn a destination address into the coordinate
// route_full.js routes to. Node 8 (no https.get(url, options, callback)).
const https = require('https'), url = require('url');

function geocode(token, address, near, timeoutMs) {
    return new Promise(function (resolve, reject) {
        if (typeof token !== 'string' || !token) { reject(Error('no Mapbox token')); return; }
        if (typeof address !== 'string' || !address.trim() || address.length > 256) { reject(Error('bad address')); return; }
        var q = '/search/geocode/v6/forward?q=' + encodeURIComponent(address.trim()) + '&limit=1&access_token=' + encodeURIComponent(token);
        if (near && isFinite(near[0]) && isFinite(near[1])) q += '&proximity=' + near[0].toFixed(5) + ',' + near[1].toFixed(5);
        var opts = url.parse('https://api.mapbox.com' + q);
        var req = https.get(opts, function (res) {
            if (res.statusCode !== 200) { res.resume(); reject(Error('Geocode HTTP ' + res.statusCode)); return; }
            var size = 0, parts = [];
            res.on('data', function (p) { size += p.length; if (size > 1024 * 1024) { req.destroy(Error('geocode response too large')); return; } parts.push(p); });
            res.on('error', function () { reject(Error('geocode interrupted')); });
            res.on('end', function () {
                try {
                    var j = JSON.parse(Buffer.concat(parts).toString('utf8'));
                    var f = j && j.features && j.features[0];
                    var c = f && f.geometry && f.geometry.coordinates;
                    if (!Array.isArray(c) || !isFinite(c[0]) || Math.abs(c[0]) > 180 || !isFinite(c[1]) || Math.abs(c[1]) > 85) { reject(Error('address not found')); return; }
                    var name = f.properties && (f.properties.full_address || f.properties.name) || address;
                    resolve({ coord: [c[0], c[1]], name: String(name).slice(0, 120) });
                } catch (e) { reject(Error('invalid geocode response')); }
            });
        });
        req.setTimeout(timeoutMs || 10000, function () { req.destroy(Error('geocode timed out')); });
        req.on('error', function () { reject(Error('geocode connection failed')); });
    });
}
module.exports = { geocode };
