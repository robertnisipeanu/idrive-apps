// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test for the keyframe wait (keyframe_wait.h): it grows while the
 * stream arrives with nothing decoded and no keyframe, and is 0 for a normal
 * stream start, once frames decode, when the stream stops, and from a
 * keyframe that decodes nothing until a frame decodes, whenever it came. */
#include <cstdio>

#include "../src/keyframe_wait.h"

using namespace woc;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

int main()
{
    /* Joined mid-stream: datagrams every second, no keyframe, nothing decoded. */
    KeyframeWait k;
    uint64_t arrived = 0;
    for (int64_t t = 1000; t <= 20000; t += 1000)
        k.sample(t, arrived += 60, 0, 0);
    ok("joined mid-stream: the wait grows from the first sample (19 s)", k.wait_ms(20000) == 19000);
    k.sample(21000, arrived += 60, 1, 2);
    ok("a decoded frame ends it", k.wait_ms(21000) == 0);
    k.sample(22000, arrived += 60, 1, 2);
    ok("and it starts again when decoding stops", k.wait_ms(30000) == 8000);
    k.sample(23000, arrived, 1, 2);
    ok("the stream stopping ends it", k.wait_ms(23000) == 0);

    /* A normal start: the first datagrams carry SPS and IDR, frames follow. */
    KeyframeWait s;
    s.sample(1000, 30, 0, 2);
    s.sample(2000, 90, 12, 4);
    s.sample(3000, 150, 27, 4);
    ok("a stream start with keyframes: no wait", s.wait_ms(3000) == 0);

    /* A keyframe arrives during the wait and still nothing decodes: not a
     * missing keyframe. */
    KeyframeWait f;
    f.sample(1000, 60, 0, 0);
    f.sample(2000, 120, 0, 0);
    ok("before the keyframe: waiting", f.wait_ms(2000) == 1000);
    f.sample(3000, 180, 0, 2);
    for (int64_t t = 4000; t <= 60000; t += 1000)
        f.sample(t, 180 + (uint64_t)t / 10, 0, 2);
    ok("a keyframe that decodes nothing holds it at 0", f.wait_ms(60000) == 0);
    f.sample(61000, 7000, 1, 2);
    ok("a decoded frame clears it", f.wait_ms(61000) == 0);
    f.sample(62000, 7100, 1, 2);
    f.sample(63000, 7200, 1, 2);
    ok("a later wait counts again (from 62 s)", f.wait_ms(70000) == 8000);

    /* The stream's keyframes arrived before the first sample and nothing
     * decodes (the decoder cannot start): held at 0, through a pause too. */
    KeyframeWait d;
    for (int64_t t = 1000; t <= 20000; t += 1000)
        d.sample(t, (uint64_t)t / 10, 0, 4);
    ok("keyframes before the first sample, nothing decoded: no wait", d.wait_ms(20000) == 0);
    d.sample(21000, 2000, 0, 4);
    for (int64_t t = 22000; t <= 40000; t += 1000)
        d.sample(t, (uint64_t)t / 10, 0, 4);
    ok("and still none after the stream pauses and resumes", d.wait_ms(40000) == 0);

    /* Nothing arrives (no stream, or the phone paused it). */
    KeyframeWait q;
    for (int64_t t = 1000; t <= 30000; t += 1000)
        q.sample(t, 0, 0, 0);
    ok("no stream: no wait", q.wait_ms(30000) == 0);

    if (failures) {
        std::printf("%d FAILED\n", failures);
        return 1;
    }
    std::printf("all ok\n");
    return 0;
}
