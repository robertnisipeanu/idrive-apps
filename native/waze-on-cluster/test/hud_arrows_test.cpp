// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* Host test of the HUD arrows option (hud_arrows.h), with a fake
 * winston-grabber: a script that writes the centre screen, the CarPlay card
 * of test/data/carplay-card-30m.pgm (Waze's right turn, captured on the car)
 * at its place, as BGRA frames to the FIFO it is given.
 * - off (the default): no grabber started, no hud.json, nothing in the report;
 * - on: the grabber started, and the card's right turn written to hud.json;
 * - the reading's file and its heartbeat;
 * - off again: hud.json removed. */
#include <sys/stat.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "../src/hud_arrows.h"
#include "log.h"

using namespace woc;

static int failures;

static void ok(const std::string &name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name.c_str());
    if (!cond) failures++;
}

static bool exists(const std::string &p) { return access(p.c_str(), F_OK) == 0; }

static std::string slurp(const std::string &p)
{
    std::ifstream f(p);
    std::stringstream s;
    s << f.rdbuf();
    return s.str();
}

int main()
{
    const std::string dir = "/tmp/woc-hud-arrows-test-" + std::to_string(getpid());
    mkdir(dir.c_str(), 0755);
    const std::string frame = dir + "/frame.bgra", mark = dir + "/grabber-started", grabber = dir + "/grabber.sh";
    const std::string json = dir + "/hud.json";

    /* the centre screen, 1920x720, black, the card's 580x220 at 120,0 */
    Gray card;
    if (!read_pgm("test/data/carplay-card-30m.pgm", &card)) {
        std::printf("FAIL cannot read test/data/carplay-card-30m.pgm\n");
        return 1;
    }
    const unsigned W = 1920, H = 720;
    std::vector<uint8_t> bgra((size_t)W * H * 4, 0);
    for (unsigned y = 0; y < card.h; y++)
        for (unsigned x = 0; x < card.w; x++) {
            uint8_t *p = &bgra[((size_t)y * W + x + 120) * 4];
            p[0] = p[1] = p[2] = card.px[(size_t)y * card.w + x];
            p[3] = 255;
        }
    std::ofstream(frame, std::ios::binary).write((const char *)bgra.data(), (std::streamsize)bgra.size());
    /* argv as ScreenGrab gives it: --screen --geometry --fps --num-frames --pipeline <fifo> */
    std::ofstream(grabber) << "#!/bin/sh\n: > '" << mark << "'\nwhile :; do cat '" << frame
                           << "' || exit 1; sleep 0.1; done > \"$6\"\n";
    chmod(grabber.c_str(), 0755);

    HudConfig hc;
    hc.grab.grabber = grabber;
    hc.grab.fifo = dir + "/screen.fifo";
    hc.templates_dir = dir + "/no-templates";
    hc.guidance_path = json;
    hc.sample_ms = 100;

#ifdef __linux__   /* screen_grab opens its FIFO read-write, which POSIX leaves to Linux (macOS reads nothing) */
    {
        HudArrows arrows(hc);
        int64_t t0 = cld::now_ms();
        while (cld::now_ms() - t0 < 1200) {
            arrows.set_active(false, cld::now_ms());
            arrows.poll(cld::now_ms());
            usleep(50 * 1000);
        }
        ok("off: no grabber started", !exists(mark));
        ok("off: no hud.json", !exists(json));
        ok("off: the report says off, nothing more", arrows.report() == "hud arrows: off\n");

        arrows.set_active(true, cld::now_ms());
        t0 = cld::now_ms();
        std::string got;
        while (cld::now_ms() - t0 < 8000) {
            arrows.poll(cld::now_ms());
            got = slurp(json);
            if (got.find("\"maneuver\":\"right\"") != std::string::npos)
                break;
            usleep(50 * 1000);
        }
        ok("on: the grabber started", exists(mark));
        ok("on: the card's right turn in hud.json, no distance without templates (" + got.substr(0, got.find('\n')) + ")",
           got.find("{\"maneuver\":\"right\",\"distance\":\"\",\"at\":") == 0);
        ok("on: the report names the reading", arrows.report().find("shown right") != std::string::npos);

        arrows.set_active(false, cld::now_ms());
        ok("off again: hud.json removed", !exists(json));
        arrows.poll(cld::now_ms() + 5000);
        ok("off again: not written again", !exists(json));
    }
#else
    std::printf("skip the grabber's part: Linux only (make test-x86)\n");
#endif

    /* the file itself */
    {
        NativeGuidanceHud n(json);
        Reading r;
        r.maneuver = "left";
        r.distance = "450 m";
        n.show(r, 5000);
        ok("the reading goes to the file", slurp(json) == "{\"maneuver\":\"left\",\"distance\":\"450 m\",\"at\":5000}\n");
        n.poll(5500);
        ok("no rewrite within a second", slurp(json).find("\"at\":5000") != std::string::npos);
        n.poll(6000);
        ok("the heartbeat rewrites it", slurp(json).find("\"at\":6000") != std::string::npos);
        n.show(Reading(), 6100);
        ok("an empty reading clears the arrow", slurp(json).find("\"maneuver\":\"\"") != std::string::npos);
        n.clear();
        ok("clear removes the file", !exists(json));
    }

    unlink(frame.c_str());
    unlink(mark.c_str());
    unlink(grabber.c_str());
    unlink(json.c_str());
    unlink(hc.grab.fifo.c_str());
    rmdir(dir.c_str());
    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
