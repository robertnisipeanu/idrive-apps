// SPDX-License-Identifier: GPL-3.0-or-later
/* Host test of the navigation's route box (route_box.h), on payloads laid
 * out byte for byte as a car sent them (made-up roads): a screen's events
 * in order, empty slots included, and the other screens' left out; a
 * payload without the cluster's screen saying nothing of it, and one with
 * it and empty slots only saying there is no manoeuvre; each turn's
 * direction, a fork's side, a roundabout's exit and the destination's side
 * as the card's arrow, and the plain mark for a kind or direction not known;
 * the distance's text and unit, metres and kilometres; a
 * text's length never taken for its direction (the mistake of the first
 * reading); the list mid-rebuild keeping the card; cut, garbled and
 * implausible input read without a fault and without inventing events. */
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "guided_card.h"
#include "route_box.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

namespace {

/* A payload in CommonAPI's big-endian serialisation. */
struct Payload {
    std::vector<uint8_t> b;

    Payload &u8(uint8_t v)
    {
        b.push_back(v);
        return *this;
    }
    Payload &u32(uint32_t v)
    {
        for (int s = 24; s >= 0; s -= 8)
            b.push_back((uint8_t)(v >> s));
        return *this;
    }
    Payload &f64(double d)
    {
        uint64_t v;
        std::memcpy(&v, &d, sizeof v);
        for (int s = 56; s >= 0; s -= 8)
            b.push_back((uint8_t)(v >> s));
        return *this;
    }
    Payload &zeros(size_t n)
    {
        b.insert(b.end(), n, 0);
        return *this;
    }
    Payload &raw(const Payload &p)
    {
        b.insert(b.end(), p.b.begin(), p.b.end());
        return *this;
    }
    /* a u32 length over the BOM, the text and a NUL */
    Payload &str(const std::string &s)
    {
        u32((uint32_t)(s.size() + 4));
        b.push_back(0xEF);
        b.push_back(0xBB);
        b.push_back(0xBF);
        b.insert(b.end(), s.begin(), s.end());
        b.push_back(0);
        return *this;
    }
    /* a screen: its name, its header and its events */
    Payload &screen(const std::string &name, const std::vector<Payload> &events)
    {
        str(name);
        size_t bytes = 0;
        uint8_t shown = 0;
        for (const Payload &e : events) {
            bytes += e.b.size();
            shown += e.b.size() >= 8 && e.b[7] != kRouteBoxEmpty;
        }
        u32(2).u32(0).u32(0).u8(shown).u32((uint32_t)bytes);
        for (const Payload &e : events)
            raw(e);
        return *this;
    }
};

/* a union: its length, its tag (the event's kind), its bytes */
Payload event(uint32_t kind, const Payload &data)
{
    Payload p;
    p.u32((uint32_t)data.b.size()).u32(kind).raw(data);
    return p;
}

/* the bytes of a turn or a destination up to its direction, as a car sent
 * them: lead is 2 for the first event, 1 for the ones after */
Payload head(const std::string &distance, uint32_t unit, const std::string &text, uint32_t lead)
{
    Payload d;
    d.u32(0).u32(1).f64(600).u8(0).u32(8).u32(1).zeros(8);
    d.str(distance).u32(unit).f64(1.0);
    const uint32_t s = (uint32_t)text.size() + 8;   /* the text string's bytes */
    d.u32(s + 8).u32(s).u32(1).str(text);
    d.zeros(16).u32(lead).u32(4).u32(1).zeros(12);
    return d;
}

Payload turn(const std::string &distance, uint32_t unit, const std::string &text, uint32_t direction,
             uint32_t lead = 2)
{
    Payload d = head(distance, unit, text, lead);
    d.u32(direction).u32(4).u32(1).zeros(8);
    return event(kRouteBoxTurn, d);
}

Payload fork(const std::string &distance, uint32_t unit, const std::string &text, uint32_t direction,
             uint32_t lead = 2)
{
    Payload d = head(distance, unit, text, lead);
    d.u32(direction).u32(4).u32(1).zeros(8);
    return event(kRouteBoxFork, d);
}

/* where a turn's direction is: the exit's angle (u16) and number (u8), then
 * a u32 (2) and its own 4, 1 */
Payload roundabout(const std::string &distance, uint32_t unit, const std::string &text, uint16_t angle,
                   uint8_t exit, uint32_t side = 2, uint32_t lead = 2)
{
    Payload d = head(distance, unit, text, lead);
    d.u8((uint8_t)(angle >> 8)).u8((uint8_t)angle).u8(exit).u32(side).u32(4).u32(1).zeros(4);
    return event(kRouteBoxRoundabout, d);
}

Payload destination(const std::string &distance, uint32_t unit, const std::string &text, uint32_t side,
                    uint32_t lead = 2)
{
    Payload d = head(distance, unit, text, lead);
    d.u32(side).u8(1).zeros(4);
    for (int i = 0; i < 3; i++)
        d.u32(4).u32(1).u32(0);
    return event(kRouteBoxDestination, d);
}

Payload empty_slot()
{
    Payload d;
    d.u32(0).u32(0).f64(0).u8(0).u32(8).u32(1).zeros(8).u32(0);
    return event(kRouteBoxEmpty, d);
}

bool parse(const Payload &p, const std::string &screen, std::vector<RouteBoxEvent> *e)
{
    return parse_route_box(p.b.data(), p.b.size(), screen, e);
}

}  // namespace

int main()
{
    std::vector<RouteBoxEvent> e;
    Maneuver m;

    ok("an empty slot is the 37 bytes a car sends, a turn's head its 60 after the text",
       empty_slot().b.size() == 8 + 37 && turn("0", 4, "R. Exemplo", 7).b.size() == 8 + 144);
    ok("and as a car sends them, a fork 60 after the text, a roundabout 59",
       fork("0", 4, "R. Exemplo", 2).b.size() == 8 + 144 && roundabout("0", 4, "R. Exemplo", 270, 3).b.size() == 8 + 143);
    {
        Payload p;
        p.u32(0).screen(kClusterRouteBox, {turn("300", 4, "Rua Exemplo", 5), turn(" ", 0, "Rua Seguinte", 2, 1),
                                           empty_slot()});
        const bool named = parse(p, kClusterRouteBox, &e);
        ok("the cluster's screen: named, its three slots in order", named && e.size() == 3 &&
                                                                       e[0].kind == kRouteBoxTurn &&
                                                                       e[2].kind == kRouteBoxEmpty);
        ok("the next turn: its distance, unit, text and direction",
           e.size() == 3 && e[0].distance == "300" && e[0].unit == 4 && e[0].text == "Rua Exemplo" && e[0].direction == 5);
        ok("the one after it: a blank distance, its own direction",
           e.size() == 3 && e[1].distance == " " && e[1].unit == 0 && e[1].text == "Rua Seguinte" && e[1].direction == 2);
        ok("the card: a right, 300 m, the road",
           route_box_maneuver(e, &m) && m.kind == Maneuver::Right && m.distance == "300 m" && m.road == "Rua Exemplo");
    }
    {
        /* 15 characters: the first reading took the text's length (31) for
         * a right turn */
        Payload p;
        p.u32(0).screen(kClusterRouteBox, {turn("80", 4, "Rua Quinze Ltrs", 2)});
        parse(p, kClusterRouteBox, &e);
        ok("a text's length is not its direction: a 15-letter road on the left is a left",
           route_box_maneuver(e, &m) && m.kind == Maneuver::Left);
    }
    {
        const Maneuver::Kind want[] = {Maneuver::Straight,    Maneuver::Left,       Maneuver::SlightLeft,
                                       Maneuver::SharpLeft,   Maneuver::Right,      Maneuver::SlightRight,
                                       Maneuver::SharpRight,  Maneuver::UTurn,      Maneuver::UTurn};
        bool all = true;
        for (uint32_t d = 1; d <= 9; d++) {
            Payload p;
            p.u32(0).screen(kClusterRouteBox, {turn("100", 4, "Rua Exemplo", d)});
            parse(p, kClusterRouteBox, &e);
            all = all && route_box_maneuver(e, &m) && m.kind == want[d - 1] && event_known(kRouteBoxTurn, d);
        }
        ok("turn directions 1 to 9: straight, left, slight left, sharp left, right, slight right, sharp right, "
           "U-turn, and 9 the U-turn a drive where traffic keeps right had",
           all);
    }
    {
        Payload p;
        p.u32(0).screen(kClusterRouteBox, {destination("100", 4, "Casa de Teste", 2), empty_slot(), empty_slot()});
        parse(p, kClusterRouteBox, &e);
        ok("the destination ahead: the flag, its distance and name",
           route_box_maneuver(e, &m) && m.kind == Maneuver::Arrive && m.distance == "100 m" && m.road == "Casa de Teste");
        ok("the destination's sides",
           kind_of_event(kRouteBoxDestination, 1) == Maneuver::ArriveLeft &&
               kind_of_event(kRouteBoxDestination, 3) == Maneuver::ArriveRight &&
               event_known(kRouteBoxDestination, 3) && !event_known(kRouteBoxDestination, 9) &&
               kind_of_event(kRouteBoxDestination, 9) == Maneuver::Arrive);
    }
    {
        Payload p;
        p.u32(0).screen(kClusterRouteBox, {turn("", 0, "rumo a Rua Exemplo", 1), turn(" ", 0, "Av. Seguinte", 5, 1)});
        parse(p, kClusterRouteBox, &e);
        ok("\"towards\" with no distance: straight on, no distance",
           route_box_maneuver(e, &m) && m.kind == Maneuver::Straight && m.distance.empty());
    }
    {
        Payload p;
        p.u32(0).screen(kClusterRouteBox, {fork("1,5", 1, "em dire\xC3\xA7\xC3\xA3o a Cidade Exemplo", 2), empty_slot()});
        parse(p, kClusterRouteBox, &e);
        ok("a fork's 2: keep right, its kilometres",
           route_box_maneuver(e, &m) && m.kind == Maneuver::KeepRight && m.distance == "1,5 km" &&
               m.road == "em dire\xC3\xA7\xC3\xA3o a Cidade Exemplo");
        Payload two;
        two.u32(0).screen(kClusterRouteBox, {fork("1,5", 1, "em dire\xC3\xA7\xC3\xA3o a Cidade A  Cidade B", 2)});
        parse(two, kClusterRouteBox, &e);
        ok("two names two spaces apart: joined by a middle dot on the card, the event's text as sent",
           route_box_maneuver(e, &m) && m.road == "em dire\xC3\xA7\xC3\xA3o a Cidade A \xC2\xB7 Cidade B" &&
               e[0].text == "em dire\xC3\xA7\xC3\xA3o a Cidade A  Cidade B");
        const struct { const char *sent, *shown; } roads[] = {
            {"  Rua Exemplo ", "Rua Exemplo"}, {"A   B", "A \xC2\xB7 B"}, {"Ponte  Av. Exemplo  Centro", "Ponte \xC2\xB7 Av. Exemplo \xC2\xB7 Centro"},
            {"   ", ""}, {"Rua de Uma Palavra So", "Rua de Uma Palavra So"}};
        bool all = true;
        for (const auto &r : roads) {
            Payload q;
            q.u32(0).screen(kClusterRouteBox, {turn("100", 4, r.sent, 5)});
            parse(q, kClusterRouteBox, &e);
            all = all && route_box_maneuver(e, &m) && m.road == r.shown;
        }
        ok("the road's ends' spaces dropped, a run of spaces one dot, single spaces kept", all);
        ok("a fork's 1 keep left, 1 and 2 known, others the plain mark",
           kind_of_event(kRouteBoxFork, 1) == Maneuver::KeepLeft && event_known(kRouteBoxFork, 1) &&
               event_known(kRouteBoxFork, 2) && kind_of_event(kRouteBoxFork, 3) == Maneuver::Other &&
               !event_known(kRouteBoxFork, 3));
    }
    {
        Payload p;
        p.u32(0).screen(kClusterRouteBox, {roundabout("200", 4, "Rua Exemplo", 270, 3), turn(" ", 0, "Rua Seguinte", 5, 1)});
        parse(p, kClusterRouteBox, &e);
        ok("a roundabout: its exit's angle and number, the u32 after them, not taken for a direction",
           e.size() == 2 && e[0].exit_angle == 270 && e[0].exit_number == 3 && e[0].direction == 2 &&
               e[1].direction == 5 && e[1].text == "Rua Seguinte");
        ok("by the third exit at 270: the ring, its exit to the left (-90), the road and distance",
           route_box_maneuver(e, &m) && m.kind == Maneuver::Roundabout && m.exit_deg == -90 && m.road == "Rua Exemplo" &&
               m.distance == "200 m" && event_known(kRouteBoxRoundabout, 2));
        const struct { uint16_t angle; uint8_t exit; int deg; } exits[] = {{360, 2, 0}, {90, 1, 90}, {180, 0, 180},
                                                                           {225, 4, -135}, {1, 1, 1}};
        bool all = true;
        for (const auto &x : exits) {
            Payload q;
            q.u32(0).screen(kClusterRouteBox, {roundabout("50", 4, "Rua Exemplo", x.angle, x.exit)});
            parse(q, kClusterRouteBox, &e);
            all = all && route_box_maneuver(e, &m) && m.kind == Maneuver::Roundabout && m.exit_deg == x.deg;
        }
        ok("its exits: 360 straight on (0), 90 right, 180 a U-turn round it, 225 back left (-135), 1", all);
    }
    {
        Payload p;
        p.u32(0).screen(kClusterRouteBox, {roundabout("50", 4, "Rua Exemplo", 270, 3, 1)});
        parse(p, kClusterRouteBox, &e);
        ok("a roundabout not as where traffic keeps right: the plain mark, not known",
           route_box_maneuver(e, &m) && m.kind == Maneuver::Other && !event_known(kRouteBoxRoundabout, 1));
        Payload z;
        z.u32(0).screen(kClusterRouteBox, {roundabout("50", 4, "Rua Exemplo", 0, 1)});
        parse(z, kClusterRouteBox, &e);
        ok("a roundabout with no angle (0): the plain mark", route_box_maneuver(e, &m) && m.kind == Maneuver::Other);
        Payload big;
        big.u32(0).screen(kClusterRouteBox, {roundabout("50", 4, "Rua Exemplo", 400, 1)});
        parse(big, kClusterRouteBox, &e);
        ok("an angle past 360: the plain mark", route_box_maneuver(e, &m) && m.kind == Maneuver::Other);
        /* its own 4, 1 missing: the angle not trusted */
        Payload d = head("50", 4, "Rua Exemplo", 2);
        d.u8(0x01).u8(0x0E).u8(3).u32(2).u32(9).u32(9).zeros(4);
        Payload q;
        q.u32(0).screen(kClusterRouteBox, {event(kRouteBoxRoundabout, d)});
        parse(q, kClusterRouteBox, &e);
        ok("a roundabout without its marks after the exit: no angle, the plain mark",
           e.size() == 1 && e[0].exit_angle == 0 && e[0].direction == 0 && route_box_maneuver(e, &m) &&
               m.kind == Maneuver::Other);
        Payload whole;
        whole.u32(0).screen(kClusterRouteBox, {roundabout("200", 4, "Rua Exemplo", 360, 2), fork(" ", 0, "Rua Seguinte", 1, 1)});
        bool fine = true;
        for (size_t n = 0; n <= whole.b.size(); n++) {
            parse_route_box(whole.b.data(), n, kClusterRouteBox, &e);
            fine = fine && e.size() <= 2 && (e.empty() || e[0].exit_angle == 0 || e[0].exit_angle == 360);
        }
        ok("a roundabout and a fork: every length read without a fault", fine);
    }
    {
        Payload p;
        p.u32(0).screen(kClusterRouteBox, {event(3, head("200", 4, "Esta\xC3\xA7\xC3\xA3o Exemplo", 2))});
        parse(p, kClusterRouteBox, &e);
        ok("a kind not known yet: the plain mark, its text as sent, accents and all",
           route_box_maneuver(e, &m) && m.kind == Maneuver::Other && m.road == "Esta\xC3\xA7\xC3\xA3o Exemplo" &&
               m.distance == "200 m" && !event_known(3, 0));
        ok("a direction not known yet: the plain mark",
           kind_of_event(kRouteBoxTurn, 10) == Maneuver::Other && !event_known(kRouteBoxTurn, 10) &&
               !event_known(kRouteBoxTurn, 0));
    }
    {
        Payload p;
        p.u32(0)
            .screen("CID.WidgetRB.Big", {turn("", 0, "Rumo a Rua Exemplo", 1)})
            .screen(kClusterRouteBox, {turn("60", 4, "Rua Diagonal", 7)})
            .screen("HUD.RB.All", {});
        parse(p, kClusterRouteBox, &e);
        ok("three screens: only the cluster's event", e.size() == 1 && e[0].text == "Rua Diagonal" && e[0].direction == 7);
        parse(p, "CID.WidgetRB.Big", &e);
        ok("and the central display's, asked for, only its own", e.size() == 1 && e[0].text == "Rumo a Rua Exemplo");
        const bool hud = parse(p, "HUD.RB.All", &e);
        ok("a screen named with no events: none, no card", hud && e.empty() && route_box_maneuver(e, &m) &&
                                                               m.kind == Maneuver::None);
    }
    {
        Payload p;
        p.u32(0).screen("CID.WidgetRB.Big", {turn("200", 4, "Rua Exemplo", 5)});
        ok("no cluster screen in the payload: it says nothing of it", !parse(p, kClusterRouteBox, &e) && e.empty());
    }
    {
        Payload p;
        p.u32(0).screen(kClusterRouteBox, {empty_slot(), empty_slot(), empty_slot()});
        ok("empty slots only: no manoeuvre",
           parse(p, kClusterRouteBox, &e) && e.size() == 3 && route_box_maneuver(e, &m) && m.kind == Maneuver::None);
        Payload q;
        q.u32(0).screen(kClusterRouteBox, {empty_slot(), turn(" ", 0, "Rua Seguinte", 5, 1), empty_slot()});
        parse(q, kClusterRouteBox, &e);
        Maneuver kept;
        kept.kind = Maneuver::Left;
        ok("the first slot empty and a later one not (the list mid-rebuild): the card keeps its own",
           !route_box_maneuver(e, &kept) && kept.kind == Maneuver::Left);
    }
    {
        /* the group after the text missing: no direction read */
        Payload d = head("300", 4, "Rua Exemplo", 2);
        d.b.resize(d.b.size() - 28);
        d.zeros(28);
        Payload p;
        p.u32(0).screen(kClusterRouteBox, {event(kRouteBoxTurn, d.u32(5).u32(4).u32(1).zeros(8))});
        parse(p, kClusterRouteBox, &e);
        ok("a turn without its marks after the text: no direction, the plain mark",
           e.size() == 1 && e[0].direction == 0 && route_box_maneuver(e, &m) && m.kind == Maneuver::Other);
    }
    {
        Payload p;
        p.u32(0).screen(kClusterRouteBox, {turn("300", 4, "Rua Exemplo", 5), turn("90", 4, "Rua Seguinte", 2, 1)});
        /* cut in the middle of the second event */
        Payload cut = p;
        cut.b.resize(p.b.size() - 40);
        parse(cut, kClusterRouteBox, &e);
        ok("cut short: the event before the cut, nothing invented",
           e.size() == 1 && e[0].text == "Rua Exemplo" && e[0].direction == 5);
        bool fine = true;
        for (size_t n = 0; n <= p.b.size(); n++) {
            parse_route_box(p.b.data(), n, kClusterRouteBox, &e);
            fine = fine && e.size() <= 2 && (e.empty() || e[0].text.empty() || e[0].text == "Rua Exemplo");
        }
        ok("every length of it read without a fault", fine);
        /* an event's length past the screen's bytes */
        Payload bad;
        bad.u32(0).str(kClusterRouteBox).u32(2).u32(0).u32(0).u8(1).u32(20).u32(0x7FFFFFF0).u32(2).zeros(12);
        ok("an event longer than its screen: none", parse(bad, kClusterRouteBox, &e) && e.empty());
        std::vector<uint8_t> noise(4096);
        uint32_t x = 12345;
        for (uint8_t &c : noise) {
            x = x * 1103515245u + 12345u;
            c = (uint8_t)(x >> 16);
        }
        ok("noise: nothing", !parse_route_box(noise.data(), noise.size(), kClusterRouteBox, &e) && e.empty());
        ok("nothing at all: nothing", !parse_route_box(nullptr, 0, kClusterRouteBox, &e) && e.empty());
    }

    /* the card while the navigation guides (guided_card.h) */
    {
        Maneuver out, right;
        out.kind = Maneuver::Straight;   /* the way out: no distance */
        out.road = "em dire\xC3\xA7\xC3\xA3o a Rua Exemplo";
        right.kind = Maneuver::Right;
        right.distance = "20 m";
        right.road = "Rua Seguinte";
        GuidedCard g;
        g.set_box(out, 1000);
        g.set_box(Maneuver(), 1022);
        ok("guiding not known: an empty box is no card at once, as before", g.shown(1022).kind == Maneuver::None);
        GuidedCard c;
        c.set_guiding(true);
        c.set_box(out, 1000);
        ok("guiding: the box's manoeuvre", c.shown(1000) == out);
        c.set_box(Maneuver(), 1022);
        ok("the box empty after the way out (no distance): held while guiding, 47 s on too",
           c.shown(1022) == out && c.shown(1022 + 47000) == out);
        c.set_box(right, 48000);
        ok("the first turn once the box has it", c.shown(48000) == right);
        c.set_box(Maneuver(), 50000);
        ok("one with a distance, the box empty while guiding: held a moment (a recalculation)",
           c.shown(50000 + GuidedCard::kGraceMs - 1) == right);
        ok("then gone (passed)", c.shown(50000 + GuidedCard::kGraceMs).kind == Maneuver::None);
        c.set_box(right, 51000);
        ok("a box again within the moment: no gap", c.shown(51000) == right);
        c.set_box(out, 60000);
        c.set_box(Maneuver(), 60010);
        c.set_guiding(false);
        ok("guiding off (arrived, cancelled): no card at once", c.shown(60010).kind == Maneuver::None);
        c.set_guiding(true);
        ok("on again for another route, the box still empty: nothing from before",
           c.shown(70000).kind == Maneuver::None);
        GuidedCard d;
        d.set_box(out, 1000);
        d.set_guiding(true);
        d.set_box(Maneuver(), 1022);
        ok("guiding on a few ms after the box's first: the way out held", d.shown(5000) == out);
        d.forget_guiding();
        ok("the Guidance service gone: not known again, an empty box no card", d.shown(5000).kind == Maneuver::None);
    }

    ok("distance: metres for unit 4, kilometres for 1, none when blank",
       route_box_distance("300", 4) == "300 m" && route_box_distance("1,5", 1) == "1,5 km" &&
           route_box_distance(" ", 0).empty() && route_box_distance("", 4).empty() &&
           route_box_distance("1,2", 7) == "1,2");
    ok("units 0, 1 and 4 known, 7 not", unit_known(0) && unit_known(1) && unit_known(4) && !unit_known(7));
    ok("an empty slot: no arrow, known", kind_of_event(kRouteBoxEmpty, 0) == Maneuver::None &&
                                             event_known(kRouteBoxEmpty, 0));

    std::printf("%s\n", failures ? "FAILED" : "all ok");
    return failures ? 1 : 0;
}
