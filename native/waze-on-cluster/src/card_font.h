// SPDX-License-Identifier: GPL-3.0-or-later
/* The turn card's text (turn_card.h): two fonts of antialiased glyph
 * pictures, the distance's and the road's, and the one-line layout the card
 * needs.
 *
 * The glyphs are drawn ahead of time from Roboto (tools/card_font.py writes
 * card_font_data.cpp; Apache License 2.0, LICENSES/Apache-2.0.txt), at 16
 * levels of coverage: nothing to read or rasterise on the car. The distance's
 * font has ASCII; the road's adds Latin-1, Latin Extended-A, Greek and
 * Cyrillic. A letter the font lacks is drawn as its base letter when it is
 * an accented Latin one (card_fold), anything else as '?'. */
#ifndef WOC_CARD_FONT_H
#define WOC_CARD_FONT_H

#include <stddef.h>
#include <stdint.h>

#include <string>
#include <vector>

namespace woc {

struct CardGlyph {
    uint16_t cp;     /* the code point; a font's glyphs go up by it */
    int16_t adv16;   /* the advance, in 1/16 px */
    int8_t x, y;     /* the picture's top-left from the pen on the baseline */
    uint8_t w, h;    /* the picture; 0 x 0 for a space */
    uint32_t off;    /* its first byte in the font's bits: 4-bit coverage, two
                        pixels a byte (the first in the high nibble), row after
                        row, padded to a byte at the picture's end */
};

struct CardFont {
    int px, ascent, descent;
    const CardGlyph *glyphs;
    size_t count;
    const uint8_t *bits;
};

const CardFont &card_font_distance();
const CardFont &card_font_road();

/* The glyph of cp in f, or nullptr. */
const CardGlyph *card_glyph(const CardFont &f, uint32_t cp);
/* The base letter of an accented Latin letter outside Latin-1 and Latin
 * Extended-A (Vietnamese, Latin Extended-B and Additional), or 0. */
uint32_t card_fold(uint32_t cp);
/* Coverage 0-255 of pixel (x, y) of g's picture. */
uint8_t card_glyph_px(const CardFont &f, const CardGlyph &g, int x, int y);

/* The code points of utf8; a sequence that is not UTF-8 is U+FFFD. */
std::vector<uint32_t> utf8_points(const std::string &utf8);

/* One glyph of a laid-out line, its pen at x16 (1/16 px) from the line's
 * start. */
struct CardRun {
    const CardGlyph *g;
    int x16;
};

/* utf8 as one line of f: control characters as spaces, a run of spaces as
 * one, a glyph the font lacks folded or '?'. A line wider than max_px is cut
 * at a glyph and ended with an ellipsis (U+2026; "..." where the font has
 * none), spaces before it dropped. *width_px gets the line's width. */
std::vector<CardRun> card_line(const CardFont &f, const std::string &utf8, int max_px, int *width_px);

}  // namespace woc

#endif
