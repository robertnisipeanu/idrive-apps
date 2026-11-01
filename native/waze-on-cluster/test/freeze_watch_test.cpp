// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test for the frozen-stream check (freeze_watch.h), with the car's
 * rates: a frozen stream at 15 frames a second, all the same blank picture
 * after a map, is frozen after 10 s and not before; a stream blank from its
 * start is frozen only after 30 s of it with frames still coming, so the
 * car's start (93 blank frames in 2 s, then a pause) never is, and a new
 * stream (live again) starts without a picture; a static
 * map is never frozen, at one frame in 11 s or at 15 a second; a stream that
 * stops is not frozen; a changed or non-blank frame ends it; a change is seen in one sample past
 * the threshold, not in noise under it or between samples; a picture is
 * blank with up to one sample in a thousand off its band, not with a road
 * across it. The minute's tally: nothing before a minute from its first
 * frame, then its frames, changes and the last blank verdict, and none
 * while no frames come. */
#include <algorithm>
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
    f.live(true);
    f.frame(0, true, false);
    int64_t t = 0;
    for (; t < 9900; t += 66)
        f.frame(t + 66, false, true);
    ok("15 fps blank and unchanged for 9.9 s: not yet frozen", !f.frozen(9900));
    for (; t < 10500; t += 66)
        f.frame(t + 66, false, true);
    ok("and frozen past 10 s", f.frozen(10600));
    f.frame(10700, true, true);
    ok("a changed frame ends it", !f.frozen(10700));

    /* The car: a stream's first 93 frames the same blank picture in about
     * 2 s, then a pause. */
    FreezeWatch fc(cfg);
    fc.live(true);
    fc.frame(0, true, true);
    bool never = true;
    for (int k = 1; k < 93; k++)
        fc.frame(k * 22, false, true);
    for (int64_t u = 2000; u <= 62000; u += 100)
        never = never && !fc.frozen(u);
    ok("the car's start: 93 blank frames in 2 s, then nothing for 60 s: never frozen", never);

    FreezeWatch st(cfg);
    st.live(true);
    st.frame(0, true, true);
    for (int64_t u = 66; u <= 29900; u += 66)
        st.frame(u, false, true);
    ok("blank from the stream's start at 15 fps: not frozen before 30 s", !st.frozen(29900));
    for (int64_t u = 29966; u <= 30100; u += 66)
        st.frame(u, false, true);
    ok("and frozen at 30 s", st.frozen(30100));
    st.frame(60066, true, false);
    for (int64_t u = 60132; u <= 71000; u += 66)
        st.frame(u, false, true);
    ok("a picture, then 10 s of the same blank one: frozen", st.frozen(71000));
    st.live(false);
    ok("the stream ending ends it", !st.frozen(71000));
    st.live(true);
    st.frame(71066, true, true);
    for (int64_t u = 71132; u <= 90000; u += 66)
        st.frame(u, false, true);
    ok("a new stream blank from its start: not frozen, whatever the last showed", !st.frozen(90000));
    st.frame(90066, true, false);
    for (int64_t u = 90132; u <= 101000; u += 66)
        st.frame(u, false, true);
    ok("until it shows a picture and goes blank for 10 s", st.frozen(101000));

    FreezeWatch s(cfg);
    s.frame(0, true, false);
    for (int64_t u = 11000; u <= 120000; u += 11000)
        s.frame(u, false, false);
    ok("a static map, one frame in 11 s for 2 minutes: never frozen", !s.frozen(120000) && !s.frozen(125000));

    FreezeWatch m(cfg);
    m.frame(0, true, false);
    for (int64_t u = 66; u <= 120000; u += 66)
        m.frame(u, false, false);
    ok("a static map at 15 fps for 2 minutes: never frozen", !m.frozen(120000));

    FreezeWatch n(cfg);
    n.frame(0, true, false);
    for (int64_t u = 66; u <= 12000; u += 66)
        n.frame(u, false, true);
    ok("frozen", n.frozen(12000));
    n.frame(12066, false, false);
    ok("a non-blank frame ends it", !n.frozen(12066));
    for (int64_t u = 12132; u <= 21000; u += 66)
        n.frame(u, false, true);
    ok("and blank again, not frozen before 10 s after it", !n.frozen(21000));
    for (int64_t u = 21066; u <= 22200; u += 66)
        n.frame(u, false, true);
    ok("and frozen past 10 s after it", n.frozen(22200));

    FreezeWatch g(cfg);
    g.frame(0, true, false);
    for (int64_t u = 66; u <= 12000; u += 66)
        g.frame(u, false, true);
    ok("frozen while the frames come", g.frozen(12000));
    ok("not frozen 10 s after they stopped", !g.frozen(22100));

    FreezeWatch off(FreezeConfig{0, 3});
    off.frame(0, true, false);
    for (int64_t u = 66; u <= 30000; u += 66)
        off.frame(u, false, true);
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

    /* the car's 1088x480 plane: 272 x 120 samples */
    const uint32_t W = 1088, H = 480;
    std::vector<uint8_t> p(W * H, 16);
    ChangeSampler b(W, H);
    b.changed(p.data());
    ok("a black picture is blank", b.blank());
    for (uint32_t r = 0; r < H; r++)
        for (uint32_t x = 0; x < W; x++)
            p[r * W + x] = (uint8_t)(16 + (r * 7 + x * 3) % 17);
    b.changed(p.data());
    ok("noise within the band is blank", b.blank());
    std::fill(p.begin(), p.end(), 16);
    for (uint32_t x = 0; x < 32 * 4; x += 4)
        p[100 * W + x] = 200;
    b.changed(p.data());
    ok("32 samples off it (under one in a thousand) are blank", b.blank());
    for (uint32_t x = 0; x < W; x++)
        p[200 * W + x] = 120;
    b.changed(p.data());
    ok("a road across it is not", !b.blank());

    FrameTally tally;
    FrameTally::Minute mt;
    ok("tally: nothing before a frame", !tally.take(100000, &mt));
    tally.frame(1000, true, false);
    for (int64_t k = 1; k < 900; k++)
        tally.frame(1000 + k * 66, k % 30 == 0, k == 899);
    ok("tally: not before a minute from the first frame", !tally.take(60999, &mt));
    ok("tally: a minute of 15 fps", tally.take(61000, &mt) && mt.frames == 900 && mt.changed == 30 && mt.blank);
    ok("tally: taken once", !tally.take(61500, &mt));
    ok("tally: none while no frames come", !tally.take(200000, &mt));
    tally.frame(300000, false, false);
    ok("tally: the next minute from its first frame", !tally.take(359999, &mt) && tally.take(360000, &mt) &&
                                                          mt.frames == 1 && mt.changed == 0 && !mt.blank);

    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
