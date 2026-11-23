/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Text for cluster-render layers (PROTOCOL.md "Text"), with no service
 * change, as js/cluster_render_text.js: a Font is a one-row R8 atlas of its
 * glyphs, each a whole line high, sent once as an asset; a Text is an
 * effect layer drawing a string from it, laid out here (advances, kerning,
 * alignment) and sent as a uniform array of glyph boxes and their count, so
 * changing the string sends those two uniforms alone. */
#ifndef CLUSTER_RENDER_TEXT_H
#define CLUSTER_RENDER_TEXT_H

#include <stdint.h>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "cluster_render/client.h"

namespace cr {

/* The fragment shader of a Text of at most n glyphs (GLSL ES 1.00): n + 2
 * uniform vectors. */
std::string text_fragment_shader(unsigned n);

/* The most glyphs a Text holds: its shader's 16 uniform vectors, the
 * least GLSL ES 1.00 gives a fragment shader. */
const unsigned kMaxTextGlyphs = 14;

/* A glyph given to Font::from_glyphs(): a w x h R8 bitmap, its first row
 * top pixels below the line's top, its left bearing and advance. */
struct GlyphBitmap {
    uint32_t code = 0;   /* a Unicode code point */
    unsigned w = 0, h = 0;
    int top = 0, left = 0;
    int advance = -1;   /* negative: its width */
    std::vector<uint8_t> pixels;
};

/* A glyph box of a laid-out line: x0, x1 in the line's pixels, u0, u1 in
 * the atlas's. */
struct GlyphBox {
    float x0 = 0, x1 = 0, u0 = 0, u1 = 0;
};

class Font {
public:
    /* Empty (ok() false) when the atlas would pass 2048 pixels wide or the
     * line is not 1-2048 high. */
    static Font from_glyphs(unsigned line_height, const std::vector<GlyphBitmap> &glyphs,
                            const std::map<std::pair<uint32_t, uint32_t>, int> &kerning = {});
    /* A monospace grid: pixels w x h (R8, or RGBA with bpp 4: its alpha) of
     * cols x rows cells, chars (UTF-8) the characters cell by cell; advance
     * the cells' (0: their width). */
    static Font from_grid(const uint8_t *pixels, unsigned w, unsigned h, unsigned cols, unsigned rows,
                          const std::string &chars, unsigned bpp = 1, unsigned advance = 0);
    /* An AngelCode BMFont: its text .fnt and its one page's pixels (R8, or
     * RGBA with bpp 4: its alpha). Empty for a font of several pages, of
     * glyphs packed in channels, of a glyph outside the page or of a
     * negative xadvance, width or height. */
    static Font from_bmfont(const std::string &fnt, const uint8_t *page, unsigned page_w, unsigned page_h,
                            unsigned bpp = 1);

    bool ok() const { return w_ > 0; }
    unsigned width() const { return w_; }
    unsigned line_height() const { return line_; }
    const std::vector<uint8_t> &pixels() const { return px_; }
    /* The atlas as an r8 asset on target, sampled bilinear; its ref, 0 when
     * refused here. */
    uint32_t asset(Client &c, const std::string &target) const;
    /* text (UTF-8) laid out a line h pixels high, spacing pixels between
     * characters; *width its advance, from the first character's start to
     * the last one's advance. A character the font lacks takes a space's
     * advance, or nothing. */
    std::vector<GlyphBox> layout(const std::string &text, float h, float spacing, float *width) const;

private:
    struct Glyph {
        unsigned x = 0, w = 0;
        int advance = 0, left = 0;
    };
    unsigned w_ = 0, line_ = 0;
    std::vector<uint8_t> px_;
    std::map<uint32_t, Glyph> glyphs_;
    std::map<std::pair<uint32_t, uint32_t>, int> kerning_;
};

struct TextOptions {
    float color[4] = {1, 1, 1, 1};   /* straight alpha, 0-1 */
    std::string align = "left";      /* left, center or right */
    float spacing = 0;               /* pixels between characters */
    unsigned max_glyphs = kMaxTextGlyphs;   /* the glyphs its shader holds: 1 to kMaxTextGlyphs */
};

class Text {
public:
    /* An effect layer of lo's rect drawing strings from font, whose atlas is
     * the asset atlas, a line as high as the rect. ref() 0, nothing sent,
     * when the font is empty, the rect has no width or height, or
     * to.max_glyphs is not 1 to kMaxTextGlyphs. */
    Text(Client &c, std::shared_ptr<const Font> font, uint32_t atlas, const LayerOptions &lo,
         const TextOptions &to = TextOptions());
    uint32_t ref() const { return ref_; }
    /* The string shown (UTF-8), sent as two uniforms (u_glyphs, u_count);
     * false when it has more glyphs than the layer holds or is wider than
     * its rect (it is shown cut). */
    bool set(const std::string &text);
    void color(const float rgba[4]);
    void drop();

private:
    Client &c_;
    std::shared_ptr<const Font> font_;
    LayerOptions lo_;
    TextOptions to_;
    uint32_t ref_ = 0;
};

}  // namespace cr

#endif
