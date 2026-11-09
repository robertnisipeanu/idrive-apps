// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
#include "hud_draw.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace woc {

namespace {

struct P {
    float x, y;
};

float clamp01(float v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

void plot(Gray *g, int x, int y, float cov)
{
    if (x < 0 || y < 0 || x >= (int)g->w || y >= (int)g->h || cov <= 0)
        return;
    uint8_t &p = g->px[(size_t)y * g->w + x];
    const uint8_t v = (uint8_t)std::lround(clamp01(cov) * 255);
    if (v > p)
        p = v;
}

/* A stroke a to b with round caps, r pixels from its centre line. */
void segment(Gray *g, P a, P b, float r, float level = 1)
{
    const int x0 = (int)std::floor(std::min(a.x, b.x) - r - 1), x1 = (int)std::ceil(std::max(a.x, b.x) + r + 1);
    const int y0 = (int)std::floor(std::min(a.y, b.y) - r - 1), y1 = (int)std::ceil(std::max(a.y, b.y) + r + 1);
    const float dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    for (int y = std::max(y0, 0); y <= std::min(y1, (int)g->h - 1); y++)
        for (int x = std::max(x0, 0); x <= std::min(x1, (int)g->w - 1); x++) {
            const float px = x + 0.5f - a.x, py = y + 0.5f - a.y;
            const float t = len2 > 0 ? clamp01((px * dx + py * dy) / len2) : 0;
            const float ex = px - t * dx, ey = py - t * dy;
            plot(g, x, y, (r + 0.5f - std::sqrt(ex * ex + ey * ey)) * level);
        }
}

void triangle(Gray *g, P a, P b, P c)
{
    const float area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (area < 0)
        std::swap(b, c);
    const P v[3] = {a, b, c};
    const int x0 = (int)std::floor(std::min({a.x, b.x, c.x})) - 1, x1 = (int)std::ceil(std::max({a.x, b.x, c.x})) + 1;
    const int y0 = (int)std::floor(std::min({a.y, b.y, c.y})) - 1, y1 = (int)std::ceil(std::max({a.y, b.y, c.y})) + 1;
    for (int y = std::max(y0, 0); y <= std::min(y1, (int)g->h - 1); y++)
        for (int x = std::max(x0, 0); x <= std::min(x1, (int)g->w - 1); x++) {
            float m = 1e9f;
            for (int i = 0; i < 3; i++) {
                const P p = v[i], q = v[(i + 1) % 3];
                const float ex = q.x - p.x, ey = q.y - p.y, len = std::sqrt(ex * ex + ey * ey);
                if (len <= 0)
                    continue;
                /* inside is to the left of each edge in y-down space */
                m = std::min(m, ((x + 0.5f - p.x) * ey - (y + 0.5f - p.y) * ex) / -len);
            }
            plot(g, x, y, m + 0.5f);
        }
}

void ring(Gray *g, P c, float radius, float r)
{
    const int x0 = (int)(c.x - radius - r - 1), x1 = (int)(c.x + radius + r + 1);
    const int y0 = (int)(c.y - radius - r - 1), y1 = (int)(c.y + radius + r + 1);
    for (int y = std::max(y0, 0); y <= std::min(y1, (int)g->h - 1); y++)
        for (int x = std::max(x0, 0); x <= std::min(x1, (int)g->w - 1); x++) {
            const float dx = x + 0.5f - c.x, dy = y + 0.5f - c.y;
            plot(g, x, y, r + 0.5f - std::fabs(std::sqrt(dx * dx + dy * dy) - radius));
        }
}

/* Unit square (0-100, y down) to pixels; mirrored for the left-hand forms. */
struct Pen {
    Gray *g;
    float x, y, s;
    bool mirror;
    P at(float u, float v) const { return P{x + (mirror ? 100 - u : u) * s / 100, y + v * s / 100}; }
    float len(float u) const { return u * s / 100; }

    void line(std::vector<P> pts, float w = 11, float level = 1) const
    {
        for (size_t i = 0; i + 1 < pts.size(); i++)
            segment(g, at(pts[i].x, pts[i].y), at(pts[i + 1].x, pts[i + 1].y), len(w) / 2, level);
    }
    /* A stroke along pts whose last point is the head's tip. */
    void arrow(std::vector<P> pts) const
    {
        const P tip = pts.back(), from = pts[pts.size() - 2];
        float dx = tip.x - from.x, dy = tip.y - from.y;
        const float l = std::sqrt(dx * dx + dy * dy);
        dx /= l;
        dy /= l;
        const float head = 26, half = 21;
        pts.back() = P{tip.x - dx * head * 0.7f, tip.y - dy * head * 0.7f};
        line(pts);
        const P base{tip.x - dx * head, tip.y - dy * head};
        triangle(g, at(tip.x, tip.y), at(base.x - dy * half, base.y + dx * half), at(base.x + dy * half, base.y - dx * half));
    }
};

/* The stroke font: polylines on a grid 0-4 wide (m 0-6) and 0-8 tall, the
 * digits' height; a single point is a dot. */
struct Glyph {
    char c;
    float advance;
    std::vector<std::vector<P>> strokes;
};

const std::vector<Glyph> &font()
{
    static const std::vector<Glyph> f = {
        {'0', 4, {{{0, 0}, {4, 0}, {4, 8}, {0, 8}, {0, 0}}}},
        {'1', 4, {{{1, 1.5f}, {2.5f, 0}, {2.5f, 8}}}},
        {'2', 4, {{{0, 0}, {4, 0}, {4, 4}, {0, 4}, {0, 8}, {4, 8}}}},
        {'3', 4, {{{0, 0}, {4, 0}, {4, 8}, {0, 8}}, {{1, 4}, {4, 4}}}},
        {'4', 4, {{{0, 0}, {0, 5}, {4, 5}}, {{3, 2}, {3, 8}}}},
        {'5', 4, {{{4, 0}, {0, 0}, {0, 4}, {4, 4}, {4, 8}, {0, 8}}}},
        {'6', 4, {{{4, 0}, {0, 0}, {0, 8}, {4, 8}, {4, 4}, {0, 4}}}},
        {'7', 4, {{{0, 0}, {4, 0}, {1.5f, 8}}}},
        {'8', 4, {{{0, 0}, {4, 0}, {4, 8}, {0, 8}, {0, 0}}, {{0, 4}, {4, 4}}}},
        {'9', 4, {{{4, 4}, {0, 4}, {0, 0}, {4, 0}, {4, 8}, {0, 8}}}},
        {'.', 1, {{{0.5f, 8}}}},
        {',', 1, {{{0.8f, 7.6f}, {0.2f, 9.2f}}}},
        {'m', 6, {{{0, 8}, {0, 4}, {6, 4}, {6, 8}}, {{3, 4}, {3, 8}}}},
        {'k', 3.5f, {{{0, 0}, {0, 8}}, {{3.5f, 4}, {0, 6}}, {{1.2f, 5.3f}, {3.5f, 8}}}},
        {'f', 3, {{{3, 0}, {1.5f, 0}, {1, 1}, {1, 8}}, {{0, 4}, {3, 4}}}},
        {'t', 3, {{{1, 1}, {1, 8}, {3, 8}}, {{0, 4}, {3, 4}}}},
        {'i', 1, {{{0.5f, 4}, {0.5f, 8}}, {{0.5f, 1.5f}}}},
        {' ', 1, {}},
    };
    return f;
}

const Glyph *glyph(char c)
{
    for (const Glyph &g : font())
        if (g.c == c)
            return &g;
    return nullptr;
}

const float kStroke = 1.3f;   /* font units */

}  // namespace

const std::vector<std::string> &maneuver_labels()
{
    static const std::vector<std::string> l = {
        "straight",   "slight_left",  "left",         "sharp_left",   "slight_right", "right",
        "sharp_right", "uturn_left",  "uturn_right",  "keep_left",    "keep_right",   "merge",
        "arrive",     "roundabout_1", "roundabout_2", "roundabout_3"};
    return l;
}

bool maneuver_known(const std::string &label)
{
    if (label.compare(0, 11, "roundabout_") == 0)
        return label.size() == 12 && label[11] >= '1' && label[11] <= '9';
    return std::find(maneuver_labels().begin(), maneuver_labels().end(), label) != maneuver_labels().end();
}

bool draw_maneuver(Gray *g, const std::string &label, float x, float y, float size)
{
    if (!maneuver_known(label))
        return false;
    const bool left = label.find("left") != std::string::npos;
    std::string base = label;
    if (left)
        base.replace(base.find("left"), 4, "right");
    Pen pen{g, x, y, size, left};
    /* BMW's HUD style: the route white and thick, the other roads of the
     * junction thin and grey, a flat-based head. */
    if (base == "straight") {
        pen.line({{18, 50}, {82, 50}}, 6, 0.45f);
        pen.arrow({{50, 95}, {50, 5}});
    } else if (base == "slight_right") {
        pen.line({{40, 58}, {40, 6}}, 6, 0.45f);
        pen.arrow({{40, 95}, {40, 58}, {78, 14}});
    } else if (base == "right") {
        pen.line({{30, 46}, {30, 4}}, 6, 0.45f);
        pen.arrow({{30, 95}, {30, 46}, {94, 46}});
    } else if (base == "sharp_right") {
        pen.line({{30, 46}, {30, 4}}, 6, 0.45f);
        pen.arrow({{30, 95}, {30, 22}, {84, 80}});
    } else if (base == "uturn_right") {
        std::vector<P> pts{{28, 95}, {28, 46}};
        for (int i = 1; i <= 8; i++) {
            const float a = 3.14159265f * i / 8;
            pts.push_back(P{50 - 22 * std::cos(a), 46 - 26 * std::sin(a)});
        }
        pts.push_back(P{72, 92});
        pen.arrow(pts);
    } else if (base == "keep_right") {
        pen.line({{42, 95}, {42, 58}, {18, 24}}, 7, 0.5f);
        pen.arrow({{42, 95}, {42, 58}, {72, 12}});
    } else if (base == "merge") {
        pen.line({{20, 95}, {50, 52}}, 8, 0.6f);
        pen.line({{80, 95}, {50, 52}}, 11);
        pen.arrow({{50, 55}, {50, 5}});
    } else if (base == "arrive") {
        ring(g, pen.at(50, 36), pen.len(24), pen.len(5.5f));
        segment(g, pen.at(50, 62), pen.at(50, 95), pen.len(5.5f));
        segment(g, pen.at(50, 36), pen.at(50, 36), pen.len(7));
    } else {   /* roundabout_N */
        const int n = label[11] - '0';
        ring(g, pen.at(50, 52), pen.len(22), pen.len(4.5f));
        pen.line({{50, 97}, {50, 74}});
        if (n == 1)
            pen.arrow({{72, 52}, {99, 52}});
        else if (n == 2)
            pen.arrow({{50, 30}, {50, 1}});
        else
            pen.arrow({{28, 52}, {1, 52}});
        const std::string digit(1, (char)('0' + n));
        draw_text(g, digit, pen.at(50, 52).x - text_width(digit, pen.len(18)) / 2, pen.at(50, 43).y, pen.len(18));
    }
    return true;
}

float text_width(const std::string &text, float height)
{
    const float u = height / 8;
    float w = 0;
    for (size_t i = 0; i < text.size(); i++) {
        const Glyph *gl = glyph(text[i]);
        w += ((gl ? gl->advance : 4) + (i + 1 < text.size() ? 2 : 0)) * u;
    }
    return w + kStroke * u;
}

float draw_text(Gray *g, const std::string &text, float x, float y, float height)
{
    const float u = height / 8, r = kStroke * u / 2;
    float cx = x + r;
    for (char c : text) {
        const Glyph *gl = glyph(c);
        if (!gl) {
            cx += 6 * u;
            continue;
        }
        for (const std::vector<P> &s : gl->strokes)
            for (size_t i = 0; i < s.size(); i++) {
                const P a{cx + s[i].x * u, y + r + s[i].y * u * (height - 2 * r) / height};
                const P b = i + 1 < s.size() ? P{cx + s[i + 1].x * u, y + r + s[i + 1].y * u * (height - 2 * r) / height} : a;
                if (i + 1 < s.size() || s.size() == 1)
                    segment(g, a, b, s.size() == 1 ? r * 1.25f : r);
            }
        cx += (gl->advance + 2) * u;
    }
    return cx - x;
}

}  // namespace woc
