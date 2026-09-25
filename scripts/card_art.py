"""Fight IQ card backgrounds: three pictures per archetype.

The originals live in art/fight-iq/ (1024x1536, numbered per the Fight IQ
rotation map): one archetype picture each in archetypes/, and 20 style
pictures in themes/, two of which are paired with each archetype by mood in
CARDS below. This writes lab/cards/<key>.jpg, <key>-2.jpg and <key>-3.jpg,
which is what the card and its canvas share image load (lab.html's
cardArtFor deals one per player, so players sharing an archetype get
different versions): resized to 1080x1620 (the width check:lab asserts),
dimmed to BRIGHTNESS so the stats stay legible over busy art, and the bottom
FADE of the height blended into the archetype's --fc-bg1 so the flat lower
half shows no seam. The Lab's CSP (img-src 'self') is why the images are
committed rather than linked.

    pip install pillow && python scripts/card_art.py
"""
import pathlib

from PIL import Image, ImageEnhance

ROOT = pathlib.Path(__file__).resolve().parent.parent
ART = ROOT / "art" / "fight-iq"
OUT = ROOT / "lab" / "cards"
W, H = 1080, 1620
BRIGHTNESS = 0.72
FADE = 0.22

# archetype key -> (base colour = the card's --fc-bg1 in lab.html,
#                   [version 1, version 2, version 3] under art/fight-iq/)
CARDS = {
    "oracle": ("#1d0b3f", ["archetypes/01_archetype_oracle.jpeg", "themes/01_theme_anime.jpeg",
                           "themes/20_theme_surreal_dreamscape.jpeg"]),
    "dog": ("#0b0b0b", ["archetypes/02_archetype_dog_hunter.jpeg", "themes/11_theme_ukiyo_e_woodblock.jpeg",
                        "themes/05_theme_noir_detective.jpeg"]),
    "lock": ("#111316", ["archetypes/03_archetype_lock_merchant.jpeg", "themes/09_theme_luxury_black_gold.jpeg",
                         "themes/19_theme_steampunk.jpeg"]),
    "chalk": ("#0b3d91", ["archetypes/04_archetype_chalk_eater.jpeg", "themes/12_theme_stained_glass_cathedral.jpeg",
                          "themes/13_theme_claymation_stop_motion.jpeg"]),
    "contrarian": ("#0f3d3e", ["archetypes/05_archetype_contrarian.jpeg", "themes/15_theme_street_graffiti.jpeg",
                               "themes/10_theme_paper_collage_poster.jpeg"]),
    "grappling": ("#0b2e18", ["archetypes/06_archetype_grappling_nerd.jpeg", "themes/18_theme_blueprint_tactical.jpeg",
                              "themes/17_theme_layered_paper_cut.jpeg"]),
    "chaos": ("#3b0a0a", ["archetypes/07_archetype_chaos_merchant.jpeg", "themes/02_theme_comic_book.jpeg",
                          "themes/08_theme_pixel_art_arcade.jpeg"]),
    "method": ("#101a0c", ["archetypes/08_archetype_method_sniper.jpeg", "themes/04_theme_cyberpunk_neon.jpeg",
                           "themes/14_theme_minimal_vector_poster.jpeg"]),
    "solid": ("#1f2937", ["archetypes/09_archetype_student_of_the_game.jpeg", "themes/03_theme_film_strip_cinematic.jpeg",
                          "themes/16_theme_baroque_oil_painting.jpeg"]),
    "casual": ("#262626", ["archetypes/10_archetype_casual.jpeg", "themes/07_theme_synthwave_vaporwave.jpeg",
                           "themes/06_theme_watercolor_fantasy.jpeg"]),
}


def fade_mask():
    mask = Image.new("L", (W, H), 255)
    start = int(H * (1 - FADE))
    for y in range(start, H):
        v = int(255 * (1 - (y - start) / (H - start)) ** 1.4)
        mask.paste(v, (0, y, W, y + 1))
    return mask


def out_name(key, i):
    return f"{key}.jpg" if i == 0 else f"{key}-{i + 1}.jpg"


if __name__ == "__main__":
    mask = fade_mask()
    for key, (base, sources) in CARDS.items():
        for i, src in enumerate(sources):
            im = Image.open(ART / src).convert("RGB").resize((W, H), Image.LANCZOS)
            im = ImageEnhance.Brightness(im).enhance(BRIGHTNESS)
            out = Image.composite(im, Image.new("RGB", (W, H), base), mask)
            out.save(OUT / out_name(key, i), "JPEG", quality=82, optimize=True, progressive=True)
            print("wrote", out_name(key, i))
