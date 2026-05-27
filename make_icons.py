#!/usr/bin/env python3
"""
Generate UFC Picks PWA icons.
Design: red background, "UFC" bold on top half, thin white divider, "PICKS" bold on bottom half.
Both words are contained well within the maskable safe zone (center 80%).
"""
from PIL import Image, ImageDraw, ImageFont
import math, os

RED    = (232, 25, 44)
WHITE  = (255, 255, 255)
DARK   = (7, 7, 10)

FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"

def make_icon(size):
    img = Image.new("RGB", (size, size), RED)
    draw = ImageDraw.Draw(img)

    # Safe zone: 80% of size centered
    safe = int(size * 0.80)
    margin = (size - safe) // 2  # pixels from edge to safe zone

    # Extra inner padding so text doesn't sit right at safe-zone edge
    pad = int(size * 0.06)

    # Available area for text
    avail_w = safe - 2 * pad
    avail_h = safe - 2 * pad

    # Divider thickness
    div_h = max(2, int(size * 0.015))

    # Vertical split: top half for UFC, bottom half for PICKS (equal)
    text_area_h = (avail_h - div_h) // 2

    def fit_font(text, max_w, max_h):
        """Find the largest font size that fits text within max_w x max_h."""
        lo, hi = 8, size
        best = 8
        while lo <= hi:
            mid = (lo + hi) // 2
            try:
                f = ImageFont.truetype(FONT_PATH, mid)
            except Exception:
                break
            bb = draw.textbbox((0, 0), text, font=f)
            tw = bb[2] - bb[0]
            th = bb[3] - bb[1]
            if tw <= max_w and th <= max_h:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        return ImageFont.truetype(FONT_PATH, best)

    # Target: text fills ~90% of available width, capped by height
    target_w = int(avail_w * 0.90)

    ufc_font  = fit_font("UFC",  target_w, text_area_h)
    pick_font = fit_font("PICKS", target_w, text_area_h)

    # UFC bounding box
    ubb = draw.textbbox((0, 0), "UFC", font=ufc_font)
    utw, uth = ubb[2] - ubb[0], ubb[3] - ubb[1]

    # PICKS bounding box
    pbb = draw.textbbox((0, 0), "PICKS", font=pick_font)
    ptw, pth = pbb[2] - pbb[0], pbb[3] - pbb[1]

    # Top of safe zone content
    top_y = margin + pad

    # UFC: vertically centered in top half
    ufc_y = top_y + (text_area_h - uth) // 2 - ubb[1]
    ufc_x = (size - utw) // 2 - ubb[0]
    draw.text((ufc_x, ufc_y), "UFC", font=ufc_font, fill=WHITE)

    # Divider
    div_y = top_y + text_area_h
    div_x0 = margin + pad
    div_x1 = size - margin - pad
    draw.rectangle([div_x0, div_y, div_x1, div_y + div_h], fill=WHITE)

    # PICKS: vertically centered in bottom half
    picks_top = div_y + div_h
    picks_y = picks_top + (text_area_h - pth) // 2 - pbb[1]
    picks_x = (size - ptw) // 2 - pbb[0]
    draw.text((picks_x, picks_y), "PICKS", font=pick_font, fill=WHITE)

    return img

def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    for size, name in [(192, "icon-192-v2.png"), (512, "icon-512-v2.png")]:
        img = make_icon(size)
        img.save(name, "PNG", optimize=True)
        print(f"Saved {name}: {os.path.getsize(name)} bytes")

if __name__ == "__main__":
    main()
