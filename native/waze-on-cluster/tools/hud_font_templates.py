#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
"""Distance glyph templates for the CarPlay manoeuvre card (README.md "HUD
arrows"): iOS draws the card's distance in SF Pro Bold, so the glyphs are
rendered from a copy of the font you supply instead of labelled crops (no
font and nothing rendered from one ships with this repository).
Writes dist-<text>-1.pgm lines, white on black, digits DIGIT_PX tall.
The PGMs are renders of Apple's font: install them on your own unit only,
never commit or share them.   usage: hud_font_templates.py OUT_DIR FONT"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

LINES = ["0123456789", "km", "m", "ft", "mi", "1.5km", "0,5km"]
DIGIT_PX = 32


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: hud_font_templates.py OUT_DIR FONT (a SF Pro .ttf/.otf you are licensed to use)")
    out, font_path = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    size = 44
    font = ImageFont.truetype(font_path, size)
    try:
        font.set_variation_by_name("Bold")
    except (OSError, ValueError):
        pass
    # scale so a digit is DIGIT_PX tall, as on the 1920x720 screen
    box = font.getbbox("0")
    font = ImageFont.truetype(font_path, round(size * DIGIT_PX / (box[3] - box[1])))
    try:
        font.set_variation_by_name("Bold")
    except (OSError, ValueError):
        pass
    for text in LINES:
        l, t, r, b = font.getbbox(text)
        img = Image.new("L", (r - l + 24, b - t + 24), 0)
        ImageDraw.Draw(img).text((12 - l, 12 - t), text, fill=255, font=font)
        with open(os.path.join(out, "dist-%s-1.pgm" % text), "wb") as f:
            f.write(b"P5\n%d %d\n255\n" % img.size + img.tobytes())
        print("dist-%s-1.pgm %dx%d" % ((text,) + img.size))


if __name__ == "__main__":
    main()
