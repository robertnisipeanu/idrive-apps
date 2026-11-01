// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test for the stream's health after a loss (stream_health.h): the
 * status reason while decoding through a loss and while waiting for a
 * keyframe, the log lines and their limit, and the minute's counts. */
#include <cstdio>
#include <string>

#include "../src/stream_health.h"

using namespace woc;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

/* 2026-11-01 12:39:50 UTC */
static const int64_t kWall = 1793536790000LL;

int main()
{
    StreamHealth h;
    ok("a clean stream has no reason", h.reason(0, "").empty() && h.frame(10, 0).empty());

    const std::string l = h.loss(1000, kWall, "avb", 1235, 1240, 5, 0);
    ok("a loss is logged with the jump and the source",
       l == "waze: lost 5 packets of the stream from avb (sequence 1240, expected 1235); decoding through it");
    ok("then the reason says when, and that it decodes through it",
       h.reason(1100, "") == "lost part of the stream at 12:39:50; decoding through it");
    ok("the first corrupted frame is logged with its flags",
       h.frame(1050, 0x10) == "waze: the first frame after the loss is corrupted (decoder flags 0x10)");
    ok("later ones are not", h.frame(1083, 0x10).empty() && h.frame(1116, 0x10).empty());
    ok("still decoding through it", h.reason(1200, "") == "lost part of the stream at 12:39:50; decoding through it");
    ok("the first clean frame ends it, logged",
       h.frame(1150, 0) == "waze: the picture is clean again 150 ms after the loss at 12:39:50 (3 corrupted frames)" &&
           h.reason(1200, "").empty());

    const std::string q = h.loss(5000, kWall + 4000, "udp", 9, 12, 3, 3);
    ok("a loss the receive queue caused says so",
       q == "waze: lost 3 packets of the stream from udp (sequence 12, expected 9; 3 dropped by the receive queue); "
            "decoding through it");
    ok("no frame within 2 s of a loss: the reason says nothing decoded since",
       h.reason(6900, "") == "lost part of the stream at 12:39:54; decoding through it" &&
           h.reason(7000, "") == "lost part of the stream at 12:39:54; nothing decoded since");
    h.loss(7200, kWall + 6200, "avb", 15, 16, 1, 0);
    ok("a further loss in the same episode keeps its start",
       h.reason(7300, "") == "lost part of the stream at 12:39:54; nothing decoded since");

    h.waiting(8000, kWall + 7000, true);
    ok("the decoder giving up: waiting for a keyframe, with patchd's reason",
       h.reason(48000, "recmgr did not load a carplay restart entry this boot") ==
           "waiting for a keyframe since 12:39:57; resync held: recmgr did not load a carplay restart entry this boot");
    ok("and without one", h.reason(9000, "") == "waiting for a keyframe since 12:39:57");
    ok("a loss while waiting keeps it waiting",
       h.loss(9500, kWall + 8500, "avb", 20, 22, 2, 0) ==
               "waze: lost 2 packets of the stream from avb (sequence 22, expected 20); the decoder waits for a keyframe" &&
           h.reason(10000, "").find("waiting for a keyframe") == 0);
    ok("a new sequence is clean, logged",
       h.waiting(11000, kWall + 10000, false) == "waze: decoding again from a keyframe after 3 s waiting" && h.reason(11000, "").empty());
    ok("a sequence that starts without a wait logs nothing", h.waiting(12000, kWall + 11000, false).empty());

    const StreamHealth::Minute m = h.take_minute();
    ok("the minute counts losses, packets lost and corrupted frames", m.losses == 4 && m.lost == 11 && m.corrupted == 3);
    const StreamHealth::Minute none = h.take_minute();
    ok("and starts over", none.losses == 0 && none.lost == 0 && none.corrupted == 0);

    StreamHealth burst;
    unsigned logged = 0;
    for (int i = 0; i < 25; i++)
        logged += !burst.loss(1000 + i, kWall, "avb", (uint16_t)(2 * i), (uint16_t)(2 * i + 1), 1, 0).empty();
    ok("at most 10 lines a minute", logged == 10);
    ok("the next minute logs again", !burst.loss(61001, kWall, "avb", 100, 101, 1, 0).empty());
    ok("the minute line counts every loss", burst.take_minute().losses == 26);

    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    return 0;
}
