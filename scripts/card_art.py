"""Fight IQ card backgrounds: one original illustration per archetype.

Writes lab/cards/src/<key>.svg. `node scripts/card-art-render.mjs` rasterises
them to lab/cards/<key>.jpg, which is what the card (and its share image)
loads. Everything is drawn here, so there is no third-party artwork to
license, and the Lab's CSP (img-src 'self') is satisfied.

Each scene is 1080x1620, keeps its motif in the upper right (behind the
name, clear of the left-aligned text), and fades to the archetype's base
colour at the bottom so the card's lower half sits on a flat ground.
"""
import math
import pathlib
import random

W, H = 1080, 1620
OUT = pathlib.Path(__file__).resolve().parent.parent / "lab" / "cards" / "src"

# Base colour per archetype = the card's --fc-bg1 in lab.html.
BASE = {
    "oracle": "#1d0b3f", "dog": "#0b0b0b", "lock": "#111316", "chalk": "#0b3d91",
    "contrarian": "#0f3d3e", "grappling": "#0b2e18", "chaos": "#3b0a0a",
    "method": "#101a0c", "solid": "#1f2937", "casual": "#262626",
}


def svg(key, defs, body):
    base = BASE[key]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs>
<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .06 0"/></filter>
<filter id="blur40"><feGaussianBlur stdDeviation="40"/></filter>
<filter id="blur12"><feGaussianBlur stdDeviation="12"/></filter>
<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset=".45" stop-color="{base}" stop-opacity="0"/><stop offset=".86" stop-color="{base}" stop-opacity="1"/></linearGradient>
{defs}
</defs>
{body}
<rect width="{W}" height="{H}" filter="url(#grain)"/>
<rect width="{W}" height="{H}" fill="url(#fade)"/>
</svg>'''


def stars(rng, n, y_max=900, r=(0.8, 2.6), color="#fff"):
    out = []
    for _ in range(n):
        x, y = rng.uniform(0, W), rng.uniform(0, y_max)
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{rng.uniform(*r):.1f}" fill="{color}" opacity="{rng.uniform(.25, .95):.2f}"/>')
    return "".join(out)


def oracle(rng):
    defs = '''<radialGradient id="sky" cx="72%" cy="24%" r="80%"><stop offset="0" stop-color="#7a4fe0"/><stop offset=".35" stop-color="#3a1a86"/><stop offset="1" stop-color="#12062e"/></radialGradient>
<radialGradient id="ball" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#f6ecff"/><stop offset=".25" stop-color="#c7a4ff"/><stop offset=".7" stop-color="#6a3cc9"/><stop offset="1" stop-color="#2a1170"/></radialGradient>
<radialGradient id="neb" cx="50%" cy="55%" r="50%"><stop offset="0" stop-color="#ff9df5" stop-opacity=".9"/><stop offset="1" stop-color="#ff9df5" stop-opacity="0"/></radialGradient>
<linearGradient id="stand" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8c56a"/><stop offset="1" stop-color="#6b4f1d"/></linearGradient>
<clipPath id="ballclip"><circle cx="790" cy="400" r="200"/></clipPath>'''
    swirl = "".join(f'<ellipse cx="790" cy="{420 + i * 6}" rx="{150 - i * 18}" ry="{46 - i * 5}" transform="rotate({-18 + i * 9} 790 410)" fill="none" stroke="#fff" stroke-opacity="{.28 - i * .03:.2f}" stroke-width="3"/>' for i in range(6))
    body = f'''<rect width="{W}" height="{H}" fill="url(#sky)"/>
{stars(rng, 260)}
<circle cx="790" cy="400" r="330" fill="#b58cff" opacity=".45" filter="url(#blur40)"/>
<path d="M660 610 L920 610 L960 690 L620 690 Z" fill="url(#stand)"/>
<rect x="600" y="690" width="380" height="26" rx="8" fill="#8a6a2a"/>
<circle cx="790" cy="400" r="200" fill="url(#ball)"/>
<g clip-path="url(#ballclip)"><circle cx="800" cy="450" r="150" fill="url(#neb)"/>{swirl}{stars(random.Random(7), 40, 700, (0.8, 2.2))}</g>
<ellipse cx="720" cy="320" rx="62" ry="36" transform="rotate(-30 720 320)" fill="#fff" opacity=".55" filter="url(#blur12)"/>
<circle cx="790" cy="400" r="200" fill="none" stroke="#f3e6ff" stroke-opacity=".5" stroke-width="3"/>'''
    return defs, body


def dog(rng):
    defs = '''<radialGradient id="sky" cx="74%" cy="25%" r="85%"><stop offset="0" stop-color="#5a4410"/><stop offset=".4" stop-color="#241a05"/><stop offset="1" stop-color="#0b0b0b"/></radialGradient>
<radialGradient id="moon" cx="42%" cy="38%" r="70%"><stop offset="0" stop-color="#fff2c4"/><stop offset=".55" stop-color="#f2c14e"/><stop offset="1" stop-color="#b8861f"/></radialGradient>'''
    craters = "".join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="#a87a17" opacity=".35"/>' for x, y, r in [(730, 330, 34), (860, 420, 26), (800, 480, 18), (700, 450, 14), (880, 300, 16)])
    # A hound on a ridge, head up, howling at the moon.
    hound = ("M548 818 C515 808 488 772 500 738 C510 712 532 716 540 742 C546 760 560 770 580 764 "
             "C592 738 612 706 640 684 C660 668 676 646 688 618 L694 572 L712 600 L722 586 "
             "C736 574 752 560 770 540 L808 504 C816 500 820 508 814 516 L788 552 "
             "C780 566 768 578 754 588 C748 610 746 640 748 668 C752 710 756 752 762 790 "
             "L776 806 C780 812 776 818 768 818 Z")
    body = f'''<rect width="{W}" height="{H}" fill="url(#sky)"/>
{stars(rng, 120, 800, color="#ffe9a8")}
<circle cx="790" cy="400" r="330" fill="#f2c14e" opacity=".28" filter="url(#blur40)"/>
<circle cx="790" cy="400" r="235" fill="url(#moon)"/>{craters}
<path d="{hound}" fill="#070707"/>
<path d="M0 900 C200 830 380 800 560 812 C700 822 840 790 1080 760 L1080 1620 L0 1620 Z" fill="#070707"/>
<path d="M0 900 C200 830 380 800 560 812 C700 822 840 790 1080 760" fill="none" stroke="#f2c14e" stroke-opacity=".35" stroke-width="3"/>'''
    return defs, body


def lock(rng):
    defs = '''<linearGradient id="steel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a5059"/><stop offset=".5" stop-color="#1c1f24"/><stop offset="1" stop-color="#0c0d10"/></linearGradient>
<radialGradient id="door" cx="40%" cy="35%" r="75%"><stop offset="0" stop-color="#9aa3ae"/><stop offset=".5" stop-color="#5a616b"/><stop offset="1" stop-color="#23272d"/></radialGradient>
<filter id="brush"><feTurbulence type="fractalNoise" baseFrequency=".002 .6" numOctaves="2"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .09 0"/></filter>'''
    cx, cy = 790, 430
    bolts = "".join(f'<circle cx="{cx + 290 * math.cos(a):.0f}" cy="{cy + 290 * math.sin(a):.0f}" r="16" fill="#c9ced6" stroke="#2a2e34" stroke-width="4"/>'
                    for a in [i * math.pi / 8 for i in range(16)])
    spokes = "".join(f'<rect x="{cx - 8}" y="{cy - 150}" width="16" height="300" rx="8" fill="#d4d9e0" transform="rotate({a} {cx} {cy})"/>' for a in (0, 60, 120))
    body = f'''<rect width="{W}" height="{H}" fill="url(#steel)"/>
<rect width="{W}" height="{H}" filter="url(#brush)"/>
<circle cx="{cx}" cy="{cy}" r="360" fill="#000" opacity=".5" filter="url(#blur40)"/>
<circle cx="{cx}" cy="{cy}" r="330" fill="url(#door)" stroke="#16181c" stroke-width="10"/>
<circle cx="{cx}" cy="{cy}" r="250" fill="none" stroke="#2a2e34" stroke-width="6"/>
<circle cx="{cx}" cy="{cy}" r="210" fill="none" stroke="#c9ced6" stroke-opacity=".35" stroke-width="3"/>
{bolts}{spokes}
<circle cx="{cx}" cy="{cy}" r="60" fill="#2a2e34" stroke="#d4d9e0" stroke-width="8"/>
<circle cx="{cx}" cy="{cy}" r="18" fill="#d4d9e0"/>
<path d="M{cx - 330} {cy} A330 330 0 0 1 {cx} {cy - 330}" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="6"/>'''
    return defs, body


def chalk(rng):
    defs = '''<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e6fd9"/><stop offset="1" stop-color="#0b3d91"/></linearGradient>
<pattern id="grid" width="54" height="54" patternUnits="userSpaceOnUse"><path d="M54 0H0V54" fill="none" stroke="#fff" stroke-opacity=".09" stroke-width="2"/></pattern>'''
    pts, x, y = [], 470, 680
    for _ in range(12):
        pts.append((x, y)); x += 50; y -= rng.uniform(10, 55) if rng.random() > .25 else -rng.uniform(5, 25)
    line = " ".join(f"{a:.0f},{b:.0f}" for a, b in pts)
    dots = "".join(f'<circle cx="{a:.0f}" cy="{b:.0f}" r="7" fill="#fff"/>' for a, b in pts)
    towers = "".join(f'<rect x="{i * 90 - 10}" y="{820 - h}" width="{70 + (i % 3) * 12}" height="{h + 900}" fill="#0a2f73" opacity=".85"/>' for i, h in enumerate([160, 260, 210, 340, 280, 420, 300, 380, 240, 330, 200, 270]))
    windows = "".join(f'<rect x="{i * 90 + 6 + c * 18}" y="{840 - h + r * 26}" width="8" height="12" fill="#bcd6ff" opacity="{rng.uniform(.1, .45):.2f}"/>'
                      for i, h in enumerate([160, 260, 210, 340, 280, 420, 300, 380, 240, 330, 200, 270]) for r in range(6) for c in range(3))
    body = f'''<rect width="{W}" height="{H}" fill="url(#bg)"/><rect width="{W}" height="{H}" fill="url(#grid)"/>
<polyline points="{line}" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round" opacity=".9"/>{dots}
<circle cx="{pts[-1][0]:.0f}" cy="{pts[-1][1]:.0f}" r="26" fill="#fff" opacity=".3" filter="url(#blur12)"/>
{towers}{windows}'''
    return defs, body


def contrarian(rng):
    defs = '''<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#11595a"/><stop offset=".55" stop-color="#0f3d3e"/><stop offset=".56" stop-color="#4a1440"/><stop offset="1" stop-color="#6b1d5c"/></linearGradient>'''
    arrow = lambda x, y, s, col, op, flip: (f'<g transform="translate({x} {y}) scale({-s if flip else s} {s})" opacity="{op}"><path d="M-40 -12 L20 -12 L20 -30 L50 0 L20 30 L20 12 L-40 12 Z" fill="{col}"/></g>')
    crowd = "".join(arrow(rng.uniform(40, 1040), rng.uniform(80, 900), rng.uniform(.5, 1.1), "#9ff5e8", f"{rng.uniform(.12, .35):.2f}", False) for _ in range(70))
    body = f'''<rect width="{W}" height="{H}" fill="url(#bg)"/>{crowd}
<circle cx="800" cy="410" r="220" fill="#ff8adf" opacity=".35" filter="url(#blur40)"/>
{arrow(800, 410, 5.2, "#ff8adf", ".95", True)}'''
    return defs, body


def grappling(rng):
    defs = '''<radialGradient id="mat" cx="72%" cy="28%" r="85%"><stop offset="0" stop-color="#2f8a4a"/><stop offset=".5" stop-color="#1a5a30"/><stop offset="1" stop-color="#0b2e18"/></radialGradient>
<filter id="vinyl"><feTurbulence type="fractalNoise" baseFrequency=".03" numOctaves="3"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .05 0"/></filter>'''
    body = f'''<rect width="{W}" height="{H}" fill="url(#mat)"/><rect width="{W}" height="{H}" filter="url(#vinyl)"/>
<circle cx="800" cy="420" r="520" fill="none" stroke="#e8fff0" stroke-opacity=".5" stroke-width="18"/>
<circle cx="800" cy="420" r="300" fill="#c8102e" opacity=".22"/>
<circle cx="800" cy="420" r="300" fill="none" stroke="#e8fff0" stroke-opacity=".55" stroke-width="10"/>
<circle cx="800" cy="420" r="70" fill="none" stroke="#e8fff0" stroke-opacity=".7" stroke-width="10"/>
<rect x="720" y="400" width="54" height="14" rx="4" fill="#e04c4c" opacity=".9"/><rect x="826" y="428" width="54" height="14" rx="4" fill="#4c7be0" opacity=".9"/>
<path d="M0 {H} L{W} 180" stroke="#fff" stroke-opacity=".05" stroke-width="160"/>'''
    return defs, body


def chaos(rng):
    defs = '''<radialGradient id="bg" cx="74%" cy="26%" r="90%"><stop offset="0" stop-color="#ffb347"/><stop offset=".25" stop-color="#e2531a"/><stop offset=".6" stop-color="#7a1a0c"/><stop offset="1" stop-color="#3b0a0a"/></radialGradient>
<radialGradient id="core" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fffbe6"/><stop offset=".4" stop-color="#ffd166"/><stop offset="1" stop-color="#ffd166" stop-opacity="0"/></radialGradient>'''
    cx, cy = 800, 420
    rays = []
    for i in range(36):
        a, w = i * math.pi * 2 / 36 + rng.uniform(-.05, .05), rng.uniform(.03, .07)
        L = rng.uniform(700, 1300)
        rays.append(f'<path d="M{cx} {cy} L{cx + L * math.cos(a - w):.0f} {cy + L * math.sin(a - w):.0f} L{cx + L * math.cos(a + w):.0f} {cy + L * math.sin(a + w):.0f} Z" fill="#ffd166" opacity="{rng.uniform(.06, .22):.2f}"/>')
    sparks = []
    for _ in range(60):
        d, t = rng.uniform(150, 520), rng.uniform(0, 6.28)
        x, y = cx + d * math.cos(t), cy + d * math.sin(t)
        sparks.append(f'<line x1="{x:.0f}" y1="{y:.0f}" x2="{x + 40 * math.cos(t):.0f}" y2="{y + 40 * math.sin(t):.0f}" stroke="#ffe7a3" stroke-width="{rng.uniform(2, 5):.1f}" stroke-linecap="round" opacity="{rng.uniform(.4, .9):.2f}"/>')
    sparks = "".join(sparks)
    body = f'''<rect width="{W}" height="{H}" fill="url(#bg)"/>{"".join(rays)}{sparks}
<circle cx="{cx}" cy="{cy}" r="260" fill="url(#core)"/>'''
    return defs, body


def method(rng):
    defs = '''<radialGradient id="bg" cx="73%" cy="26%" r="90%"><stop offset="0" stop-color="#3f6630"/><stop offset=".45" stop-color="#1c2e14"/><stop offset="1" stop-color="#101a0c"/></radialGradient>'''
    cx, cy, R = 790, 420, 300
    ticks = []
    for i in range(-9, 10):
        if i == 0: continue
        s = 22 if i % 3 == 0 else 12
        ticks.append(f'<line x1="{cx + i * 30}" y1="{cy - s}" x2="{cx + i * 30}" y2="{cy + s}" stroke="#9be15d" stroke-width="3"/>')
        ticks.append(f'<line x1="{cx - s}" y1="{cy + i * 30}" x2="{cx + s}" y2="{cy + i * 30}" stroke="#9be15d" stroke-width="3"/>')
    body = f'''<rect width="{W}" height="{H}" fill="url(#bg)"/>
<circle cx="{cx}" cy="{cy}" r="{R + 40}" fill="#9be15d" opacity=".12" filter="url(#blur40)"/>
<circle cx="{cx}" cy="{cy}" r="{R}" fill="#0f1a0b" opacity=".45"/>
<circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="#9be15d" stroke-width="8"/>
<circle cx="{cx}" cy="{cy}" r="{R * .62:.0f}" fill="none" stroke="#9be15d" stroke-opacity=".5" stroke-width="3"/>
<line x1="{cx - R}" y1="{cy}" x2="{cx + R}" y2="{cy}" stroke="#9be15d" stroke-width="4"/>
<line x1="{cx}" y1="{cy - R}" x2="{cx}" y2="{cy + R}" stroke="#9be15d" stroke-width="4"/>
{"".join(ticks)}
<circle cx="{cx}" cy="{cy}" r="9" fill="#ff3b3b"/><circle cx="{cx}" cy="{cy}" r="26" fill="#ff3b3b" opacity=".35" filter="url(#blur12)"/>'''
    return defs, body


def solid(rng):
    defs = '''<radialGradient id="bg" cx="72%" cy="10%" r="95%"><stop offset="0" stop-color="#4b5563"/><stop offset=".5" stop-color="#2b3441"/><stop offset="1" stop-color="#1f2937"/></radialGradient>
<pattern id="mesh" width="46" height="46" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0 L46 0 M0 0 L0 46" stroke="#cfd6df" stroke-opacity=".16" stroke-width="3" fill="none"/></pattern>
<linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'''
    cx, cy, R = 790, 440, 330
    octa = " ".join(f"{cx + R * math.cos(math.pi / 8 + i * math.pi / 4):.0f},{cy + R * math.sin(math.pi / 8 + i * math.pi / 4):.0f}" for i in range(8))
    body = f'''<rect width="{W}" height="{H}" fill="url(#bg)"/>
<path d="M620 0 L960 0 L1180 900 L400 900 Z" fill="url(#beam)"/>
<rect width="{W}" height="{H}" fill="url(#mesh)"/>
<polygon points="{octa}" fill="#111827" fill-opacity=".35" stroke="#e5e7eb" stroke-opacity=".7" stroke-width="10"/>
<polygon points="{octa}" fill="none" stroke="#e5e7eb" stroke-opacity=".25" stroke-width="3" transform="translate({cx} {cy}) scale(.82) translate({-cx} {-cy})"/>
<ellipse cx="{cx}" cy="{cy + 250}" rx="260" ry="40" fill="#fff" opacity=".08" filter="url(#blur12)"/>'''
    return defs, body


def casual(rng):
    defs = '''<radialGradient id="bg" cx="70%" cy="20%" r="95%"><stop offset="0" stop-color="#5a5a5a"/><stop offset=".5" stop-color="#333"/><stop offset="1" stop-color="#262626"/></radialGradient>'''
    bokeh = "".join(f'<circle cx="{rng.uniform(0, W):.0f}" cy="{rng.uniform(0, 900):.0f}" r="{rng.uniform(14, 60):.0f}" fill="{rng.choice(["#fff4d6", "#ffd9a0", "#e8e8e8"])}" opacity="{rng.uniform(.06, .22):.2f}"/>' for _ in range(70))
    kernels = "".join(
        f'<g transform="translate({x:.0f} {y:.0f}) rotate({rng.uniform(0, 360):.0f})"><circle r="{r:.0f}" fill="#fff6e0"/><circle cx="{r * .7:.0f}" cy="{-r * .4:.0f}" r="{r * .8:.0f}" fill="#ffefc7"/><circle cx="{-r * .6:.0f}" cy="{-r * .6:.0f}" r="{r * .7:.0f}" fill="#fff9ea"/><circle cx="{r * .1:.0f}" cy="{r * .6:.0f}" r="{r * .5:.0f}" fill="#f2c96b"/></g>'
        for x, y, r in [(760 + rng.uniform(-200, 220), 420 + rng.uniform(-180, 200), rng.uniform(22, 38)) for _ in range(26)])
    body = f'''<rect width="{W}" height="{H}" fill="url(#bg)"/>{bokeh}
<circle cx="790" cy="430" r="280" fill="#ffd9a0" opacity=".18" filter="url(#blur40)"/>{kernels}'''
    return defs, body


# Archetypes whose lab/cards/<key>.jpg is supplied artwork (1024x1536 PNGs
# from the owner, resized to 1080x1620) rather than drawn here. They are
# skipped, and their SVG removed, so a re-run of this script plus the
# renderer can never overwrite the supplied image with the drawn one.
SUPPLIED = {"oracle", "chaos", "method"}

SCENES = {"oracle": oracle, "dog": dog, "lock": lock, "chalk": chalk, "contrarian": contrarian,
          "grappling": grappling, "chaos": chaos, "method": method, "solid": solid, "casual": casual}

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for key, fn in SCENES.items():
        if key in SUPPLIED:
            (OUT / f"{key}.svg").unlink(missing_ok=True)
            continue
        defs, body = fn(random.Random(key))      # seeded: the art is reproducible
        (OUT / f"{key}.svg").write_text(svg(key, defs, body), encoding="utf-8")
        print("wrote", key)
