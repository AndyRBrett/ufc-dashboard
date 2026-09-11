/* =============================================================================
   UFC NOCHE — Tailwind token bridge
   -----------------------------------------------------------------------------
   Same tokens as noche-theme.css, exposed as Tailwind utilities. Every value is
   a `var(--noche-*)` reference, NOT a hard-coded hex — so `bg-surface` renders
   night-850 inside [data-theme="noche"] and whatever your default palette says
   outside it. One class, both themes, no `dark:` variants to maintain.

   You still need noche-theme.css loaded (or at least its token block): this file
   only teaches Tailwind the names.

   ── Tailwind v4 (CSS-first) ────────────────────────────────────────────────
   Skip this file. Put the token block in your CSS and add:

       @import "tailwindcss";
       @import "./noche-theme.css";
       @theme inline {
         --color-surface: var(--noche-surface);
         --color-oro-400: var(--noche-oro-400);
         --font-display: var(--noche-font-display);
         ... etc
       }
   `@theme inline` is the key: it keeps the var() indirection instead of
   resolving it at build time, which is what makes runtime theming work.

   ── Tailwind v3 ────────────────────────────────────────────────────────────
   // tailwind.config.js
   const noche = require("./tailwind.noche.js");
   module.exports = {
     content: ["./src/**/*.{js,ts,jsx,tsx,html}"],
     theme: { extend: noche.theme.extend },
     plugins: [noche.plugin],
   };
   ============================================================================= */

const v = (name) => `var(--noche-${name})`;

const theme = {
  extend: {
    colors: {
      /* raw ramps */
      night: {
        400: v("night-400"), 500: v("night-500"), 600: v("night-600"),
        700: v("night-700"), 800: v("night-800"), 850: v("night-850"),
        900: v("night-900"), 950: v("night-950"),
      },
      bone: {
        50: v("bone-50"), 100: v("bone-100"), 200: v("bone-200"),
        300: v("bone-300"), 400: v("bone-400"), 500: v("bone-500"),
        600: v("bone-600"),
      },
      oro: {
        100: v("oro-100"), 200: v("oro-200"), 300: v("oro-300"),
        400: v("oro-400"), 500: v("oro-500"), 600: v("oro-600"),
        700: v("oro-700"), 800: v("oro-800"),
      },
      verde: { 400: v("verde-400"), 500: v("verde-500"), 600: v("verde-600") },
      rojo:  { 400: v("rojo-400"),  500: v("rojo-500"),  600: v("rojo-600")  },
      blanco: v("blanco"),
      cempasuchil: { 400: v("cempasuchil-400"), 500: v("cempasuchil-500") },
      rosa: { 400: v("rosa-400") },
      turquesa: { 400: v("turquesa-400") },
      morado: { 400: v("morado-400") },

      /* semantic — reach for these first */
      bg: v("bg"),
      surface: {
        DEFAULT: v("surface"),
        raised: v("surface-raised"),
        sunken: v("surface-sunken"),
        inset: v("surface-inset"),
        hover: v("surface-hover"),
      },
      ink: {
        DEFAULT: v("text"),
        strong: v("text-strong"),
        muted: v("text-muted"),
        subtle: v("text-subtle"),
        accent: v("text-accent"),
        inverse: v("text-inverse"),
        link: v("text-link"),
      },
      /* status aliases so app code reads like the domain, not the palette */
      live: v("rojo-400"),
      upcoming: v("oro-300"),
      final: v("bone-600"),
      favorite: v("verde-400"),
      underdog: v("rojo-400"),
    },

    borderColor: {
      DEFAULT: v("border"),
      strong: v("border-strong"),
      gold: v("border-gold"),
      "gold-hi": v("border-gold-hi"),
      verde: v("border-verde"),
      rojo: v("border-rojo"),
    },

    fontFamily: {
      display: v("font-display"),
      engraved: v("font-engraved"),
      body: v("font-body"),
      ui: v("font-ui"),
      data: v("font-data"),
    },

    fontSize: {
      "2xs": [v("text-2xs"), { lineHeight: v("leading-normal") }],
      xs: [v("text-xs"), { lineHeight: v("leading-normal") }],
      sm: [v("text-sm"), { lineHeight: v("leading-normal") }],
      base: [v("text-base"), { lineHeight: v("leading-normal") }],
      md: [v("text-md"), { lineHeight: v("leading-snug") }],
      lg: [v("text-lg"), { lineHeight: v("leading-snug") }],
      xl: [v("text-xl"), { lineHeight: v("leading-snug") }],
      "2xl": [v("text-2xl"), { lineHeight: v("leading-tight") }],
      "3xl": [v("text-3xl"), { lineHeight: v("leading-tight") }],
      "4xl": [v("text-4xl"), { lineHeight: v("leading-tight") }],
    },

    lineHeight: {
      tight: v("leading-tight"), snug: v("leading-snug"),
      normal: v("leading-normal"), relaxed: v("leading-relaxed"),
    },

    letterSpacing: {
      tight: v("tracking-tight"), normal: v("tracking-normal"),
      wide: v("tracking-wide"), wider: v("tracking-wider"),
      widest: v("tracking-widest"),
    },

    fontWeight: {
      regular: v("weight-regular"), medium: v("weight-medium"), bold: v("weight-bold"),
    },

    spacing: {
      1: v("space-1"), 2: v("space-2"), 3: v("space-3"), 4: v("space-4"),
      5: v("space-5"), 6: v("space-6"), 8: v("space-8"), 10: v("space-10"),
      12: v("space-12"), 16: v("space-16"),
    },

    borderRadius: {
      none: v("radius-none"), xs: v("radius-xs"), sm: v("radius-sm"),
      DEFAULT: v("radius-md"), md: v("radius-md"), lg: v("radius-lg"),
      xl: v("radius-xl"), full: v("radius-pill"),
    },

    boxShadow: {
      1: v("shadow-1"),
      2: v("shadow-2"),
      3: v("shadow-3"),
      gold: v("shadow-gold"),
      live: v("shadow-live"),
      emboss: v("emboss"),
      debossed: v("debossed"),
      focus: v("focus-ring"),
    },

    textShadow: { ink: v("ink-shadow") }, // v4 has text-shadow-* natively

    backgroundImage: {
      night: v("bg-gradient"),
      foil: v("gradient-foil"),
      tricolor: v("gradient-tricolor"),
      "surface-gold": v("surface-gold"),
      grain: v("texture-grain"),
      fibre: v("texture-fibre"),
      "rule-engraved": v("rule-engraved"),
    },

    maxWidth: {
      container: v("container"),
      "container-narrow": v("container-narrow"),
    },

    transitionTimingFunction: { noche: v("ease"), "noche-out": v("ease-out") },
    transitionDuration: { fast: v("dur-fast"), DEFAULT: v("dur"), slow: v("dur-slow") },

    keyframes: {
      "noche-ping": {
        "0%": { transform: "scale(.6)", opacity: ".9" },
        "70%,100%": { transform: "scale(1.9)", opacity: "0" },
      },
      "noche-breathe": { "0%,100%": { opacity: "1" }, "50%": { opacity: ".35" } },
    },
    animation: {
      "noche-ping": "noche-ping 1.8s var(--noche-ease-out) infinite",
      "noche-breathe": "noche-breathe 2.6s ease-in-out infinite",
    },
  },
};

/* -----------------------------------------------------------------------------
   Plugin: a `noche:` variant, plus the two utilities that are awkward to
   express with stock Tailwind classes.
   -------------------------------------------------------------------------- */
const plugin = function ({ addVariant, addUtilities }) {
  // <div class="noche:border-gold"> — applies only inside the theme
  addVariant("noche", '&:where([data-theme="noche"] *)');
  addVariant("noche-root", '[data-theme="noche"] &');

  addUtilities({
    ".text-foil": {
      background: v("gradient-foil"),
      "-webkit-background-clip": "text",
      "background-clip": "text",
      "-webkit-text-fill-color": "transparent",
      color: "transparent",
      filter: "drop-shadow(0 1px 0 rgba(0,0,0,.55))",
    },
    ".tabular": {
      "font-variant-numeric": "tabular-nums",
      "font-feature-settings": '"tnum" 1',
    },
  });
};

module.exports = { theme, plugin, v };

/* -----------------------------------------------------------------------------
   Cheat sheet — the mock dashboard rebuilt in utilities
   -----------------------------------------------------------------------------
   Fight card
     class="bg-surface border border-DEFAULT rounded-md shadow-2 overflow-hidden"

   Main-event card
     class="bg-surface-raised border border-gold rounded-md shadow-gold"

   Matchup row
     class="grid grid-cols-[1fr_auto_1fr] items-center gap-3 p-4
            border-b border-DEFAULT hover:bg-white/[.035]"

   Fighter name
     class="font-display font-bold text-md tracking-tight text-ink-strong"

   Odds chip (favourite)
     class="font-data tabular text-sm px-2 py-[3px] rounded-xs
            text-verde-400 border border-verde bg-verde-500/10 shadow-debossed"

   Main-event badge
     class="font-engraved text-[10px] uppercase tracking-wider px-2 py-[3px]
            rounded-xs bg-foil text-night-950 font-bold"

   Live pill
     class="inline-flex items-center gap-2 font-engraved text-2xs uppercase
            tracking-wider px-[9px] py-1 rounded-full text-live
            border border-rojo bg-rojo-500/[.14] shadow-live"
     dot: class="w-[7px] h-[7px] rounded-full bg-current animate-noche-breathe"

   Primary button
     class="inline-flex items-center justify-center gap-2 min-h-10 px-[1.1rem]
            font-engraved text-xs uppercase tracking-wide rounded-sm
            bg-foil text-night-950 font-bold border border-oro-300"

   Event title
     class="font-display text-4xl uppercase tracking-tight leading-[.92] text-foil"

   Stat table cell
     class="font-data tabular text-right px-4 py-3 text-bone-100
            border-t border-DEFAULT"
   -------------------------------------------------------------------------- */
