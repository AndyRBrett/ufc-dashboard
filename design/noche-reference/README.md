# UFC Noche — visual theme

A drop-in theme package for a fight dashboard. Deep night, bone and gold, tricolor
as accent. Posada-tradition woodcut ornament, papel picado, lotería card framing,
agave and marigold, letterpress depth.

```
noche-theme.css      tokens + component styles       (~700 lines, no deps)
noche-assets.svg     decorative SVG sprite           (papel picado, corners, calavera, agave, marigold)
tailwind.noche.cjs    Tailwind token bridge + plugin
noche-preview.html   self-contained mock dashboard   (open on a phone)
README.md            this file
```

Zero dependencies, zero network requests. No webfonts — the type stack is
system-only, so nothing to license or self-host. Every asset is inline.

---

## Wire it in

**1. Load the stylesheet.** After your own base/reset, before component overrides.

```html
<link rel="stylesheet" href="/styles/noche-theme.css">
```

or in a bundler:

```js
import "./styles/noche-theme.css";
```

**2. Set the attribute.** Every token lives under `[data-theme="noche"]`, so
nothing changes until you opt in.

```html
<html data-theme="noche">
```

Scoping to a subtree works identically — useful for shipping the theme on one
route, or for an in-app preview:

```html
<section data-theme="noche"> ... </section>
```

**3. Inline the sprite** once, near the top of `<body>`, if you want the ornament:

```html
<body>
  <!-- contents of noche-assets.svg -->
  ...
```

Then reference symbols anywhere:

```html
<svg class="noche-motif" viewBox="0 0 200 240" aria-hidden="true">
  <use href="#noche-calavera"/>
</svg>
```

Most symbols paint with `currentColor`, so `color:` on the host controls them.

---

## Theme toggle

Nothing to import — it's one attribute.

```js
export function setTheme(name) {              // "noche" | "default"
  const root = document.documentElement;
  if (name === "default") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", name);
  try { localStorage.setItem("theme", name); } catch {}
}

// on boot, before first paint, to avoid a flash of the wrong theme
(function () {
  try {
    const saved = localStorage.getItem("theme");
    if (saved && saved !== "default") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch {}
})();
```

Put that boot IIFE in a blocking inline `<script>` in `<head>`.

React:

```jsx
const [theme, setTheme] = useState(() => localStorage.getItem("theme") ?? "default");
useEffect(() => {
  const root = document.documentElement;
  theme === "default" ? root.removeAttribute("data-theme")
                      : root.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
}, [theme]);
```

Auto-enable it for the event window instead of asking:

```js
const d = new Date();
if (d.getMonth() === 8 && d.getDate() >= 10 && d.getDate() <= 17) setTheme("noche");
```

---

## Tailwind

`tailwind.noche.cjs` maps the same tokens onto Tailwind's theme keys as
`var(--noche-*)` references — not baked hex values. That's the whole trick:
`bg-surface` resolves to night-850 inside the theme and to your default surface
outside it, so you write one set of classes and skip `dark:` variants entirely.

**v3**

```js
// tailwind.config.js
const noche = require("./tailwind.noche.cjs");
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,html}"],
  theme: { extend: noche.theme.extend },
  plugins: [noche.plugin],
};
```

**v4** — skip the JS file, use `@theme inline` (the `inline` keyword preserves
the `var()` indirection; without it Tailwind resolves the values at build time
and runtime theming breaks):

```css
@import "tailwindcss";
@import "./noche-theme.css";

@theme inline {
  --color-surface:  var(--noche-surface);
  --color-oro-400:  var(--noche-oro-400);
  --font-display:   var(--noche-font-display);
  --radius-md:      var(--noche-radius-md);
  /* ... */
}
```

The plugin adds a `noche:` variant (`class="noche:border-gold"` applies only
inside the theme) and two utilities that are awkward otherwise: `.text-foil`
and `.tabular`. The bottom of the file has a cheat sheet rebuilding each
component from the mock in utility classes.

---

## What's in the box

**Tokens** — `--noche-*`, namespaced so they can't collide with your app.
Four ramps (`night` 400–950, `bone` 50–600, `oro` 100–800, plus tricolor and
fiesta accents), semantic surfaces and text, borders, a type scale with fluid
`clamp()` display sizes, five type stacks, spacing, radii, shadows including
letterpress `emboss`/`debossed`, inline paper-grain textures, motion, layout.

There's a commented **bridge block** at the end of `noche-theme.css`. Uncomment
it if your app already reads generic names (`--color-bg`, `--font-display`) and
you'd rather not touch component code — it aliases them to the noche tokens,
still scoped to the theme, so your default palette is untouched outside it.

**Components** — `.noche-` prefixed, and deliberately *not* scoped to the theme
attribute: the tokens are what's themed, the components just consume them. That's
why the preview's toggle can swap the entire look with no markup change.

| | |
|---|---|
| `.noche-event-header` | poster header, papel picado, tricolor rail, corner ornament, calavera watermark |
| `.noche-card` | `--feature` (gold frame + glow), `--framed` (lotería double rule), `--title` |
| `.noche-matchup` | `--feature` for the main event; collapses to a 2-column stack under 30rem |
| `.noche-fighter` | avatar, name, nickname, record, rank chip; `--away` mirrors it |
| `.noche-odds` | `--fav` / `--dog`, tabular numerals, debossed; `.noche-odds-bar` for implied probability |
| `.noche-status` | `--live` (pulsing ring), `--upcoming` (breathing dot), `--final` |
| `.noche-tabs` / `.noche-tab` | scrollable, foil underline on the selected tab |
| `.noche-btn` | `--primary` (foil), `--verde`, `--rojo`, `--ghost`, `--sm/--lg/--block` |
| `.noche-badge` | `--main`, `--title`, `--verde`, `--rojo`, `--rosa`, `--bone`, `--ghost` |
| `.noche-table` | tale of the tape; `.noche-stat-lead` marks the winning side |
| `.noche-stats` / `.noche-stat` | compact KPI grid |
| `.noche-rule`, `.noche-tricolor`, `.noche-papel`, `.noche-ornate` + `.noche-corner`, `.noche-motif` | ornament |

**Accessibility** — `prefers-reduced-motion` kills the pulse animations,
`prefers-contrast: more` lifts border and muted-text contrast and drops the
grain, `print` strips ornament and inverts to ink-on-white. Focus rings use a
double ring that survives on both dark and gold surfaces. Body text is
bone-100 on night-950 (~15:1); the muted and subtle tiers are for supporting
text, not for anything load-bearing.

---

## Notes on a couple of choices

**Papel picado is a `<pattern>`, not a stretched image.** The banner SVG has no
`viewBox` on purpose, so user units equal CSS pixels and `#noche-papel-pattern`
tiles on x at exact integer steps (195 × 54). Panels keep their proportions at
any container width — nothing stretches, no scallop gets cropped, no seams.

```html
<svg class="noche-papel" aria-hidden="true">
  <rect width="100%" height="100%" fill="url(#noche-papel-pattern)"/>
</svg>
```

`.noche-papel--flip` hangs it from a rail below, for footers.

**Radii are small (2–8px).** Letterpress and lotería cards are square. Rounding
them off is the fastest way to make this look like a generic dark theme wearing a
sombrero. If you need to soften it, raise `--noche-radius-*` in one place.

**The tricolor is 2px tall.** It appears as edges, indicators and the papel
picado — never as a background. Gold and bone carry the surface; verde and rojo
mean something (favourite/underdog, live, win/loss). If you use them decoratively
too, that signal is gone.

---

## Artwork provenance

All artwork is original, hand-authored SVG paths drawn in the woodcut/engraving
idiom of **José Guadalupe Posada** (1852–1913), whose work is in the public
domain. The calavera, corner filigree, papel picado, agave rosette and marigold
are inventions in that shared style.

The package contains **no third-party logos, wordmarks, mascots, label artwork,
or brand-owned illustration** — nothing traced from or derived from any
sponsor's assets. That distinction matters: the folk tradition is public domain,
a brand's interpretation of it is not. If you add sponsor marks, add them as
their own separately-licensed assets and keep them out of this file.

Fighters, odds and stats in the preview are fictional.
