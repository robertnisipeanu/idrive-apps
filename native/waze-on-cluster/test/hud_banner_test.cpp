// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* Host test of the banner recogniser (hud_banner.h) on synthetic frames:
 * a 1088x480 luma plane with a busy map-like background and a banner card
 * holding an arrow and a distance, drawn by hud_draw.h at another size and
 * offset than the built-in templates, day (light on dark) and night (dark on
 * light), with noise. It checks the pipeline, not Waze's real icons, which
 * only the owner's captures can (README.md "HUD arrows").
 * - every manoeuvre is read, day and night;
 * - the distance is read: m, km, ft, mi, with a decimal point;
 * - no banner (the map alone, a flat card) reads as none;
 * - templates from a folder replace the built-in icons; a dist template
 *   whose glyphs do not match its text is reported;
 * - the PNG dump is a valid PNG; the debounce reports a reading only once
 *   it is stable and changed;
 * - the cost of one read, for the CPU estimate. */
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "../src/hud_banner.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const unsigned W = 1088, H = 480;
static const Rect kIcon{294, 80, 88, 88}, kDist{390, 96, 200, 56};

static uint32_t rng = 12345;
static unsigned rnd(unsigned n) { rng = rng * 1103515245u + 12345u; return (rng >> 8) % n; }

/* The map: a gradient with road-like bright and dark lines. */
static std::vector<uint8_t> map_frame()
{
    std::vector<uint8_t> f(W * H);
    for (unsigned y = 0; y < H; y++)
        for (unsigned x = 0; x < W; x++)
            f[y * W + x] = (uint8_t)(90 + (x + y) % 60);
    for (int i = 0; i < 40; i++) {
        const bool vert = rnd(2);
        const unsigned at = rnd(vert ? W : H), v = rnd(2) ? 230 : 20;
        for (unsigned k = 0; k < (vert ? H : W); k++)
            for (unsigned t = 0; t < 4; t++) {
                const unsigned x = vert ? std::min(at + t, W - 1) : k, y = vert ? k : std::min(at + t, H - 1);
                f[y * W + x] = (uint8_t)v;
            }
    }
    return f;
}

static void paint(std::vector<uint8_t> *f, const Gray &cov, unsigned ox, unsigned oy, uint8_t bg, uint8_t fg)
{
    for (unsigned y = 0; y < cov.h; y++)
        for (unsigned x = 0; x < cov.w; x++) {
            const int c = cov.px[y * cov.w + x];
            int v = bg + (fg - bg) * c / 255 + (int)rnd(13) - 6;
            (*f)[(oy + y) * W + ox + x] = (uint8_t)std::max(0, std::min(255, v));
        }
}

static std::vector<uint8_t> banner(const std::string &label, const std::string &dist, bool night)
{
    std::vector<uint8_t> f = map_frame();
    const uint8_t bg = night ? 215 : 45, fg = night ? 30 : 240;
    Gray card(320, 104);
    paint(&f, card, 286, 72, bg, fg);
    Gray icon(kIcon.w, kIcon.h);
    draw_maneuver(&icon, label, 11, 8, 70);
    paint(&f, icon, kIcon.x, kIcon.y, bg, fg);
    Gray text(kDist.w, kDist.h);
    draw_text(&text, dist, 6, 10, 30);
    paint(&f, text, kDist.x, kDist.y, bg, fg);
    return f;
}

int main()
{
    Templates t;
    t.add_builtin(true);
    ok("built-in templates: every manoeuvre and the glyphs", t.icons() == maneuver_labels().size() && t.glyphs() == 15);
    Recogniser rec(&t, kIcon, kDist);

    int right = 0, total = 0;
    for (int night = 0; night < 2; night++)
        for (const std::string &l : maneuver_labels()) {
            const Reading r = rec.read(banner(l, "300 m", night).data(), W, H);
            total++;
            if (r.maneuver == l && r.distance == "300 m")
                right++;
            else
                std::printf("     %s %s: read %s (%.2f) %s\n", l.c_str(), night ? "night" : "day", r.maneuver.c_str(),
                            r.score, r.distance.c_str());
        }
    ok("every manoeuvre and its distance, day and night", right == total);

    const char *dists[] = {"1.2 km", "50 m", "800 ft", "0.5 mi", "15 km", "1,4 km"};
    const char *want[] = {"1.2 km", "50 m", "800 ft", "0.5 mi", "15 km", "1.4 km"};
    bool all = true;
    for (int i = 0; i < 6; i++) {
        const Reading r = rec.read(banner("left", dists[i], i % 2).data(), W, H);
        if (r.distance != want[i]) {
            std::printf("     %s: read \"%s\"\n", dists[i], r.distance.c_str());
            all = false;
        }
    }
    ok("distances in m, km, ft, mi, with a decimal point or comma", all);

    int none = 0;
    for (int i = 0; i < 20; i++)
        none += rec.read(map_frame().data(), W, H).maneuver.empty();
    ok("the map alone reads as no banner", none == 20);
    std::vector<uint8_t> flat = map_frame();
    paint(&flat, Gray(320, 104), 286, 72, 45, 45);
    ok("an empty card reads as no banner", rec.read(flat.data(), W, H).maneuver.empty());

    /* Templates from a folder: dumps of our own banners as the owner's
     * labelled captures would be. */
    const std::string dir = "/tmp/woc-hud-test-" + std::to_string(getpid());
    mkdir(dir.c_str(), 0755);
    Gray g;
    crop(banner("keep_left", "300 m", false).data(), W, H, kIcon, &g);
    ok("a dump is a PNG", write_png(dir + "/icon.png", g));
    FILE *f = std::fopen((dir + "/icon.png").c_str(), "rb");
    unsigned char sig[8] = {0};
    ok("with the PNG signature", f && std::fread(sig, 1, 8, f) == 8 && !std::memcmp(sig, "\x89PNG\r\n\x1a\n", 8));
    if (f) std::fclose(f);
    auto pgm = [&](const std::string &name, const Gray &img) {
        FILE *o = std::fopen((dir + "/" + name).c_str(), "wb");
        std::fprintf(o, "P5\n%u %u\n255\n", img.w, img.h);
        std::fwrite(img.px.data(), 1, img.px.size(), o);
        std::fclose(o);
    };
    pgm("icon-keep_left-1.pgm", g);
    crop(banner("right", "300 m", false).data(), W, H, kIcon, &g);
    pgm("icon-right-1.pgm", g);
    crop(banner("right", "1.2 km", false).data(), W, H, kDist, &g);
    pgm("dist-1.2km-1.pgm", g);
    pgm("dist-99m-1.pgm", g);
    Templates own;
    own.add_builtin(false);
    std::string log;
    const int n = own.load_dir(dir, &log);
    ok("the folder's templates load; a dist whose glyphs do not match its text is reported",
       n == 3 && own.icons() == 2 && log.find("dist-99m-1.pgm") != std::string::npos);
    Recogniser rec2(&own, kIcon, kDist);
    ok("the folder's icons replace the built-in ones",
       rec2.read(banner("keep_left", "300 m", true).data(), W, H).maneuver == "keep_left" &&
           rec2.read(banner("straight", "300 m", false).data(), W, H).score <
               rec.read(banner("straight", "300 m", false).data(), W, H).score);
    ok("no folder: none added", own.load_dir(dir + "/none", &log) == 0);
    ok("cleaned up", std::system(("rm -rf " + dir).c_str()) == 0);

    Debounce d(2);
    Reading a, b, out;
    a.maneuver = "left";
    a.distance = "300 m";
    b = a;
    b.distance = "200 m";
    ok("debounce: one reading is not yet stable", !d.push(a, &out));
    ok("debounce: twice is reported", d.push(a, &out) && out == a);
    ok("debounce: the same again is not", !d.push(a, &out));
    ok("debounce: a flicker is not", !d.push(b, &out) && !d.push(a, &out));
    ok("debounce: a change held twice is", !d.push(b, &out) && d.push(b, &out) && out == b);
    ok("debounce: no banner held twice clears", !d.push(Reading(), &out) && d.push(Reading(), &out) &&
                                                    out.maneuver.empty());

    ok("parse: plain and unit-less", parse_distance("300m") == "300 m" && parse_distance("300").empty() &&
                                         parse_distance("1.2.3km").empty() && parse_distance("?00m").empty());
    ok("parse: a lost leading digit is no distance", parse_distance("00m").empty() && parse_distance("0m") == "0 m" &&
                                                         parse_distance("07m").empty() &&
                                                         parse_distance("0.5km") == "0.5 km" &&
                                                         parse_distance("0,3mi") == "0.3 mi");

    CardHold hold(3000);
    Reading c50, c, mapr;
    c50.maneuver = c.maneuver = "left";
    c50.distance = "50 m";
    mapr.maneuver = "straight";
    ok("hold: no card read before: the map's reading", hold.pick(mapr, false, 0) == mapr);
    ok("hold: a card reading passes", hold.pick(c50, true, 1000) == c50);
    ok("hold: a miss within 3 s gives the card's", hold.pick(mapr, false, 2000) == c50);
    ok("hold: the same turn without a distance keeps it", hold.pick(c, true, 2500) == c50);
    ok("hold: a distance borrowed does not renew the 3 s", hold.pick(c, true, 3500) == c50 &&
                                                               hold.pick(c, true, 4100) == c);
    ok("hold: after 3 s the map's again", hold.pick(mapr, false, 7200) == mapr);
    Reading r2 = c50;
    r2.maneuver = "right";
    r2.distance.clear();
    ok("hold: another turn does not take the distance", hold.pick(r2, true, 7300) == r2);
    ok("hold: no card and no map: the card's within 3 s", hold.pick(Reading(), false, 8000) == r2 &&
                                                              hold.pick(Reading(), false, 10400).maneuver.empty());

    const std::vector<uint8_t> frame = banner("roundabout_2", "1.2 km", false);
    const auto t0 = std::chrono::steady_clock::now();
    const int reps = 200;
    for (int i = 0; i < reps; i++)
        rec.read(frame.data(), W, H);
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count() / reps;
    std::printf("     one read: %.3f ms on this host (at 3 a second: %.2f%% of one core)\n", ms, ms * 3 / 10);
    ok("one read costs under 5 ms here", ms < 5);

    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
