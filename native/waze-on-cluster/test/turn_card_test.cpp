// SPDX-License-Identifier: GPL-3.0-or-later
/* Host test of the turn card (turn_card.h), its text (card_font.h) and
 * its setting (turn_card_setting.h): the kinds by name; the text decoded
 * from UTF-8, accents kept, a letter the font lacks folded or '?', a line
 * too wide cut with an ellipsis; a card with a plate, an arrow and text, a
 * plain mark for an arrow not known, and none for no manoeuvre; mirrored
 * arrows; roads not taken grey; a change of the distance alone touching
 * only the text's rows; the compact card, all on one line; the app's
 * example over the navigation's manoeuvre until it ends, on its own once
 * its time is up (card_choice.h); the setting off by default, the app's choice kept
 * across a restart, other values refused or read as off. */
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "card_choice.h"
#include "card_font.h"
#include "turn_card.h"
#include "turn_card_setting.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const uint8_t *at(const std::vector<uint8_t> &c, unsigned x, unsigned y)
{
    return &c[((size_t)y * kTurnCardW + x) * 4];
}

/* grey (a road not taken, 118,126,140) pixels in a rectangle */
static unsigned grey(const std::vector<uint8_t> &c, unsigned x0, unsigned y0, unsigned x1, unsigned y1)
{
    unsigned n = 0;
    for (unsigned y = y0; y < y1; y++)
        for (unsigned x = x0; x < x1; x++) {
            const uint8_t *p = at(c, x, y);
            n += p[0] >= 112 && p[0] <= 124 && p[2] >= 134 && p[2] <= 146 && p[3] > 240;
        }
    return n;
}

/* white pixels in a rectangle */
static unsigned white(const std::vector<uint8_t> &c, unsigned x0, unsigned y0, unsigned x1, unsigned y1)
{
    unsigned n = 0;
    for (unsigned y = y0; y < y1; y++)
        for (unsigned x = x0; x < x1; x++)
            n += at(c, x, y)[0] > 240 && at(c, x, y)[3] > 240;
    return n;
}

/* the road's light blue-grey text (200,208,220) in a rectangle, its glyphs'
 * cores: light, bluer than red, not white */
static unsigned light(const std::vector<uint8_t> &c, unsigned x0, unsigned y0, unsigned x1, unsigned y1)
{
    unsigned n = 0;
    for (unsigned y = y0; y < y1; y++)
        for (unsigned x = x0; x < x1; x++) {
            const uint8_t *p = at(c, x, y);
            n += p[0] > 150 && p[0] <= 240 && p[2] > p[0] && p[3] > 200;
        }
    return n;
}

int main()
{
    Maneuver::Kind k = Maneuver::None;
    ok("kinds by name", maneuver_kind("left", &k) && k == Maneuver::Left && maneuver_kind("uturn", &k) &&
                            k == Maneuver::UTurn && maneuver_kind("none", &k) && k == Maneuver::None &&
                            maneuver_kind("other", &k) && k == Maneuver::Other && maneuver_kind("keep_right", &k) &&
                            k == Maneuver::KeepRight && maneuver_kind("arrive_left", &k) && k == Maneuver::ArriveLeft &&
                            maneuver_kind("exit_left", &k) && k == Maneuver::ExitLeft &&
                            maneuver_kind("uturn_right", &k) && k == Maneuver::UTurnRight);
    ok("an unknown kind: refused", !maneuver_kind("sideways", &k) && !maneuver_kind("", &k));

    const CardFont &road = card_font_road(), &dist = card_font_distance();
    auto points = [](const std::vector<CardRun> &runs) {
        std::vector<uint32_t> out;
        for (const CardRun &r : runs)
            out.push_back(r.g->cp);
        return out;
    };
    int w = 0;
    ok("text: UTF-8, accents kept",
       points(card_line(road, "S\xC3\xA3o Jos\xC3\xA9 \xC3\x81rvore \xC4\x8C", 999, &w)) ==
           std::vector<uint32_t>({'S', 0xE3, 'o', ' ', 'J', 'o', 's', 0xE9, ' ', 0xC1, 'r', 'v', 'o', 'r', 'e', ' ', 0x10C}) &&
           w > 0);
    ok("text: Cyrillic in the road's font",
       points(card_line(road, "\xD0\x9C\xD0\xB8\xD1\x80", 999, nullptr)) == std::vector<uint32_t>({0x41C, 0x438, 0x440}));
    ok("text: a Vietnamese letter folded, an emoji and a stray byte as ?",
       points(card_line(road, "\xE1\xBA\xBF \xF0\x9F\x9A\x97 a\xC3", 999, nullptr)) ==
           std::vector<uint32_t>({'e', ' ', '?', ' ', 'a', '?'}));
    ok("text: the distance's font is ASCII: an accent as ?",
       points(card_line(dist, "2\xC2\xBD km", 999, nullptr)) == std::vector<uint32_t>({'2', '?', ' ', 'k', 'm'}));
    ok("text: spaces and controls as one space, none at the ends",
       points(card_line(road, "  a \t\n b  ", 999, nullptr)) == std::vector<uint32_t>({'a', ' ', 'b'}));
    int full = 0, cut = 0;
    card_line(road, "Avenida Longa Ficticia", 999, &full);
    const std::vector<CardRun> c100 = card_line(road, "Avenida Longa Ficticia", 100, &cut);
    ok("text: too wide, cut with an ellipsis within the room",
       full > 100 && cut <= 100 && cut > 60 && !c100.empty() && c100.back().g->cp == 0x2026 &&
           c100[c100.size() - 2].g->cp != ' ');
    int fit = 0;
    ok("text: one that fits is whole", points(card_line(road, "Av. Brasil", 999, &fit)).size() == 10 &&
                                           points(card_line(road, "Av. Brasil", fit, nullptr)).size() == 10);
    ok("text: nothing, no glyphs", card_line(road, "  ", 999, &w).empty() && w == 0);

    std::vector<uint8_t> none, left, right, far;
    Maneuver m;
    render_turn_card(m, &none);
    bool empty = none.size() == (size_t)kTurnCardW * kTurnCardH * 4;
    for (uint8_t b : none)
        empty = empty && b == 0;
    ok("no manoeuvre: a clear card", empty);

    m.kind = Maneuver::Left;
    m.distance = "200 m";
    m.road = "Av. Exemplo Comprida";
    render_turn_card(m, &left);
    ok("the plate: dark and nearly opaque in the middle, clear at the corners",
       at(left, 200, 30)[3] > 200 && at(left, 200, 30)[0] < 40 && at(left, 0, 0)[3] == 0 &&
           at(left, kTurnCardW - 1, kTurnCardH - 1)[3] == 0);
    ok("the arrow: white in the left square", white(left, 6, 4, 54, 52) > 150);
    ok("the distance and the road: text right of the arrow", white(left, 62, 7, 200, 28) > 100);
    m.kind = Maneuver::Right;
    render_turn_card(m, &right);
    ok("left and right: mirrored arrows",
       white(left, 6, 4, 18, 52) > 20 && white(left, 42, 4, 54, 52) == 0 && white(right, 42, 4, 54, 52) > 20 &&
           white(right, 6, 4, 18, 52) == 0);
    m.distance = "150 m";
    render_turn_card(m, &far);
    bool rows = true, changed = false;
    for (unsigned y = 0; y < kTurnCardH; y++)
        for (unsigned x = 0; x < kTurnCardW; x++)
            if (std::memcmp(at(right, x, y), at(far, x, y), 4)) {
                changed = true;
                rows = rows && y >= 7 && y < 28 && x >= 62;
            }
    ok("another distance: only the distance's rows change", changed && rows);
    std::vector<uint8_t> other;
    m.kind = Maneuver::Other;
    render_turn_card(m, &other);
    ok("an arrow not known: a dot in the middle of the square, no stroke",
       white(other, 22, 20, 38, 36) > 60 && white(other, 6, 42, 54, 52) == 0 && white(other, 6, 4, 54, 14) == 0 &&
           white(other, 62, 7, 200, 28) > 100);

    std::vector<uint8_t> keep, rb_right, rb_left, rb_back, flag, sharp;
    m.kind = Maneuver::KeepRight;
    render_turn_card(m, &keep);
    ok("keep right: the left branch grey, the head white on the right",
       grey(keep, 6, 4, 30, 30) > 20 && white(keep, 30, 4, 54, 20) > 40 && white(keep, 6, 4, 24, 20) == 0);
    m.kind = Maneuver::Roundabout;
    m.exit_deg = 90;
    render_turn_card(m, &rb_right);
    ok("roundabout, the first exit right: the ring's left grey, the arm and head right",
       grey(rb_right, 6, 14, 30, 44) > 20 && white(rb_right, 44, 22, 54, 36) > 15 && white(rb_right, 6, 22, 20, 36) == 0);
    m.exit_deg = -90;
    render_turn_card(m, &rb_left);
    ok("roundabout, the exit left: round anticlockwise by the right, the head left, the quarter left of the way in grey",
       white(rb_left, 6, 22, 16, 36) > 15 && white(rb_left, 45, 14, 54, 44) == 0 && grey(rb_left, 30, 14, 54, 44) < 10 &&
           grey(rb_left, 6, 30, 30, 44) > 20);
    m.exit_deg = 180;
    render_turn_card(m, &rb_back);
    ok("roundabout, back: all but round, the head down on the left of the way in",
       white(rb_back, 6, 36, 22, 52) > 15 && rb_back != rb_left);
    m.exit_deg = 0;
    m.kind = Maneuver::Arrive;
    render_turn_card(m, &flag);
    ok("arrive: a chequered flag", white(flag, 23, 10, 43, 25) > 60 && grey(flag, 23, 10, 43, 25) > 60);
    m.kind = Maneuver::SharpRight;
    render_turn_card(m, &sharp);
    ok("sharp right: up the left, the head down on the right",
       white(sharp, 12, 30, 26, 50) > 40 && white(sharp, 36, 26, 54, 46) > 25);

    /* the compact card below the arrow: one line */
    m.kind = Maneuver::Left;
    m.distance = "200 m";
    m.road = "Rua Exemplo";
    std::vector<uint8_t> low, low_none;
    render_turn_card(m, &low, true);
    ok("compact: kTurnCardW x kTurnCardCompactH", low.size() == (size_t)kTurnCardW * kTurnCardCompactH * 4);
    ok("compact: the arrow smaller, in its left square",
       white(low, 6, 3, 34, 31) > 60 && white(low, 0, 0, 6, kTurnCardCompactH) == 0);
    ok("compact: the distance in bold right of the arrow", white(low, 42, 4, 120, 27) > 60);
    ok("compact: the road after the distance, on the same line", light(low, 125, 8, 348, 30) > 40);
    ok("compact: nothing written below the line", white(low, 36, 31, kTurnCardW, kTurnCardCompactH) == 0 &&
                                                        light(low, 36, 31, kTurnCardW, kTurnCardCompactH) == 0);
    m.distance.clear();
    std::vector<uint8_t> low_road;
    render_turn_card(m, &low_road, true);
    ok("compact: no distance, the road where the distance would start", light(low_road, 42, 8, 120, 30) > 40);
    m.kind = Maneuver::None;
    render_turn_card(m, &low_none, true);
    bool clear = low_none.size() == (size_t)kTurnCardW * kTurnCardCompactH * 4;
    for (uint8_t b : low_none)
        clear = clear && b == 0;
    ok("compact: no manoeuvre, no card", clear);

    /* the app's example over the navigation's, and its end (card_choice.h) */
    {
        CardChoice ch;
        Maneuver g, ex;
        g.kind = Maneuver::Right;
        g.distance = "300 m";
        ex.kind = Maneuver::Left;
        ex.distance = "200 m";
        ch.set_guided(g);
        ok("choice: the navigation's manoeuvre", ch.shown() == g && !ch.example());
        ch.set_example(ex, 1000);
        ok("choice: the app's example over it", ch.shown() == ex && ch.example());
        ok("choice: the example lasts its time", !ch.expire(1000 + CardChoice::kExampleMs - 1) && ch.shown() == ex);
        ok("choice: then ends on its own, the app's end or not, and the navigation's shows again",
           ch.expire(1000 + CardChoice::kExampleMs) && ch.shown() == g && !ch.expire(1000 + CardChoice::kExampleMs + 5000));
        ch.set_example(ex, 50000);
        ch.set_example(ex, 55000);
        ok("choice: another example starts its time again", !ch.expire(50000 + CardChoice::kExampleMs) && ch.example());
        ch.set_example(Maneuver(), 56000);
        ok("choice: the app's none ends it at once", !ch.example() && ch.shown() == g && !ch.expire(70000));
        g.distance = "100 m";
        ch.set_guided(g);
        ok("choice: the navigation's next one", ch.shown().distance == "100 m");
    }

    const std::string path = "/tmp/woc-turn-card-test-" + std::to_string(getpid()) + ".conf";
    unlink(path.c_str());
    ok("default: off", TurnCardSetting("off", path).mode() == TurnCardSetting::Off);
    ok("the configuration's bottom and top",
       TurnCardSetting("bottom", path).mode() == TurnCardSetting::Bottom &&
           TurnCardSetting("top", path).mode() == TurnCardSetting::Top);
    ok("the configuration's other values: off", TurnCardSetting("1", path).mode() == TurnCardSetting::Off);
    {
        TurnCardSetting s("off", path);
        ok("the app's bottom", s.set("bottom") && s.mode() == TurnCardSetting::Bottom &&
                                   std::string(s.name()) == "bottom");
        ok("another choice: refused, nothing changed", !s.set("middle") && !s.set("") &&
                                                           s.mode() == TurnCardSetting::Bottom);
    }
    ok("after a restart: still bottom, over the configuration's off",
       TurnCardSetting("off", path).mode() == TurnCardSetting::Bottom);
    {
        TurnCardSetting s("bottom", path);
        ok("the app's off", s.set("off") && s.mode() == TurnCardSetting::Off);
    }
    ok("after a restart: off, over the configuration's top", TurnCardSetting("top", path).mode() == TurnCardSetting::Off);
    std::ofstream(path) << "turn_card = sideways\n";
    ok("a saved value that is none of them: off", TurnCardSetting("top", path).mode() == TurnCardSetting::Off);
    std::ofstream(path) << "garbage\n";
    ok("a state file without the setting: off", TurnCardSetting("top", path).mode() == TurnCardSetting::Off);
    unlink(path.c_str());

    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
