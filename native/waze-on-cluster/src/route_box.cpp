// SPDX-License-Identifier: GPL-3.0-or-later
#include "route_box.h"

#include <cstring>

namespace woc {

const char kClusterRouteBox[] = "IC.RB.Main";

namespace {

/* Longer strings are not the route box's: a length field read in the
 * middle of other data. */
const uint32_t kMaxString = 2048;

uint32_t u32_at(const uint8_t *p)
{
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | (uint32_t)p[3];
}

struct Str {
    size_t start = 0;   /* its length field */
    size_t end = 0;     /* past its NUL */
    std::string text;   /* without the BOM and the NUL */
};

/* Each CommonAPI string in p, in order: a u32 length (4 to kMaxString)
 * over a BOM, the text and a NUL. Where none starts, the next byte is
 * tried. */
std::vector<Str> strings(const uint8_t *p, size_t n)
{
    std::vector<Str> out;
    size_t i = 0;
    while (n >= 8 && i <= n - 8) {
        const uint32_t len = u32_at(p + i);
        if (len >= 4 && len <= kMaxString && len <= n - i - 4 && p[i + 4] == 0xEF && p[i + 5] == 0xBB &&
            p[i + 6] == 0xBF && p[i + 3 + len] == 0) {
            Str s;
            s.start = i;
            s.end = i + 4 + len;
            s.text.assign((const char *)p + i + 7, len - 4);
            out.push_back(s);
            i = s.end;
        } else {
            i++;
        }
    }
    return out;
}

/* At most this many events a screen: a car sends 3. */
const size_t kMaxEvents = 16;

/* An event's distance, unit, text and direction, and a roundabout's exit
 * (route_box.h). */
void read_event(const uint8_t *d, size_t n, RouteBoxEvent *e)
{
    const std::vector<Str> ss = strings(d, n);
    if (ss.empty())
        return;
    const Str &t = ss.back();
    e->text = t.text;
    /* the distance string ends 24 bytes before the text: unit, a f64 and
     * the text's union header */
    if (ss.size() >= 2 && t.start >= 24 && ss[ss.size() - 2].end == t.start - 24) {
        e->distance = ss[ss.size() - 2].text;
        e->unit = u32_at(d + t.start - 24);
    }
    /* 40 bytes on, after a group that is u32 4, u32 1 at 20: the direction;
     * a roundabout's exit angle and number instead, their u32 and its own
     * u32 4, u32 1 three bytes later */
    const uint8_t *g = d + t.end;
    if (t.end + 44 > n || u32_at(g + 20) != 4 || u32_at(g + 24) != 1)
        return;
    if (e->kind != kRouteBoxRoundabout) {
        e->direction = u32_at(g + 40);
    } else if (t.end + 55 <= n && u32_at(g + 47) == 4 && u32_at(g + 51) == 1) {
        e->exit_angle = (uint16_t)(g[40] << 8 | g[41]);
        e->exit_number = g[42];
        e->direction = u32_at(g + 43);
    }
}

bool blank(const std::string &s)
{
    return s.find_first_not_of(' ') == std::string::npos;
}

/* The road as the card shows it: the ends' spaces dropped, and two names the
 * navigation puts two spaces between ("Cidade A  Cidade B") joined by a
 * middle dot. */
std::string road_text(const std::string &t)
{
    const size_t a = t.find_first_not_of(' ');
    if (a == std::string::npos)
        return std::string();
    const size_t b = t.find_last_not_of(' ');
    std::string out;
    for (size_t i = a; i <= b; i++) {
        if (t[i] == ' ' && t[i + 1] == ' ') {
            while (t[i + 1] == ' ')
                i++;
            out += " \xC2\xB7 ";
        } else {
            out += t[i];
        }
    }
    return out;
}

}  // namespace

bool parse_route_box(const uint8_t *p, size_t n, const std::string &screen, std::vector<RouteBoxEvent> *out)
{
    out->clear();
    if (!p || screen.empty())
        return false;
    const size_t len = screen.size() + 4;   /* the name's string: BOM, name, NUL */
    for (size_t i = 0; n >= 4 + len && i <= n - 4 - len; i++) {
        if (u32_at(p + i) != len || p[i + 4] != 0xEF || p[i + 5] != 0xBB || p[i + 6] != 0xBF ||
            p[i + 3 + len] != 0 || std::memcmp(p + i + 7, screen.data(), screen.size()) != 0)
            continue;
        /* the screen's header: u32, u32, u32, u8, then the events' bytes */
        const size_t h = i + 4 + len;
        if (n - h < 17)
            return true;
        size_t q = h + 17;
        const uint32_t bytes = u32_at(p + h + 13);
        const size_t end = bytes <= n - q ? q + bytes : n;
        while (end - q >= 8 && out->size() < kMaxEvents) {
            const uint32_t elen = u32_at(p + q), kind = u32_at(p + q + 4);
            if (elen > end - q - 8)
                break;   /* cut short, or not an event */
            RouteBoxEvent e;
            e.kind = kind;
            if (kind != kRouteBoxEmpty)
                read_event(p + q + 8, elen, &e);   /* by its kind */
            out->push_back(e);
            q += 8 + elen;
        }
        return true;
    }
    return false;
}

Maneuver::Kind kind_of_event(uint32_t kind, uint32_t direction)
{
    if (kind == kRouteBoxEmpty)
        return Maneuver::None;
    if (kind == kRouteBoxTurn) {
        switch (direction) {
        case 1: return Maneuver::Straight;
        case 2: return Maneuver::Left;
        case 3: return Maneuver::SlightLeft;
        case 4: return Maneuver::SharpLeft;
        case 5: return Maneuver::Right;
        case 6: return Maneuver::SlightRight;
        case 7: return Maneuver::SharpRight;
        case 8:   /* carplay's U-turns, not seen in the route box yet */
        case 9: return Maneuver::UTurn;   /* a U-turn where traffic keeps right */
        default: return Maneuver::Other;
        }
    }
    if (kind == kRouteBoxFork)
        return direction == 1 ? Maneuver::KeepLeft : direction == 2 ? Maneuver::KeepRight : Maneuver::Other;
    /* drawn anticlockwise: where traffic keeps right only */
    if (kind == kRouteBoxRoundabout)
        return direction == 2 ? Maneuver::Roundabout : Maneuver::Other;
    if (kind == kRouteBoxDestination)
        return direction == 1 ? Maneuver::ArriveLeft : direction == 3 ? Maneuver::ArriveRight : Maneuver::Arrive;
    return Maneuver::Other;
}

bool event_known(uint32_t kind, uint32_t direction)
{
    if (kind == kRouteBoxEmpty)
        return true;
    if (kind == kRouteBoxDestination)
        return direction >= 1 && direction <= 3;
    return kind_of_event(kind, direction) != Maneuver::Other;
}

std::string route_box_distance(const std::string &distance, uint32_t unit)
{
    if (blank(distance))
        return std::string();
    return unit == 4 ? distance + " m" : unit == 1 ? distance + " km" : distance;
}

bool unit_known(uint32_t unit)
{
    return unit == 0 || unit == 1 || unit == 4;
}

bool route_box_maneuver(const std::vector<RouteBoxEvent> &events, Maneuver *out)
{
    bool any = false;
    for (const RouteBoxEvent &e : events)
        any = any || e.kind != kRouteBoxEmpty;
    if (!any) {
        *out = Maneuver();
        return true;
    }
    const RouteBoxEvent &e = events.front();
    if (e.kind == kRouteBoxEmpty)
        return false;
    Maneuver m;
    m.kind = kind_of_event(e.kind, e.direction);
    if (m.kind == Maneuver::Roundabout) {
        if (e.exit_angle >= 1 && e.exit_angle <= 360)
            m.exit_deg = e.exit_angle > 180 ? e.exit_angle - 360 : e.exit_angle;
        else
            m.kind = Maneuver::Other;
    }
    m.distance = route_box_distance(e.distance, e.unit);
    m.road = road_text(e.text);
    *out = m;
    return true;
}

}  // namespace woc
