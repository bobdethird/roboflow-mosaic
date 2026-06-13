#!/usr/bin/env python3
"""Render the combined color palette of every clip's end frame.

Reads clips.json and draws one image: a continuous hue-sorted spectrum strip
(the colors "combined"), the averaged blend, and a labeled swatch grid.

  python combine_colors.py   ->   color-combination.png
"""
import json, math, sys
from pathlib import Path
import cv2, numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
clips = json.loads((SCRIPT_DIR / "clips.json").read_text())["clips"]


def rgb_of(c):
    if c.get("color_rgb"):
        return tuple(c["color_rgb"])
    h = c["color_hex"].lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


colors = [(rgb_of(c), c["color_hex"]) for c in clips]
n = len(colors)


def hsv(rgb):
    r, g, b = rgb
    return cv2.cvtColor(np.uint8([[[b, g, r]]]), cv2.COLOR_BGR2HSV)[0, 0]


colors.sort(key=lambda x: (int(hsv(x[0])[0]), int(hsv(x[0])[2])))
bgr = lambda rgb: (int(rgb[2]), int(rgb[1]), int(rgb[0]))

W = 1280
pad = 24
strip_h = 150
avg_h = 70
cell, gap, labh = 100, 8, 18
cols = max(1, (W - 2 * pad + gap) // (cell + gap))
rows = math.ceil(n / cols)
grid_h = rows * (cell + labh + gap)
H = pad + strip_h + pad + avg_h + pad + grid_h + pad
img = np.full((H, W, 3), 24, np.uint8)

y = pad
# 1) continuous hue-sorted spectrum strip — the palette "combined"
x0 = pad
sw = (W - 2 * pad) / n
for i, (rgb, _) in enumerate(colors):
    a, b = int(x0 + i * sw), int(x0 + (i + 1) * sw)
    img[y:y + strip_h, a:b] = bgr(rgb)
cv2.putText(img, f"{n} clip colors, combined (hue-sorted spectrum)", (pad, y - 6),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (220, 220, 220), 1, cv2.LINE_AA)
y += strip_h + pad

# 2) averaged blend of the whole set
avg = np.mean([c[0] for c in colors], axis=0).astype(int)
img[y:y + avg_h, pad:W - pad] = bgr(tuple(avg))
ahex = f"#{avg[0]:02x}{avg[1]:02x}{avg[2]:02x}"
tcol = (20, 20, 20) if sum(avg) > 380 else (235, 235, 235)
cv2.putText(img, f"average blend  {ahex}  rgb{tuple(int(v) for v in avg)}",
            (pad + 12, y + avg_h // 2 + 5), cv2.FONT_HERSHEY_SIMPLEX, 0.55, tcol, 1, cv2.LINE_AA)
y += avg_h + pad

# 3) labeled swatch grid
for i, (rgb, hx) in enumerate(colors):
    r, c = divmod(i, cols)
    x = pad + c * (cell + gap)
    yy = y + r * (cell + labh + gap)
    img[yy:yy + cell, x:x + cell] = bgr(rgb)
    cv2.putText(img, hx, (x, yy + cell + 13), cv2.FONT_HERSHEY_SIMPLEX,
                0.34, (230, 230, 230), 1, cv2.LINE_AA)

out = SCRIPT_DIR / "color-combination.png"
cv2.imwrite(str(out), img)
print(f"{n} colors -> {out}")
print(f"average blend: {ahex}")
