// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* The arrow reader of the HUD arrows (README.md "HUD arrows"): the
 * CardReader below reads the card's icon with it. It was written for the
 * white arrow Waze draws on the route at the next junction (Waze's cluster
 * stream has no instruction card, seen on the car 2026-11-03), and reads an
 * arrow in any luma plane:
 *
 * The luma at or above min_luma, below the top 15% of the frame, is opened
 * (3x3: drops the chevron's 1-2 px white rim and thin text strokes) and
 * split into 8-connected parts. The arrow is the part with the most pixels
 * whose whole 7x7 neighbourhood is white (a thick stroke; text and labels
 * have none) that is not a filled box (road shields), within size limits.
 * Its two farthest-apart ends (geodesic, inside the part) are the stem and
 * the tip; the stem is the end nearer the car. The turn is the signed angle
 * between the stem's direction (stem to 30% along) and the tip's (70% to
 * the tip), right positive, named by turn_label(). The distance is not on
 * screen, so a reading has none. */
#ifndef WOC_HUD_MAPARROW_H
#define WOC_HUD_MAPARROW_H

#include <stdint.h>
#include <string>
#include <vector>

#include "hud_banner.h"

namespace woc {

struct MapArrowConfig {
    unsigned car_x = 544, car_y = 360;   /* the chevron, in frame pixels */
    unsigned min_luma = 235;
    unsigned skip_top_pct = 15;   /* Waze's labels and the sky */
};

/* straight, slight_*, left/right, sharp_*, uturn_left (any turn past 165
 * degrees: right-hand traffic) for a signed angle in degrees; slight below
 * slight_max. */
std::string turn_label(float deg, float slight_max = 45);

class MapArrowReader {
public:
    explicit MapArrowReader(const MapArrowConfig &c) : c_(c) {}
    /* The w x h luma plane (stride w). */
    Reading read(const uint8_t *y, unsigned w, unsigned h);
    /* The last arrow's angle, for the probe; 0 with none. */
    float angle() const { return angle_; }

private:
    MapArrowConfig c_;
    float angle_ = 0;
    std::vector<uint8_t> m_, e_;
    std::vector<uint32_t> ii_;
    std::vector<int> lab_, q_, dist_;
};

/* The manoeuvre card iOS draws on the centre screen (CarPlay's guidance
 * panel, seen on the car 2026-11-03: Waze's arrow icon, the distance in SF
 * Pro Bold, the street), read from the centre screen's luma. The card is
 * there when `plain` (a rect of the card right of the text) is flat. Its
 * icon is binarised (day or night alike) and read as an arrow (the
 * MapArrowReader, the stem the end nearer the icon's bottom centre): no icon
 * templates. Its distance is read with glyph templates (dist-*.pgm, made by
 * tools/hud_font_templates.py); unknown glyphs leave the distance out. */
struct CardConfig {
    Rect icon{150, 26, 85, 90}, dist{236, 40, 320, 60}, plain{580, 30, 80, 80};
};

class CardReader {
public:
    CardReader(const CardConfig &c, const Templates *t) : c_(c), rec_(t, c.icon, c.dist) {}
    Reading read(const uint8_t *y, unsigned w, unsigned h);
    float angle() const { return angle_; }
    const std::string &text() const { return text_; }   /* the distance's glyphs as read */

private:
    CardConfig c_;
    Recogniser rec_;
    float angle_ = 0;
    std::string text_;
};

}  // namespace woc

#endif
