#!/usr/bin/env python3
"""Draws the VisualVault icons (needs Pillow). Run from anywhere: python3 tools/make-icons.py
Outputs to icons/: icon-192.png, icon-512.png (purpose "any"), maskable-512.png (purpose "maskable"),
apple-touch-icon.png (180, opaque), favicon-32.png.
Design: a photo frame (mountain + sun) inside a vault-door ring, on the app's dark ink colour."""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
INK, PAPER, BRASS, ACCENT = (16, 32, 43), (231, 235, 238), (224, 178, 82), (92, 195, 224)
S = 1024  # draw big, then downscale for clean edges

def glyph(d, cx, cy, r):
    """The mark, centred on (cx,cy), fitting inside a circle of radius r."""
    ring_w = r * 0.085
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=BRASS, width=round(ring_w))
    # bolts on the ring (vault door)
    for ang in range(0, 360, 45):
        import math
        bx, by = cx + math.cos(math.radians(ang)) * r, cy + math.sin(math.radians(ang)) * r
        br = r * 0.055
        d.ellipse([bx - br, by - br, bx + br, by + br], fill=BRASS)
    # photo frame
    w, hgt = r * 1.12, r * 0.86
    x0, y0, x1, y1 = cx - w / 2, cy - hgt / 2, cx + w / 2, cy + hgt / 2
    d.rounded_rectangle([x0, y0, x1, y1], radius=r * 0.07, fill=PAPER)
    ix0, iy0, ix1, iy1 = x0 + r * 0.07, y0 + r * 0.07, x1 - r * 0.07, y1 - r * 0.07
    d.rectangle([ix0, iy0, ix1, iy1], fill=(20, 60, 80))
    # sun
    sr = r * 0.085
    sx, sy = ix0 + (ix1 - ix0) * 0.72, iy0 + (iy1 - iy0) * 0.30
    d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=BRASS)
    # mountains
    base = iy1
    d.polygon([(ix0, base), (ix0 + (ix1 - ix0) * 0.34, iy0 + (iy1 - iy0) * 0.32), (ix0 + (ix1 - ix0) * 0.62, base)], fill=ACCENT)
    d.polygon([(ix0 + (ix1 - ix0) * 0.38, base), (ix0 + (ix1 - ix0) * 0.70, iy0 + (iy1 - iy0) * 0.50), (ix1, base)], fill=(60, 150, 180))

def make(size, glyph_r_frac, rounded, name):
    big = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    if rounded:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=S * 0.22, fill=INK)
    else:
        d.rectangle([0, 0, S, S], fill=INK)
    glyph(d, S / 2, S / 2, S * glyph_r_frac)
    img = big.resize((size, size), Image.LANCZOS)
    if not rounded: img = img.convert("RGB")
    img.save(os.path.join(OUT, name), "PNG", optimize=True)

os.makedirs(OUT, exist_ok=True)
make(512, 0.40, True, "icon-512.png")        # any: rounded, transparent corners
make(192, 0.40, True, "icon-192.png")
make(512, 0.30, False, "maskable-512.png")    # maskable: full-bleed, glyph inside the central 60% (safe zone is 80%)
make(180, 0.34, False, "apple-touch-icon.png")
make(32, 0.42, True, "favicon-32.png")
print("wrote", sorted(os.listdir(OUT)))
