// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test for the frozen-stream check (freeze_watch.h), with the car's
 * rates: a frozen stream at 15 frames a second, all the same picture, is
 * frozen after 10 s and not before; a static map at one frame in 11 s is
 * never frozen; a stream that stops is not frozen; a changed frame ends it;
 * a change is seen in one sample past the threshold, not in noise under it
 * or between samples. */
#include <cstdio>
#include <vector>

#include "../src/freeze_watch.h"

using namespace woc;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

int main()
{
    FreezeConfig cfg;   /* 10 s, 3 frames a second */

    FreezeWatch f(cfg);
    f.frame(0, true);
    int64_t t = 0;
    for (; t < 9900; t += 66)
        f.frame(t + 66, false);
    ok("15 fps unchanged for 9.9 s: not yet frozen", !f.frozen(9900));
    for (; t < 10500; t += 66)
        f.frame(t + 66, false);
    ok("and frozen past 10 s", f.frozen(10600));
    f.frame(10700, true);
    ok("a changed frame ends it", !f.frozen(10700));

    FreezeWatch s(cfg);
    s.frame(0, true);
    for (int64_t u = 11000; u <= 120000; u += 11000)
        s.frame(u, false);
    ok("a static map, one frame in 11 s for 2 minutes: never frozen", !s.frozen(120000) && !s.frozen(125000));

    FreezeWatch g(cfg);
    g.frame(0, true);
    for (int64_t u = 66; u <= 12000; u += 66)
        g.frame(u, false);
    ok("frozen while the frames come", g.frozen(12000));
    ok("not frozen 10 s after they stopped", !g.frozen(22100));

    FreezeWatch off(FreezeConfig{0, 3});
    off.frame(0, true);
    for (int64_t u = 66; u <= 30000; u += 66)
        off.frame(u, false);
    ok("ms 0: never frozen", !off.frozen(30000));

    const uint32_t w = 64, h = 32;
    std::vector<uint8_t> y(w * h, 100);
    ChangeSampler c(w, h);
    ok("the first frame is a change", c.changed(y.data()));
    ok("the same picture is not", !c.changed(y.data()));
    for (auto &p : y)
        p = (uint8_t)(p + 8);
    ok("noise up to the threshold everywhere is not", !c.changed(y.data()));
    y[4 * w + 8] += 9;
    ok("one sample past it is", c.changed(y.data()));
    y[5 * w + 9] += 50;
    ok("a change between samples is not seen", !c.changed(y.data()));

    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
