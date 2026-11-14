// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
#include "map_rect.h"

#include <stdio.h>

using namespace woc;

static int failures = 0;

static void expect(bool ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

int main()
{
    MapRect r;
    const char *e = parse_map_rect("", &r);
    expect(!e && !r.set(), "empty is the map area");
    e = parse_map_rect("0,0,1088,480", &r);
    expect(!e && r.set() && r.w == 1088 && r.h == 480, "the whole slot");
    expect(r.fits(1088, 480) && !r.fits(1087, 480), "fits its target only");
    e = parse_map_rect("40,20,900,338", &r);
    expect(!e && r.x == 40 && r.y == 20 && r.fits(1088, 480), "a smaller rect");
    e = parse_map_rect("200,0,900,480", &r);
    expect(!e && !r.fits(1088, 480), "parsed, but outside the slot");
    e = parse_map_rect("5000,0,900,480", &r);
    expect(!e && !r.fits(1920, 720), "an origin past any target parses and never fits");
    e = parse_map_rect("1,2,3", &r);
    expect(e && !r.set(), "three numbers");
    expect(parse_map_rect("0,0,1088,480x", &r) != nullptr, "trailing text");
    expect(parse_map_rect("0,0,8,8", &r) != nullptr, "too small");
    expect(parse_map_rect("0,0,5000,480", &r) != nullptr, "too large");

    e = parse_map_rect("0,0,8,8", &r);
    expect(e && !r.set(), "a bad map_rect is the map area, with a reason");

    /* host_crop: the part of the frame a host's src shows */
    MapRect c;
    const MapRect slot{0, 0, 1088, 480};
    expect(host_crop(slot, 1088, 480, MapRect{264, 40, 560, 400}, &c) && c.x == 264 && c.y == 40 && c.w == 560 &&
               c.h == 400,
           "host: the frame filling its target, a part of it 1:1");
    expect(host_crop(slot, 1088, 480, MapRect{1000, 400, 400, 400}, &c) && c.x == 1000 && c.y == 400 && c.w == 88 &&
               c.h == 80,
           "host: cut at the map's edge");
    expect(host_crop(slot, 1088, 480, MapRect{263, 41, 561, 399}, &c) && c.x == 262 && c.y == 40 && c.w == 562 &&
               c.h == 400,
           "host: grown to even edges");
    expect(host_crop(MapRect{416, 120, 1088, 480}, 1088, 480, MapRect{0, 0, 1920, 720}, &c) && c.x == 0 && c.y == 0 &&
               c.w == 1088 && c.h == 480,
           "host: the whole panel holds the centred map whole");
    expect(host_crop(MapRect{0, 0, 544, 240}, 1088, 480, MapRect{100, 50, 100, 50}, &c) && c.x == 200 && c.y == 100 &&
               c.w == 200 && c.h == 100,
           "host: a map drawn at half size, the frame's part twice as large");
    expect(!host_crop(slot, 1088, 480, MapRect{1088, 0, 100, 100}, &c) && !host_crop(MapRect{}, 1088, 480, slot, &c),
           "host: missing the map");

    if (failures)
        return 1;
    printf("map_rect_test: ok\n");
    return 0;
}
