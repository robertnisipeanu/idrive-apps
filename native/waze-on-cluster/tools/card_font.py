#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Writes src/card_font_data.cpp: the turn card's two fonts as antialiased
glyph pictures (card_font.h), drawn once from Roboto (Apache License 2.0,
LICENSES/Apache-2.0.txt) so the tool needs no font file or rasteriser on the
car.

    python3 tools/card_font.py Roboto-Bold.ttf Roboto-Regular.ttf > src/card_font_data.cpp

Roboto 2.137 (2017) made the committed file; Pillow draws the glyphs with
FreeType. Each glyph is cropped to its ink and kept at 16 levels, two pixels
a byte. The distance's font has ASCII and the ellipsis; the road's adds
Latin-1, Latin Extended-A (the letters of European road names), Greek,
Cyrillic, dashes and quotes; other accented Latin letters fold to their base
letter (card_fold)."""
import sys
import unicodedata

from PIL import ImageFont

DISTANCE_PX = 26
ROAD_PX = 18

ASCII = list(range(0x20, 0x7F))
EXTRA = [0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026]
DISTANCE_CHARS = ASCII + [0x2026]
GREEK = [0x386] + list(range(0x388, 0x38B)) + [0x38C] + list(range(0x38E, 0x3A2)) + list(range(0x3A3, 0x3CF))
CYRILLIC = list(range(0x400, 0x460)) + list(range(0x490, 0x4A0))
ROAD_CHARS = ASCII + list(range(0xA0, 0x100)) + list(range(0x100, 0x180)) + GREEK + CYRILLIC + EXTRA
# accented Latin letters past the fonts: Latin Extended-B and Additional
FOLDED = list(range(0x180, 0x250)) + list(range(0x1E00, 0x1F00))


def glyphs(path, px, chars):
    font = ImageFont.truetype(path, px)
    ascent, descent = font.getmetrics()
    out = []
    for cp in chars:
        ch = chr(cp)
        mask, (ox, oy) = font.getmask2(ch, mode='L')
        w, h = mask.size
        data = bytes(mask)
        # crop to the ink
        rows = [y for y in range(h) if any(data[y * w:(y + 1) * w])]
        cols = [x for x in range(w) if any(data[y * w + x] for y in range(h))]
        adv = font.getlength(ch)
        if not rows:
            out.append((cp, adv, 0, 0, 0, 0, b''))
            continue
        x0, x1, y0, y1 = cols[0], cols[-1] + 1, rows[0], rows[-1] + 1
        px4 = []
        for y in range(y0, y1):
            for x in range(x0, x1):
                px4.append((data[y * w + x] * 15 + 127) // 255)
        if len(px4) % 2:
            px4.append(0)
        packed = bytes(px4[i] << 4 | px4[i + 1] for i in range(0, len(px4), 2))
        # the picture's top-left from the pen at the baseline
        out.append((cp, adv, ox + x0, oy + y0 - ascent, x1 - x0, y1 - y0, packed))
    return ascent, descent, out


def emit(name, path, px, chars, w):
    ascent, descent, gl = glyphs(path, px, chars)
    bits = bytearray()
    w(f'const CardGlyph k{name}Glyphs[] = {{\n')
    for cp, adv, x, y, gw, gh, packed in gl:
        w(f'    {{0x{cp:04x}, {round(adv * 16)}, {x}, {y}, {gw}, {gh}, {len(bits)}}},\n')
        bits += packed
    w('};\n')
    w(f'const uint8_t k{name}Bits[] = {{\n')
    for i in range(0, len(bits), 24):
        w('    ' + ', '.join(f'0x{b:02x}' for b in bits[i:i + 24]) + ',\n')
    w('};\n')
    w(f'const CardFont k{name}Font = {{{px}, {ascent}, {descent}, k{name}Glyphs, '
      f'sizeof k{name}Glyphs / sizeof k{name}Glyphs[0], k{name}Bits}};\n\n')


def fold_table(chars):
    have = set(chars)
    out = []
    for cp in FOLDED:
        base = unicodedata.normalize('NFD', chr(cp))[0]
        if ord(base) != cp and ord(base) in have:
            out.append((cp, ord(base)))
    return out


def main():
    if len(sys.argv) != 3:
        sys.exit('usage: card_font.py Roboto-Bold.ttf Roboto-Regular.ttf > src/card_font_data.cpp')
    w = sys.stdout.write
    w('// SPDX-License-Identifier: GPL-3.0-or-later AND Apache-2.0\n')
    w('/* Written by tools/card_font.py: the turn card\'s fonts, drawn from\n'
      ' * Roboto (Copyright 2011 Google Inc., Apache License 2.0,\n'
      ' * LICENSES/Apache-2.0.txt). Do not edit by hand. */\n')
    w('#include "card_font.h"\n\nnamespace woc {\n\nnamespace {\n\n')
    emit('Distance', sys.argv[1], DISTANCE_PX, DISTANCE_CHARS, w)
    emit('Road', sys.argv[2], ROAD_PX, ROAD_CHARS, w)
    w('}  // namespace\n\n')
    w('const uint16_t kFold[][2] = {\n')
    table = fold_table(ROAD_CHARS)
    for i in range(0, len(table), 6):
        w('    ' + ' '.join(f'{{0x{a:04x}, 0x{b:04x}}},' for a, b in table[i:i + 6]) + '\n')
    w('};\n\n')
    w('uint32_t card_fold(uint32_t cp)\n{\n'
      '    size_t lo = 0, hi = sizeof kFold / sizeof kFold[0];\n'
      '    while (lo < hi) {\n'
      '        const size_t mid = (lo + hi) / 2;\n'
      '        if (kFold[mid][0] < cp)\n'
      '            lo = mid + 1;\n'
      '        else\n'
      '            hi = mid;\n'
      '    }\n'
      '    return lo < sizeof kFold / sizeof kFold[0] && kFold[lo][0] == cp ? kFold[lo][1] : 0;\n'
      '}\n\n')
    w('const CardFont &card_font_distance() { return kDistanceFont; }\n')
    w('const CardFont &card_font_road() { return kRoadFont; }\n\n')
    w('}  // namespace woc\n')


if __name__ == '__main__':
    main()
