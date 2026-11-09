// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* HUD drawing: the manoeuvre arrow and the distance, drawn by us as strokes
 * and triangles with anti-aliased edges (no fonts, no images), into one byte
 * of coverage a pixel. The same shapes and the same stroke font make the
 * recogniser's built-in templates (hud_banner.h), placeholders until the
 * owner's own captures replace them (README.md "HUD arrows").
 *
 * Manoeuvres are labels: straight, slight_left, left, sharp_left,
 * slight_right, right, sharp_right, uturn_left, uturn_right, keep_left,
 * keep_right, merge, arrive, roundabout_<1-9> (the exit). */
#ifndef WOC_HUD_DRAW_H
#define WOC_HUD_DRAW_H

#include <stdint.h>
#include <string>
#include <vector>

namespace woc {

/* One byte a pixel: luma, or coverage (0-255). */
struct Gray {
    unsigned w = 0, h = 0;
    std::vector<uint8_t> px;
    Gray() {}
    Gray(unsigned w_, unsigned h_, uint8_t v = 0) : w(w_), h(h_), px((size_t)w_ * h_, v) {}
};

/* Every manoeuvre label the drawing knows, roundabouts as roundabout_1-3. */
const std::vector<std::string> &maneuver_labels();
bool maneuver_known(const std::string &label);

/* The arrow for label in the size x size square at x,y (coverage, the
 * maximum of what is there). False for an unknown label. */
bool draw_maneuver(Gray *g, const std::string &label, float x, float y, float size);

/* Text in the stroke font (0-9 . , m k f t i and space), its digits height
 * px tall, from x,y (top-left); returns the advance. */
float draw_text(Gray *g, const std::string &text, float x, float y, float height);
float text_width(const std::string &text, float height);

}  // namespace woc

#endif
