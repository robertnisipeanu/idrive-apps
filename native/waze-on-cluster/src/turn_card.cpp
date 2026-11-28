// SPDX-License-Identifier: GPL-3.0-or-later
#include "turn_card.h"

#include <cmath>
#include <cstring>

#include "card_font.h"

namespace woc {

namespace {

const float kPi = 3.14159265f;

struct Canvas {
    std::vector<uint8_t> *px;
    unsigned h;   /* rows: kTurnCardH, or kTurnCardCompactH */

    /* colour over what is there, at coverage a (0-1). */
    void blend(int x, int y, uint8_t r, uint8_t g, uint8_t b, float a)
    {
        if (x < 0 || y < 0 || x >= (int)kTurnCardW || y >= (int)h || a <= 0)
            return;
        if (a > 1)
            a = 1;
        uint8_t *p = &(*px)[((size_t)y * kTurnCardW + x) * 4];
        const float da = p[3] / 255.0f, oa = a + da * (1 - a);
        const uint8_t c[3] = {r, g, b};
        for (int i = 0; i < 3; i++)
            p[i] = (uint8_t)std::lround((c[i] * a + p[i] * da * (1 - a)) / oa);
        p[3] = (uint8_t)std::lround(oa * 255);
    }
};

struct Pt {
    float x, y;
};

float dist(Pt a, Pt b)
{
    return std::sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

float seg_dist(float px, float py, Pt a, Pt b)
{
    const float vx = b.x - a.x, vy = b.y - a.y, wx = px - a.x, wy = py - a.y;
    const float len2 = vx * vx + vy * vy;
    float t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const float dx = px - (a.x + t * vx), dy = py - (a.y + t * vy);
    return std::sqrt(dx * dx + dy * dy);
}

/* Coverage of an edge at signed distance d inside (positive) it. */
float edge(float d)
{
    return d <= -0.5f ? 0 : d >= 0.5f ? 1 : d + 0.5f;
}

/* A compass bearing (degrees clockwise from up) as a unit vector, y down. */
Pt bearing(float deg)
{
    return {std::sin(deg * kPi / 180), -std::cos(deg * kPi / 180)};
}

/* An icon in a 48x48 square, as for traffic on the right: strokes (round
 * capped), arrow heads, arcs, rectangles and discs, each white (the way to
 * go) or grey (a road not taken). */
struct Icon {
    struct Stroke {
        std::vector<Pt> pts;
        float half;
        bool grey;
    };
    struct Head {
        Pt tip, a, b;
    };
    struct Arc {
        Pt c;
        float r, half;
        float from, to;   /* bearings: the arc covers from..to clockwise */
        bool grey;
    };
    struct Box {
        float x0, y0, x1, y1;
        bool grey;
    };
    struct Disc {
        Pt c;
        float r;
    };
    std::vector<Stroke> strokes;
    std::vector<Head> heads;
    std::vector<Arc> arcs;
    std::vector<Box> boxes;
    std::vector<Disc> discs;
};

const float kHalf = 3.7f;      /* half the shaft's width */
const float kHeadLen = 12.5f;  /* base to tip */
const float kHeadHalf = 9.5f;  /* half the head's base */

/* pts as one path, each corner rounded into a curve of radius r (at most
 * half of either side). */
std::vector<Pt> rounded(const std::vector<Pt> &p, float r)
{
    std::vector<Pt> out;
    if (p.empty())
        return out;
    out.push_back(p[0]);
    for (size_t i = 1; i + 1 < p.size(); i++) {
        const Pt a = p[i - 1], b = p[i], c = p[i + 1];
        const float l1 = dist(a, b), l2 = dist(b, c);
        if (l1 <= 0 || l2 <= 0)
            continue;
        const float r1 = r < l1 / 2 ? r : l1 / 2, r2 = r < l2 / 2 ? r : l2 / 2;
        const Pt s = {b.x - (b.x - a.x) / l1 * r1, b.y - (b.y - a.y) / l1 * r1};
        const Pt e = {b.x + (c.x - b.x) / l2 * r2, b.y + (c.y - b.y) / l2 * r2};
        for (int k = 0; k <= 10; k++) {
            const float t = k / 10.0f, u = 1 - t;
            out.push_back({u * u * s.x + 2 * u * t * b.x + t * t * e.x, u * u * s.y + 2 * u * t * b.y + t * t * e.y});
        }
    }
    out.push_back(p.back());
    return out;
}

/* A white shaft along pts (corners rounded by r) and a head past its end. */
void arrow(Icon *ic, const std::vector<Pt> &pts, float r)
{
    const std::vector<Pt> path = rounded(pts, r);
    ic->strokes.push_back({path, kHalf, false});
    const Pt b = path.back(), a = path[path.size() - 2];
    const float l = dist(a, b);
    const Pt u = {(b.x - a.x) / l, (b.y - a.y) / l};
    ic->heads.push_back({{b.x + u.x * kHeadLen, b.y + u.y * kHeadLen},
                         {b.x - u.y * kHeadHalf, b.y + u.x * kHeadHalf},
                         {b.x + u.y * kHeadHalf, b.y - u.x * kHeadHalf}});
}

/* The roundabout: the ring grey, the way round it white from its foot
 * anticlockwise to the exit, the exit's arm and head along bearing exit. */
void roundabout(Icon *ic, int exit_deg)
{
    const Pt c = {24, 25};
    const float r = 10, ring = 2.6f;
    float e = (float)exit_deg;
    if (e > 180 || e <= -180)
        e = std::fmod(std::fmod(e + 180, 360.0f) + 360, 360.0f) - 180;
    /* the exit kept clear of the way in: the sharpest right at 140, back
     * (anticlockwise, all but round) down to the left of it */
    if (e > 140)
        e = e >= 165 ? -135 : 140;
    if (e < -135)
        e = -135;
    ic->arcs.push_back({c, r, ring, 0, 360, true});
    ic->strokes.push_back({{{24, 47}, {24, c.y + r}}, kHalf, false});
    /* anticlockwise from the foot (bearing 180) down to e */
    ic->arcs.push_back({c, r, ring, e, 180, false});
    const Pt u = bearing(e);
    const Pt s = {c.x + u.x * r, c.y + u.y * r}, b = {c.x + u.x * (r + 3), c.y + u.y * (r + 3)};
    ic->strokes.push_back({{s, b}, kHalf, false});
    ic->heads.push_back({{b.x + u.x * (kHeadLen - 2), b.y + u.y * (kHeadLen - 2)},
                         {b.x - u.y * (kHeadHalf - 1), b.y + u.x * (kHeadHalf - 1)},
                         {b.x + u.y * (kHeadHalf - 1), b.y - u.x * (kHeadHalf - 1)}});
}

/* The destination: a chequered flag on its pole, the pole at x. */
void flag(Icon *ic, float x)
{
    ic->strokes.push_back({{{x, 46}, {x, 6}}, 2.0f, false});
    const float x0 = x + 2, y0 = 6, cw = 5, ch = 5;
    for (int row = 0; row < 3; row++)
        for (int col = 0; col < 4; col++)
            ic->boxes.push_back({x0 + col * cw, y0 + row * ch, x0 + (col + 1) * cw, y0 + (row + 1) * ch,
                                 (row + col) % 2 == 1});
}

/* The icon of m as for traffic on the right, and whether it is drawn
 * mirrored (a left-hand kind: its right-hand one). */
Icon icon_of(const Maneuver &m, bool *mirror)
{
    Icon ic;
    *mirror = false;
    switch (m.kind) {
    case Maneuver::SlightLeft:
    case Maneuver::Left:
    case Maneuver::SharpLeft:
    case Maneuver::KeepLeft:
    case Maneuver::ExitLeft:
    case Maneuver::UTurnRight:
    case Maneuver::ArriveLeft:
        *mirror = true;
        break;
    default:
        break;
    }
    switch (m.kind) {
    case Maneuver::Straight: arrow(&ic, {{24, 47}, {24, 15}}, 0); break;
    case Maneuver::SlightLeft:
    case Maneuver::SlightRight: arrow(&ic, {{18, 47}, {18, 31}, {29, 20}}, 9); break;
    case Maneuver::Left:
    case Maneuver::Right: arrow(&ic, {{17, 47}, {17, 23}, {31, 23}}, 9); break;
    case Maneuver::SharpLeft:
    case Maneuver::SharpRight: arrow(&ic, {{14, 47}, {14, 13}, {30, 27}}, 10); break;
    /* back over the left; mirrored, over the right */
    case Maneuver::UTurn:
    case Maneuver::UTurnRight: arrow(&ic, {{32, 47}, {32, 12}, {15, 12}, {15, 27}}, 8); break;
    case Maneuver::KeepLeft:
    case Maneuver::KeepRight:
        ic.strokes.push_back({rounded({{20, 47}, {20, 33}, {14, 22}, {14, 4}}, 7), kHalf, true});
        arrow(&ic, {{20, 47}, {20, 33}, {30, 23}, {30, 15}}, 8);
        break;
    case Maneuver::ExitLeft:
    case Maneuver::ExitRight:
        ic.strokes.push_back({{{19, 47}, {19, 3}}, kHalf, true});
        arrow(&ic, {{19, 47}, {19, 30}, {29, 20}}, 9);
        break;
    case Maneuver::Roundabout: roundabout(&ic, m.exit_deg); break;
    case Maneuver::Arrive: flag(&ic, 15); break;
    /* the flag at the road's side: mirrored, on the left */
    case Maneuver::ArriveLeft:
    case Maneuver::ArriveRight:
        ic.strokes.push_back({{{12, 47}, {12, 4}}, kHalf, true});
        flag(&ic, 24);
        break;
    case Maneuver::Other:
        /* no direction to tell: a dot in the middle, no stroke */
        ic.discs.push_back({{24, 24}, 7});
        break;
    case Maneuver::None: break;
    }
    return ic;
}

/* inside distance of p to a triangle (positive inside) */
float tri_in(float fx, float fy, const Pt t[3])
{
    /* the winding decides which side is in */
    const float area = (t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[1].y - t[0].y) * (t[2].x - t[0].x);
    float in = 1e9f;
    for (int i = 0; i < 3; i++) {
        const Pt p = t[i], q = t[(i + 1) % 3];
        const float ex = q.x - p.x, ey = q.y - p.y, el = std::sqrt(ex * ex + ey * ey);
        float s = ((fx - p.x) * ey - (fy - p.y) * ex) / el;
        if (area > 0)
            s = -s;
        in = s < in ? s : in;
    }
    return in;
}

/* the arc's signed inside distance at (fx, fy), in the icon's units: the
 * ring's band within from..to, round capped at both ends */
float arc_in(float fx, float fy, const Icon::Arc &a)
{
    const float dx = fx - a.c.x, dy = fy - a.c.y;
    float b = std::atan2(dx, -dy) * 180 / kPi;   /* bearing of the pixel */
    float span = a.to - a.from;
    if (span >= 360)
        return a.half - std::fabs(std::sqrt(dx * dx + dy * dy) - a.r);
    while (b < a.from)
        b += 360;
    while (b >= a.from + 360)
        b -= 360;
    if (b <= a.from + span)
        return a.half - std::fabs(std::sqrt(dx * dx + dy * dy) - a.r);
    const Pt p0 = {a.c.x + bearing(a.from).x * a.r, a.c.y + bearing(a.from).y * a.r};
    const Pt p1 = {a.c.x + bearing(a.to).x * a.r, a.c.y + bearing(a.to).y * a.r};
    const float d0 = dist({fx, fy}, p0), d1 = dist({fx, fy}, p1);
    return a.half - (d0 < d1 ? d0 : d1);
}

/* m's icon, drawn size x size pixels (48: the icon's own units) at ox, oy:
 * each pixel's centre taken back to the 48x48 drawing, and each edge's
 * distance to pixels again, so a smaller icon stays as smooth. */
void draw_icon(Canvas *c, const Maneuver &m, int ox, int oy, int size)
{
    bool mirror = false;
    const Icon ic = icon_of(m, &mirror);
    const float k = size / 48.0f;   /* pixels per unit of the drawing */
    for (int y = 0; y < size; y++) {
        for (int x = 0; x < size; x++) {
            /* the pixel's centre, in the right-hand drawing */
            const float ux = (x + 0.5f) / k, fy = (y + 0.5f) / k;
            const float fx = mirror ? 48 - ux : ux;
            float white = 0, grey = 0;
            for (const Icon::Stroke &s : ic.strokes) {
                float d = 1e9f;
                for (size_t i = 0; i + 1 < s.pts.size(); i++) {
                    const float sd = seg_dist(fx, fy, s.pts[i], s.pts[i + 1]);
                    d = sd < d ? sd : d;
                }
                const float cov = edge((s.half - d) * k);
                float &dst = s.grey ? grey : white;
                dst = cov > dst ? cov : dst;
            }
            for (const Icon::Head &h : ic.heads) {
                const Pt t[3] = {h.tip, h.a, h.b};
                const float cov = edge(tri_in(fx, fy, t) * k);
                white = cov > white ? cov : white;
            }
            for (const Icon::Arc &a : ic.arcs) {
                const float cov = edge(arc_in(fx, fy, a) * k);
                float &dst = a.grey ? grey : white;
                dst = cov > dst ? cov : dst;
            }
            for (const Icon::Box &b : ic.boxes) {
                float in = fx - b.x0;
                in = b.x1 - fx < in ? b.x1 - fx : in;
                in = fy - b.y0 < in ? fy - b.y0 : in;
                in = b.y1 - fy < in ? b.y1 - fy : in;
                const float cov = edge(in * k);
                float &dst = b.grey ? grey : white;
                dst = cov > dst ? cov : dst;
            }
            for (const Icon::Disc &d : ic.discs) {
                const float cov = edge((d.r - dist({fx, fy}, d.c)) * k);
                white = cov > white ? cov : white;
            }
            /* grey under white: a road not taken shows only where the way
             * to go does not */
            if (grey > 0)
                c->blend(ox + x, oy + y, 118, 126, 140, grey);
            if (white > 0)
                c->blend(ox + x, oy + y, 255, 255, 255, white);
        }
    }
}

/* runs of f with the pen at x, the baseline at y */
void draw_line(Canvas *c, const CardFont &f, const std::vector<CardRun> &runs, int x, int y, uint8_t r, uint8_t g,
               uint8_t b)
{
    for (const CardRun &run : runs) {
        const CardGlyph &gl = *run.g;
        const int gx = x + (run.x16 + 8) / 16 + gl.x, gy = y + gl.y;
        for (int py = 0; py < gl.h; py++)
            for (int px = 0; px < gl.w; px++) {
                const uint8_t a = card_glyph_px(f, gl, px, py);
                if (a)
                    c->blend(gx + px, gy + py, r, g, b, a / 255.0f);
            }
    }
}

}  // namespace

bool maneuver_kind(const std::string &name, Maneuver::Kind *out)
{
    static const struct {
        const char *name;
        Maneuver::Kind kind;
    } kinds[] = {{"none", Maneuver::None},
                 {"straight", Maneuver::Straight},
                 {"slight_left", Maneuver::SlightLeft},
                 {"left", Maneuver::Left},
                 {"sharp_left", Maneuver::SharpLeft},
                 {"slight_right", Maneuver::SlightRight},
                 {"right", Maneuver::Right},
                 {"sharp_right", Maneuver::SharpRight},
                 {"uturn", Maneuver::UTurn},
                 {"uturn_right", Maneuver::UTurnRight},
                 {"keep_left", Maneuver::KeepLeft},
                 {"keep_right", Maneuver::KeepRight},
                 {"exit_left", Maneuver::ExitLeft},
                 {"exit_right", Maneuver::ExitRight},
                 {"roundabout", Maneuver::Roundabout},
                 {"arrive", Maneuver::Arrive},
                 {"arrive_left", Maneuver::ArriveLeft},
                 {"arrive_right", Maneuver::ArriveRight},
                 {"other", Maneuver::Other}};
    for (const auto &k : kinds)
        if (name == k.name) {
            *out = k.kind;
            return true;
        }
    return false;
}

void render_turn_card(const Maneuver &m, std::vector<uint8_t> *rgba, bool compact)
{
    const unsigned h = compact ? kTurnCardCompactH : kTurnCardH;
    rgba->assign((size_t)kTurnCardW * h * 4, 0);
    if (m.kind == Maneuver::None)
        return;
    Canvas c{rgba, h};
    /* the plate: dark, a little see-through, its corners rounded */
    const float rad = compact ? 10 : 12;
    for (int y = 0; y < (int)h; y++)
        for (int x = 0; x < (int)kTurnCardW; x++) {
            const float fx = x + 0.5f, fy = y + 0.5f;
            const float cx = fx < rad ? rad : fx > kTurnCardW - rad ? kTurnCardW - rad : fx;
            const float cy = fy < rad ? rad : fy > h - rad ? h - rad : fy;
            const float d = std::sqrt((fx - cx) * (fx - cx) + (fy - cy) * (fy - cy));
            c.blend(x, y, 16, 20, 28, edge(rad - d) * 0.88f);
        }
    const CardFont &df = card_font_distance(), &rf = card_font_road();
    if (compact) {
        /* one line: the arrow smaller, then the distance in bold and the
         * road after it, on one baseline */
        draw_icon(&c, m, 6, 3, 28);
        const int tx = 42, base = 25, gap = 10;
        int dw = 0;
        const std::vector<CardRun> dist = card_line(df, m.distance, (int)kTurnCardW - tx - 12, &dw);
        draw_line(&c, df, dist, tx, base, 255, 255, 255);
        const int rx = dist.empty() ? tx : tx + dw + gap;
        const std::vector<CardRun> road = card_line(rf, m.road, (int)kTurnCardW - rx - 12, nullptr);
        draw_line(&c, rf, road, rx, base, 200, 208, 220);
        return;
    }
    draw_icon(&c, m, 6, 4, 48);
    /* the text right of the arrow: the distance in bold on top, the road
     * below; the distance alone in the middle */
    const int tx = 62, room = (int)kTurnCardW - tx - 12;
    const std::vector<CardRun> dist = card_line(df, m.distance, room, nullptr);
    const std::vector<CardRun> road = card_line(rf, m.road, room, nullptr);
    if (road.empty()) {
        draw_line(&c, df, dist, tx, 37, 255, 255, 255);
    } else {
        draw_line(&c, df, dist, tx, 27, 255, 255, 255);
        draw_line(&c, rf, road, tx, 48, 200, 208, 220);
    }
}

}  // namespace woc
