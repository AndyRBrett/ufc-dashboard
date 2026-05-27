"""
Generate UFC Picks app icons (192x192 and 512x512).
Layout: dark background, bold red "UFC" on top, white "PICKS" clearly below,
separated by a red divider line. No text overlap.
"""
from PIL import Image, ImageDraw, ImageFont
import math

BOLD   = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
RED    = (232, 25, 44)       # #e8192c — UFC red
WHITE  = (255, 255, 255)
DARK   = (7, 7, 10)          # #07070a — app background
MIDGRAY= (40, 40, 50)

def rounded_rect(draw, xy, radius, fill):
    x0, y0, x1, y1 = xy
    draw.rectangle([x0 + radius, y0, x1 - radius, y1], fill=fill)
    draw.rectangle([x0, y0 + radius, x1, y1 - radius], fill=fill)
    draw.ellipse([x0, y0, x0 + radius*2, y0 + radius*2], fill=fill)
    draw.ellipse([x1 - radius*2, y0, x1, y0 + radius*2], fill=fill)
    draw.ellipse([x0, y1 - radius*2, x0 + radius*2, y1], fill=fill)
    draw.ellipse([x1 - radius*2, y1 - radius*2, x1, y1], fill=fill)

def make_icon(size):
    S = size
    img  = Image.new("RGBA", (S, S), DARK)
    draw = ImageDraw.Draw(img)

    pad   = int(S * 0.07)   # outer padding
    inner = S - 2 * pad     # inner box width

    # ── Red card background (full rounded rect) ──────────────────────────
    card_r = int(S * 0.10)
    rounded_rect(draw, (pad, pad, S - pad, S - pad), card_r, RED)

    # ── "UFC" text — top ~55% of card ────────────────────────────────────
    ufc_size  = int(S * 0.38)
    ufc_font  = ImageFont.truetype(BOLD, ufc_size)
    ufc_bbox  = draw.textbbox((0, 0), "UFC", font=ufc_font)
    ufc_w     = ufc_bbox[2] - ufc_bbox[0]
    ufc_h     = ufc_bbox[3] - ufc_bbox[1]
    ufc_x     = (S - ufc_w) // 2 - ufc_bbox[0]
    # Centre "UFC" in the top 57% of the card area
    card_top  = pad
    card_bot  = S - pad
    card_h    = card_bot - card_top
    ufc_zone_bot = card_top + int(card_h * 0.57)
    ufc_zone_top = card_top
    ufc_y     = ufc_zone_top + (ufc_zone_bot - ufc_zone_top - ufc_h) // 2 - ufc_bbox[1]
    draw.text((ufc_x, ufc_y), "UFC", font=ufc_font, fill=WHITE)

    # ── Thin white divider line ───────────────────────────────────────────
    div_y   = ufc_zone_bot + int(S * 0.01)
    div_x0  = pad + int(inner * 0.10)
    div_x1  = S - pad - int(inner * 0.10)
    lw      = max(1, int(S * 0.008))
    draw.rectangle([div_x0, div_y, div_x1, div_y + lw], fill=WHITE)

    # ── "PICKS" text — lower ~40% of card ────────────────────────────────
    # Fit "PICKS" to ~80% of the inner card width
    target_w     = int(inner * 0.80)
    picks_size   = int(S * 0.20)   # start size
    while True:
        pf   = ImageFont.truetype(BOLD, picks_size)
        pb   = draw.textbbox((0, 0), "PICKS", font=pf)
        pw   = pb[2] - pb[0]
        if pw <= target_w or picks_size <= 10:
            break
        picks_size -= 1

    picks_font = ImageFont.truetype(BOLD, picks_size)
    picks_bbox = draw.textbbox((0, 0), "PICKS", font=picks_font)
    picks_w    = picks_bbox[2] - picks_bbox[0]
    picks_h    = picks_bbox[3] - picks_bbox[1]
    picks_x    = (S - picks_w) // 2 - picks_bbox[0]
    picks_zone_top = div_y + lw + int(S * 0.01)
    picks_zone_bot = card_bot
    picks_y    = picks_zone_top + (picks_zone_bot - picks_zone_top - picks_h) // 2 - picks_bbox[1]
    draw.text((picks_x, picks_y), "PICKS", font=picks_font, fill=WHITE)

    return img

for sz, fname in [(192, "icon-192.png"), (512, "icon-512.png")]:
    icon = make_icon(sz)
    icon.save(f"/home/user/ufc-dashboard/{fname}", "PNG")
    print(f"Saved {fname} ({sz}x{sz})")

print("Done.")
