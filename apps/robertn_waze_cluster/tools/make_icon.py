# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Robert Nisipeanu
import sys
from PIL import Image, ImageDraw

# 140x140 tile icon, glyph centred with ~24px transparent padding.
# Supersampled 4x then downscaled for smooth edges.
# Glyph: a navigation cursor (an upward arrow with a notched base), for the
# map on the cluster.
out = sys.argv[1]
S = 4
N = 140 * S
pad = 24 * S
img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

cx = N // 2
top = pad
bottom = N - pad
half = (N - 2 * pad) // 2
notch = (bottom - top) * 0.32   # how far the base notch rises toward the apex
col = (235, 238, 242, 255)

# apex, bottom-right, centre notch, bottom-left
d.polygon([
    (cx, top),
    (cx + half, bottom),
    (cx, bottom - notch),
    (cx - half, bottom),
], fill=col)

img = img.resize((140, 140), Image.LANCZOS)
img.save(out)
print("wrote", out, img.size)
