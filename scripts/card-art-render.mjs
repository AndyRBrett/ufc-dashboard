// Rasterise lab/cards/src/*.svg to lab/cards/*.jpg (1080x1620) with the
// pinned headless Chromium, so the served art is a small JPEG the card and
// its share image can both draw. Run after editing scripts/card_art.py:
//   python3 scripts/card_art.py && node scripts/card-art-render.mjs
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(join(ROOT, "package.json"))("playwright");
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1080, height: 1620 } });
for (const f of readdirSync(join(ROOT, "lab/cards/src")).filter((f) => f.endsWith(".svg"))) {
  await page.setContent(`<html><body style="margin:0">${readFileSync(join(ROOT, "lab/cards/src", f), "utf8")}</body></html>`);
  await page.screenshot({ path: join(ROOT, "lab/cards", f.replace(/\.svg$/, ".jpg")), type: "jpeg", quality: 80, clip: { x: 0, y: 0, width: 1080, height: 1620 } });
  console.log("rendered", f);
}
await browser.close();
