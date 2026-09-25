"""Fight IQ card backgrounds: one supplied image per archetype, plus 20 themes.

The originals live in art/fight-iq/archetypes/ and art/fight-iq/themes/
(1024x1536, numbered per the Fight IQ rotation map). This writes
lab/cards/<key>.jpg for the archetypes and lab/cards/themes/<slug>.jpg for
the themes (the slug is the file name minus its "NN_theme_" prefix, with
dashes; lab.html's CARD_THEMES lists the same slugs). Both are what the card
and its canvas share image load: resized to 1080x1620 (the width
check:lab asserts), dimmed to BRIGHTNESS so the stats stay legible over busy
art, and the bottom FADE of the height blended into the card's --fc-bg1 so
the flat lower half shows no seam. The Lab's CSP (img-src 'self') is why the
images are committed rather than linked.

    pip install pillow && python scripts/card_art.py
"""
import pathlib

from PIL import Image, ImageEnhance

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "art" / "fight-iq" / "archetypes"
THEME_SRC = ROOT / "art" / "fight-iq" / "themes"
OUT = ROOT / "lab" / "cards"
W, H = 1080, 1620
BRIGHTNESS = 0.72
FADE = 0.22
# A theme can sit on any archetype, so it fades to one neutral ground; lab.html
# sets the card's --fc-bg1 to the same colour while a theme is showing.
THEME_BASE = "#0b0b0b"

# archetype key -> (source file, base colour = the card's --fc-bg1 in lab.html)
CARDS = {
    "oracle": ("01_archetype_oracle.jpeg", "#1d0b3f"),
    "dog": ("02_archetype_dog_hunter.jpeg", "#0b0b0b"),
    "lock": ("03_archetype_lock_merchant.jpeg", "#111316"),
    "chalk": ("04_archetype_chalk_eater.jpeg", "#0b3d91"),
    "contrarian": ("05_archetype_contrarian.jpeg", "#0f3d3e"),
    "grappling": ("06_archetype_grappling_nerd.jpeg", "#0b2e18"),
    "chaos": ("07_archetype_chaos_merchant.jpeg", "#3b0a0a"),
    "method": ("08_archetype_method_sniper.jpeg", "#101a0c"),
    "solid": ("09_archetype_student_of_the_game.jpeg", "#1f2937"),
    "casual": ("10_archetype_casual.jpeg", "#262626"),
}


def fade_mask():
    mask = Image.new("L", (W, H), 255)
    start = int(H * (1 - FADE))
    for y in range(start, H):
        v = int(255 * (1 - (y - start) / (H - start)) ** 1.4)
        mask.paste(v, (0, y, W, y + 1))
    return mask


def render(src, base, dest, mask):
    im = Image.open(src).convert("RGB").resize((W, H), Image.LANCZOS)
    im = ImageEnhance.Brightness(im).enhance(BRIGHTNESS)
    out = Image.composite(im, Image.new("RGB", (W, H), base), mask)
    out.save(dest, "JPEG", quality=82, optimize=True, progressive=True)


def theme_slug(path):
    return path.stem.split("_theme_", 1)[1].replace("_", "-")


if __name__ == "__main__":
    mask = fade_mask()
    for key, (name, base) in CARDS.items():
        render(SRC / name, base, OUT / f"{key}.jpg", mask)
        print("wrote", key)
    (OUT / "themes").mkdir(exist_ok=True)
    for src in sorted(THEME_SRC.glob("*_theme_*.jpeg")):
        render(src, THEME_BASE, OUT / "themes" / f"{theme_slug(src)}.jpg", mask)
        print("wrote theme", theme_slug(src))
