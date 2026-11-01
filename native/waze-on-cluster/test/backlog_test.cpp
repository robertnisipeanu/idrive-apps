// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test for the backlog (backlog.h): the minute's mean and largest wait
 * and the frames skipped, the largest wait since the start, and the decoder
 * behind the stream only after every packet waited kLagUs or more for
 * kLagForMs, until one waits less than half of it. */
#include <cstdio>

#include "../src/backlog.h"

using namespace woc;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

int main()
{
    {
        Backlog b;
        b.packet(0, 1000);
        b.packet(10, 3000);
        b.packet(20, 5000);
        b.skipped();
        b.skipped();
        const Backlog::Minute m = b.take_minute();
        ok("the minute: mean and largest wait, frames skipped",
           m.wait_us.n == 3 && m.wait_us.mean() == 3000 && m.wait_us.max == 5000 && m.skipped == 2);
        b.packet(30, 2000);
        b.skipped();
        const Backlog::Minute n = b.take_minute();
        ok("the next minute starts afresh", n.wait_us.n == 1 && n.wait_us.max == 2000 && n.skipped == 1);
        ok("the totals since the start stay", b.max_wait_us() == 5000 && b.skipped_total() == 3);
    }
    {
        /* 250 ms waits every 100 ms, broken once by a 150 ms one: never 5 s
         * in a row. */
        Backlog b;
        bool quiet = true;
        for (int64_t t = 0; t < 4900; t += 100)
            quiet = quiet && b.packet(t, 250000).empty();
        quiet = quiet && b.packet(4900, 150000).empty();
        for (int64_t t = 5000; t < 9900; t += 100)
            quiet = quiet && b.packet(t, 250000).empty();
        ok("long waits short of 5 s in a row: not behind", quiet && !b.behind(9800));
    }
    {
        Backlog b;
        bool quiet = true;
        for (int64_t t = 0; t < 5000; t += 100)
            quiet = quiet && b.packet(t, 250000).empty();
        const std::string start = b.packet(5000, 850000);
        ok("every packet over 200 ms for 5 s: behind, said once",
           quiet && b.behind(5000) &&
               start == "waze: the decoder is behind the stream: every packet for 5 s waited over 200 ms in the "
                        "receive queue, now 850 ms, with pictures skipped to catch up");
        bool still = b.packet(5100, 2400000).empty() && b.packet(5200, 150000).empty();
        for (int64_t t = 5300; t < 42000; t += 500)
            still = still && b.packet(t, 300000).empty();
        ok("and not again while it stays behind", still && b.behind(41900));
        const std::string end = b.packet(42000, 40000);
        ok("a wait under 100 ms ends it",
           !b.behind(42000) &&
               end == "waze: the decoder caught up with the stream after 42 s behind it (packets waited at most 2400 ms)");
    }
    {
        /* Behind, then the stream stops: not behind once the packets have
         * paused, and the next stream starts afresh, with no line. */
        Backlog b;
        for (int64_t t = 0; t <= 5000; t += 100)
            b.packet(t, 300000);
        const bool was = b.behind(5000);
        ok("behind while the packets come, not after a pause", was && b.behind(6000) && !b.behind(6001));
        ok("the next stream starts afresh, with no caught-up line",
           b.packet(60000, 300000).empty() && !b.behind(60000) && b.packet(60100, 20000).empty());
    }
    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    return 0;
}
