// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host test for the alternate-screen connection (alt_screen.h): an
 * established row on port 6031 with carplay's uid counts, in tcp6 or tcp;
 * listening, another port, another uid or a table that cannot be read do
 * not. The stream is live with the connection, whatever the frames do;
 * without it, while frames come within stall_ms, counting after a connection
 * ended only frames over a second later: a later session on another port
 * shows, the frames still on their way from the one that ended do not. */
#include <unistd.h>

#include <cstdio>
#include <fstream>
#include <string>

#include "../src/alt_screen.h"

using namespace woc;

static int failures;
static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const char kHeader6[] =
    "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when "
    "retrnsmt   uid  timeout inode\n";
static std::string row6(const char *port, const char *st, unsigned uid)
{
    char line[400];
    std::snprintf(line, sizeof line,
                  "   3: 0000000000000000FFFF00000A00A8C0:%s 0000000000000000FFFF00000200A8C0:C351 %s 00000000:00000000 "
                  "00:00000000 00000000 %5u        0 41187 1 0000000000000000 20 4 30 10 -1\n",
                  port, st, uid);
    return line;
}

int main()
{
    const std::string table = kHeader6 + row6("178E", "01", 13002) + row6("178F", "01", 13002);
    ok("established, port 6031, carplay's uid: connected", alt_screen_in(table, 6031, 13002));
    ok("listening only: not", !alt_screen_in(kHeader6 + row6("178F", "0A", 13002), 6031, 13002));
    ok("the main screen's 6030 only: not", !alt_screen_in(kHeader6 + row6("178E", "01", 13002), 6031, 13002));
    ok("another uid: not", !alt_screen_in(kHeader6 + row6("178F", "01", 5000), 6031, 13002));
    ok("the header alone: not", !alt_screen_in(kHeader6, 6031, 13002));
    const std::string v4 = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
                           "   0: 0A00A8C0:178F 0200A8C0:C351 01 00000000:00000000 00:00000000 00000000 13002        0 9 1 0\n";
    ok("an IPv4 row counts too", alt_screen_in(v4, 6031, 13002));

    const std::string a = "/tmp/woc-alt-" + std::to_string(getpid()), b = a + "-v4";
    std::ofstream(a) << kHeader6 + row6("178F", "0A", 13002);
    std::ofstream(b) << v4;
    ok("read: found in the second table", AltScreen(6031, 13002, {a, b}).read() == AltScreen::Connected);
    ok("read: absent from a readable table", AltScreen(6031, 13002, {a}).read() == AltScreen::Absent);
    ok("read: no table readable is unknown", AltScreen(6031, 13002, {a + "-none"}).read() == AltScreen::Unknown);
    unlink(a.c_str());
    unlink(b.c_str());

    StreamLiveness l(6000);
    ok("no connection yet: frames within stall_ms", l.live(AltScreen::Absent, 1000, 6000) &&
                                                    !l.live(AltScreen::Absent, 1000, 8000));
    ok("connected: live with no frame for minutes", l.live(AltScreen::Connected, 1000, 300000));
    ok("the connection gone: not live, though a frame just came", !l.live(AltScreen::Absent, 300000, 300000));
    ok("nor with a frame still on its way", !l.live(AltScreen::Absent, 300800, 301000));
    ok("a later session on another port: its frames make it live", l.live(AltScreen::Absent, 360000, 360000) &&
                                                                    !l.live(AltScreen::Absent, 360000, 367000));
    ok("tables unreadable: the frames", l.live(AltScreen::Unknown, 400000, 403000) &&
                                        !l.live(AltScreen::Unknown, 400000, 407000));
    ok("no frame ever and no connection: not live", !StreamLiveness(6000).live(AltScreen::Absent, -1, 1000));

    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
