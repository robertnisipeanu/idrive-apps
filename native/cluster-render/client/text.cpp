/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "cluster_render/text.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <sstream>

namespace cr {

namespace {

const unsigned kMaxAtlas = 2048;

/* The code points of UTF-8 s; a bad byte stands for itself. */
std::vector<uint32_t> code_points(const std::string &s)
{
    std::vector<uint32_t> out;
    for (size_t i = 0; i < s.size();) {
        const uint8_t b = (uint8_t)s[i];
        const int n = b < 0x80 ? 1 : (b >> 5) == 6 ? 2 : (b >> 4) == 14 ? 3 : (b >> 3) == 30 ? 4 : 1;
        uint32_t cp = n == 1 ? b : b & (0x7f >> n);
        bool good = i + n <= s.size();
        for (int k = 1; good && k < n; k++) {
            const uint8_t c = (uint8_t)s[i + k];
            good = (c >> 6) == 2;
            cp = (cp << 6) | (c & 0x3f);
        }
        out.push_back(good ? cp : b);
        i += good ? n : 1;
    }
    return out;
}

/* key=value's number in a BMFont line; 0 when absent. */
int field(const std::string &line, const char *key)
{
    const std::string k = std::string(" ") + key + "=";
    const size_t at = line.find(k);
    return at == std::string::npos ? 0 : std::atoi(line.c_str() + at + k.size());
}

}  // namespace

std::string text_fragment_shader(unsigned n)
{
    const std::string count = std::to_string(n);
    return "#version 100\n"
           "precision mediump float;\n"
           "uniform sampler2D u_atlas;\n"
           "uniform vec4 u_glyphs[" + count + "];\n"
           "uniform float u_count;\n"
           "uniform vec4 u_color;\n"
           "varying vec2 v_uv;\n"
           "void main() {\n"
           "    float a = 0.0;\n"
           "    for (int i = 0; i < " + count + "; i++) {\n"
           "        if (float(i) >= u_count) break;\n"
           "        vec4 g = u_glyphs[i];\n"
           "        if (v_uv.x >= g.x && v_uv.x < g.y) {\n"
           "            float t = (v_uv.x - g.x) / (g.y - g.x);\n"
           "            a = max(a, texture2D(u_atlas, vec2(mix(g.z, g.w, t), v_uv.y)).r);\n"
           "        }\n"
           "    }\n"
           "    gl_FragColor = vec4(u_color.rgb * u_color.a, u_color.a) * a;\n"
           "}\n";
}

Font Font::from_glyphs(unsigned line_height, const std::vector<GlyphBitmap> &glyphs,
                       const std::map<std::pair<uint32_t, uint32_t>, int> &kerning)
{
    Font f;
    if (line_height < 1 || line_height > kMaxAtlas)
        return f;
    unsigned w = 1;   /* a column of 0 between glyphs: nothing bleeds when sampled bilinear */
    for (const GlyphBitmap &g : glyphs) {
        if (g.pixels.size() < (size_t)g.w * g.h)
            return f;
        w += g.w + 1;
    }
    if (w > kMaxAtlas)
        return f;
    f.w_ = w;
    f.line_ = line_height;
    f.px_.assign((size_t)w * line_height, 0);
    f.kerning_ = kerning;
    unsigned x = 1;
    for (const GlyphBitmap &g : glyphs) {
        for (unsigned y = 0; y < g.h; y++) {
            const int row = g.top + (int)y;
            if (row >= 0 && row < (int)line_height)
                std::memcpy(&f.px_[(size_t)row * w + x], &g.pixels[(size_t)y * g.w], g.w);
        }
        Glyph &gl = f.glyphs_[g.code];
        gl.x = x;
        gl.w = g.w;
        gl.advance = g.advance < 0 ? (int)g.w : g.advance;
        gl.left = g.left;
        x += g.w + 1;
    }
    return f;
}

Font Font::from_grid(const uint8_t *pixels, unsigned w, unsigned h, unsigned cols, unsigned rows,
                     const std::string &chars, unsigned bpp, unsigned advance)
{
    const std::vector<uint32_t> cps = code_points(chars);
    if (!cols || !rows || cps.size() > (size_t)cols * rows || (bpp != 1 && bpp != 4))
        return Font();
    const unsigned cw = w / cols, ch = h / rows;
    std::vector<GlyphBitmap> glyphs;
    for (size_t i = 0; i < cps.size(); i++) {
        GlyphBitmap g;
        g.code = cps[i];
        g.w = cw;
        g.h = ch;
        g.advance = (int)(advance ? advance : cw);
        g.pixels.resize((size_t)cw * ch);
        const unsigned cx = (unsigned)(i % cols) * cw, cy = (unsigned)(i / cols) * ch;
        for (unsigned y = 0; y < ch; y++)
            for (unsigned x = 0; x < cw; x++)
                g.pixels[(size_t)y * cw + x] = pixels[((size_t)(cy + y) * w + cx + x) * bpp + bpp - 1];
        glyphs.push_back(std::move(g));
    }
    return from_glyphs(ch, glyphs);
}

Font Font::from_bmfont(const std::string &fnt, const uint8_t *page, unsigned page_w, unsigned page_h, unsigned bpp)
{
    if (bpp != 1 && bpp != 4)
        return Font();
    unsigned line_height = 0;
    std::vector<GlyphBitmap> glyphs;
    std::map<std::pair<uint32_t, uint32_t>, int> kerning;
    std::istringstream in(fnt);
    std::string line;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r')
            line.pop_back();
        if (line.compare(0, 7, "common ") == 0) {
            line_height = (unsigned)std::max(0, field(line, "lineHeight"));
            if (field(line, "pages") > 1 || field(line, "packed"))
                return Font();
        } else if (line.compare(0, 5, "char ") == 0) {
            GlyphBitmap g;
            const int chnl = field(line, "chnl");
            if (field(line, "page") || (chnl && chnl != 15))
                return Font();
            const int gx = field(line, "x"), gy = field(line, "y");
            g.code = (uint32_t)field(line, "id");
            if (field(line, "width") < 0 || field(line, "height") < 0)
                return Font();   /* malformed, as Node refuses it */
            g.w = (unsigned)field(line, "width");
            g.h = (unsigned)field(line, "height");
            g.left = field(line, "xoffset");
            g.top = field(line, "yoffset");
            g.advance = field(line, "xadvance");
            if (g.advance < 0)
                return Font();
            if (gx < 0 || gy < 0 || gx + g.w > page_w || gy + g.h > page_h)
                return Font();
            g.pixels.resize((size_t)g.w * g.h);
            for (unsigned y = 0; y < g.h; y++)
                for (unsigned x = 0; x < g.w; x++)
                    g.pixels[(size_t)y * g.w + x] = page[((size_t)(gy + y) * page_w + gx + x) * bpp + bpp - 1];
            glyphs.push_back(std::move(g));
        } else if (line.compare(0, 8, "kerning ") == 0) {
            kerning[std::make_pair((uint32_t)field(line, "first"), (uint32_t)field(line, "second"))] =
                field(line, "amount");
        }
    }
    return from_glyphs(line_height, glyphs, kerning);
}

uint32_t Font::asset(Client &c, const std::string &target) const
{
    if (!ok())
        return 0;
    AssetOptions ao;
    ao.target = target;
    ao.w = w_;
    ao.h = line_;
    ao.r8 = true;
    SamplerOptions so;
    so.sampling = "bilinear";
    const uint32_t ref = c.asset(ao, so);
    if (ref)
        c.pixels(ref, {}, px_.data(), px_.size());
    return ref;
}

std::vector<GlyphBox> Font::layout(const std::string &text, float h, float spacing, float *width) const
{
    std::vector<GlyphBox> boxes;
    const float s = line_ ? h / (float)line_ : 0;
    float x = 0;
    uint32_t prev = 0;
    bool first = true;
    for (uint32_t cp : code_points(text)) {
        if (!first) {
            auto k = kerning_.find(std::make_pair(prev, cp));
            if (k != kerning_.end())
                x += (float)k->second * s;
            x += spacing;
        }
        auto g = glyphs_.find(cp);
        if (g != glyphs_.end()) {
            if (g->second.w) {
                GlyphBox b;
                b.x0 = x + (float)g->second.left * s;
                b.x1 = b.x0 + (float)g->second.w * s;
                b.u0 = (float)g->second.x;
                b.u1 = (float)(g->second.x + g->second.w);
                boxes.push_back(b);
            }
            x += (float)g->second.advance * s;
        } else {
            auto space = glyphs_.find(32);
            if (space != glyphs_.end())
                x += (float)space->second.advance * s;
        }
        prev = cp;
        first = false;
    }
    if (width)
        *width = x;
    return boxes;
}

Text::Text(Client &c, std::shared_ptr<const Font> font, uint32_t atlas, const LayerOptions &lo,
           const TextOptions &to)
    : c_(c), font_(std::move(font)), lo_(lo), to_(to)
{
    if (!font_ || !font_->ok() || !lo_.w || !lo_.h || !to_.max_glyphs || to_.max_glyphs > kMaxTextGlyphs)
        return;
    RenderState look;
    look.blend = "premultiplied";
    ref_ = c_.effect(lo_, EffectOptions{text_fragment_shader(to_.max_glyphs), "", 0}, false, look);
    if (!ref_)
        return;
    c_.bind(ref_, "u_atlas", atlas);
    color(to_.color);
    set("");
}

bool Text::set(const std::string &text)
{
    if (!ref_)
        return false;
    const unsigned max = to_.max_glyphs;
    float width = 0;
    const std::vector<GlyphBox> boxes = font_->layout(text, (float)lo_.h, to_.spacing, &width);
    const float w = (float)lo_.w, aw = (float)font_->width();
    const float shift = to_.align == "right" ? w - width : to_.align == "center" ? (w - width) / 2 : 0;
    std::vector<float> v(max * 4, 0.0f);
    const size_t n = std::min<size_t>(boxes.size(), max);
    for (size_t i = 0; i < n; i++) {
        v[i * 4] = (boxes[i].x0 + shift) / w;
        v[i * 4 + 1] = (boxes[i].x1 + shift) / w;
        v[i * 4 + 2] = boxes[i].u0 / aw;
        v[i * 4 + 3] = boxes[i].u1 / aw;
    }
    c_.uniform(ref_, "u_glyphs", UniformType::Vec4, v);
    c_.uniform(ref_, "u_count", std::vector<float>{(float)n});
    return boxes.size() <= max && width <= w;
}

void Text::color(const float rgba[4])
{
    if (ref_)
        c_.uniform(ref_, "u_color", std::vector<float>(rgba, rgba + 4));
}

void Text::drop()
{
    if (ref_)
        c_.drop(ref_);
    ref_ = 0;
}

}  // namespace cr
