// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* One interface of the unit's /etc/oap/someip/someip-interfaces.json in the
 * compact schema someip.node's buildProxy takes, the form of
 * oap-mainapp/src-gen (which has no ProjectedModeGuiding). Checked on a host
 * against the unit's 71 src-gen files: the same types, enum widths, union
 * members and array bounds for every method, field and event they hold.
 * Nothing here holds BMW data: it is read on the unit at run time.
 *
 *   require('./pmg_schema.js')(interfacesJson, 'de.bmw....Name') -> schema */
'use strict';
var fs = require('fs');

function convert(all, ifName) {
    var dt = all.datatypes;
    function members(def) {
        var out = def.extends ? members(dt[def.extends]) : [];
        (def.members || []).forEach(function (m) { out.push(named(m)); });
        return out;
    }
    function named(m) {
        var s = ref(m);
        var o = { n: m.name };
        Object.keys(s).forEach(function (k) { o[k] = s[k]; });
        return o;
    }
    // a member, input or field: dataRef plus its own deployment
    function ref(m) {
        var s = type(m.dataRef);
        if (m.stringEncoding && /16/.test(m.stringEncoding)) s = Object.assign({}, s, { t: 'Utf16D' });
        if (m.stringEncoding === 'utf16be') s = Object.assign({}, s, { bo: true });
        if (m.defaultValue !== undefined) s = Object.assign({}, s, { d: m.defaultValue });
        if (m.bitWidth !== undefined) s = Object.assign({}, s, { bw: m.bitWidth });
        if (m.dimension) {
            var a = { t: 'ArrayD', e: s };
            if (m.arrayMinLength !== undefined) a.nl = m.arrayMinLength;
            if (m.arrayMaxLength !== undefined) a.xl = m.arrayMaxLength;
            return a;
        }
        return s;
    }
    function type(name) {
        var def = dt[name];
        if (!def) return { t: name };   // a primitive: UInt8, Utf8D, Double...
        var s;
        switch (def.type) {
        case 'struct': s = { t: 'Struct', e: members(def) }; break;
        case 'union': s = { t: 'Union', e: def.members.map(named) }; break;
        case 'enum':
            s = { t: 'Enum', e: def.items };
            if (def.enumWidth !== undefined && def.enumWidth !== 4) s.w = def.enumWidth;
            break;
        case 'map': s = { t: 'Map', k: type(def.keyDataRef), v: type(def.valueDataRef) }; break;
        case 'array': s = ref(Object.assign({}, def, { dataRef: def.dataRef, dimension: 1 })); break;
        case 'typedef': s = ref(def); break;
        default: throw new Error('type ' + def.type + ' of ' + name);
        }
        if (def.defaultValue !== undefined) s.d = def.defaultValue;
        if (def.bitWidth !== undefined) s.bw = def.bitWidth;
        return s;
    }
    function args(list) {
        return list && list.length ? { t: 'Struct', e: list.map(named) } : {};
    }
    var i = all.interfaces[ifName];
    var out = { name: i.name, serviceId: i.serviceId, version: i.version,
        instances: all.instanceIDs[ifName], methods: {}, fields: {}, events: {}, eventGroups: { fields: {}, events: {} } };
    Object.keys(i.methods || {}).forEach(function (n) {
        var m = i.methods[n];
        out.methods[n] = { id: m.methodId, schema: args(m.inputs), retSchema: args(m.outputs) };
        if (m.fireAndForget) out.methods[n].fireAndForget = true;
        if (m.reliable) out.methods[n].reliable = true;
    });
    Object.keys(i.fields || {}).forEach(function (n) {
        var f = i.fields[n], o = { schema: ref(f) };
        if (f.getter) o.getter = { id: f.getter.id };
        if (f.setter) o.setter = { id: f.setter.id };
        if (f.notifier) {
            o.event = { id: f.notifier.id, groups: f.notifier.eventgroups };
            out.eventGroups.fields[f.notifier.id] = f.notifier.eventgroups;
        }
        out.fields[n] = o;
    });
    Object.keys(i.events || {}).forEach(function (n) {
        var e = i.events[n];
        out.events[n] = { id: e.eventId, groups: e.eventgroups, schema: args(e.outputs) };
        if (e.selective) out.events[n].selective = true;
        out.eventGroups.events[e.eventId] = e.eventgroups;
    });
    return out;
}

module.exports = convert;

if (require.main === module) {
    var all = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    process.stdout.write(JSON.stringify(convert(all, process.argv[3])));
}
