// Optional, non-destructive production build.
//
// Reads the canonical source files (index.html, data.js, sw.js, …) and writes
// minified copies to dist/. The source files are NOT modified, so the current
// "serve raw files" deploy keeps working unchanged — point a host at dist/ only
// when you've verified it on a preview. `npm run build` regenerates dist/.
//
// Safety note: the inline JS is compressed but NOT name-mangled, because ~180
// inline onclick/oninput handlers in index.html reference global functions by
// name (e.g. onclick="saveName()"). Renaming them would break those handlers.

import { minify as minifyHtml } from "html-minifier-terser";
import { minify as minifyJs } from "terser";
import { readFile, writeFile, mkdir, cp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUT = "dist";
const kb = (n) => (n / 1024).toFixed(1) + "K";

async function sizeOf(p) {
  try { return (await stat(p)).size; } catch { return 0; }
}

async function run() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // index.html — minify the HTML shell plus its inline CSS and inline JS.
  const html = await readFile("index.html", "utf8");
  const minHtml = await minifyHtml(html, {
    collapseWhitespace: true,
    conservativeCollapse: true, // keep one space where whitespace is significant
    removeComments: true,
    minifyCSS: true,
    minifyJS: { compress: true, mangle: false }, // never rename — see note above
    keepClosingSlash: true,
    caseSensitive: true,
  });
  await writeFile(`${OUT}/index.html`, minHtml);

  // Standalone JS — compress only, no mangling (data.js is data; sw.js needs its names).
  for (const f of ["data.js", "sw.js"]) {
    const code = await readFile(f, "utf8");
    const res = await minifyJs(code, { compress: true, mangle: false });
    await writeFile(`${OUT}/${f}`, res.code ?? code);
  }

  // Static assets copied verbatim.
  for (const f of ["manifest.json", "icon-192-v2.png", "icon-512-v2.png"]) {
    if (existsSync(f)) await cp(f, `${OUT}/${f}`);
  }
  for (const d of ["fonts", "sounds"]) {
    if (existsSync(d)) await cp(d, `${OUT}/${d}`, { recursive: true });
  }

  // Report the savings on the files that actually shrink.
  for (const f of ["index.html", "data.js", "sw.js"]) {
    const before = await sizeOf(f);
    const after = await sizeOf(`${OUT}/${f}`);
    if (before) {
      const pct = ((1 - after / before) * 100).toFixed(0);
      console.log(`${f.padEnd(12)} ${kb(before)} -> ${kb(after)}  (-${pct}%)`);
    }
  }
  console.log(`\nBuild complete -> ${OUT}/`);
}

run().catch((e) => { console.error(e); process.exit(1); });
