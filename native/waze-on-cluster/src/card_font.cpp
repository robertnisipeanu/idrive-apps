// SPDX-License-Identifier: GPL-3.0-or-later
#include "card_font.h"

namespace woc {

const CardGlyph *card_glyph(const CardFont &f, uint32_t cp)
{
    size_t lo = 0, hi = f.count;
    while (lo < hi) {
        const size_t mid = (lo + hi) / 2;
        if (f.glyphs[mid].cp < cp)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo < f.count && f.glyphs[lo].cp == cp ? &f.glyphs[lo] : nullptr;
}

uint8_t card_glyph_px(const CardFont &f, const CardGlyph &g, int x, int y)
{
    if (x < 0 || y < 0 || x >= g.w || y >= g.h)
        return 0;
    const size_t i = (size_t)y * g.w + x;
    const uint8_t b = f.bits[g.off + i / 2];
    const uint8_t v = i % 2 ? b & 0x0f : b >> 4;
    return (uint8_t)(v * 17);
}

std::vector<uint32_t> utf8_points(const std::string &utf8)
{
    std::vector<uint32_t> out;
    for (size_t i = 0; i < utf8.size();) {
        const unsigned char c = (unsigned char)utf8[i];
        if (c < 0x80) {
            out.push_back(c);
            i++;
            continue;
        }
        const int n = c >= 0xF8 ? 0 : c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC2 ? 2 : 0;
        uint32_t cp = n ? c & (0xFF >> (n + 1)) : 0;
        bool whole = n && i + n <= utf8.size();
        for (int k = 1; whole && k < n; k++) {
            const unsigned char t = (unsigned char)utf8[i + k];
            whole = (t & 0xC0) == 0x80;
            cp = cp << 6 | (t & 0x3F);
        }
        /* overlong, a surrogate or past U+10FFFF: not UTF-8 */
        if (whole && ((n == 3 && cp < 0x800) || (n == 4 && (cp < 0x10000 || cp > 0x10FFFF)) ||
                      (cp >= 0xD800 && cp <= 0xDFFF)))
            whole = false;
        if (!whole) {
            out.push_back(0xFFFD);
            i++;
            continue;
        }
        out.push_back(cp);
        i += n;
    }
    return out;
}

namespace {

bool blank(uint32_t cp)
{
    return cp < 0x20 || (cp >= 0x7F && cp < 0xA0) || cp == 0xA0 || cp == 0x2028 || cp == 0x2029 ||
           (cp >= 0x2000 && cp <= 0x200B) || cp == 0x202F || cp == 0x3000;
}

/* the ink's right edge or the pen's, whichever is further, in 1/16 px */
int right16(const CardRun &r)
{
    const int pen = r.x16 + r.g->adv16, ink = r.g->w ? r.x16 + (r.g->x + r.g->w) * 16 : pen;
    return ink > pen ? ink : pen;
}

}  // namespace

std::vector<CardRun> card_line(const CardFont &f, const std::string &utf8, int max_px, int *width_px)
{
    std::vector<const CardGlyph *> gl;
    bool space = true;   /* drops leading spaces and runs of them */
    for (uint32_t cp : utf8_points(utf8)) {
        if (blank(cp))
            cp = ' ';
        if (cp == ' ') {
            if (space)
                continue;
            space = true;
        } else {
            space = false;
        }
        const CardGlyph *g = card_glyph(f, cp);
        if (!g && card_fold(cp))
            g = card_glyph(f, card_fold(cp));
        if (!g)
            g = card_glyph(f, '?');
        if (g)
            gl.push_back(g);
    }
    while (!gl.empty() && gl.back()->cp == ' ')
        gl.pop_back();

    std::vector<CardRun> runs;
    int x16 = 0;
    for (const CardGlyph *g : gl) {
        runs.push_back({g, x16});
        x16 += g->adv16;
    }
    int right = runs.empty() ? 0 : right16(runs.back());
    if (right > max_px * 16) {
        /* the ellipsis, or three full stops */
        std::vector<const CardGlyph *> ell;
        if (const CardGlyph *e = card_glyph(f, 0x2026))
            ell.push_back(e);
        else if (const CardGlyph *d = card_glyph(f, '.'))
            ell.assign(3, d);
        int ell16 = 0;
        for (const CardGlyph *e : ell)
            ell16 += e->adv16;
        size_t keep = runs.size();
        while (keep > 0 && runs[keep - 1].x16 + ell16 > max_px * 16)
            keep--;
        /* the kept glyphs must end, with the ellipsis, within max_px */
        while (keep > 0 && (runs[keep - 1].g->cp == ' ' || right16(runs[keep - 1]) + ell16 > max_px * 16))
            keep--;
        runs.resize(keep);
        int pen = keep ? runs[keep - 1].x16 + runs[keep - 1].g->adv16 : 0;
        for (const CardGlyph *e : ell) {
            runs.push_back({e, pen});
            pen += e->adv16;
        }
        right = runs.empty() ? 0 : right16(runs.back());
    }
    if (width_px)
        *width_px = (right + 15) / 16;
    return runs;
}

}  // namespace woc
