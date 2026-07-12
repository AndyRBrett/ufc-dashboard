// Syntax-check the Supabase edge functions before they can deploy.
//
// deploy-functions.yml ships these straight to production on push to main —
// including ai-breakdown, which calls the paid Anthropic API. A typo there
// used to reach prod and only surface as a confusing `supabase deploy` failure
// (leaving the previous version live) or a broken function in production.
//
// esbuild parses TypeScript syntax without resolving the Deno URL imports (no
// network, no type-checking of remote deps), so it reliably catches the
// broken-edit class in milliseconds and gives a precise file:line error.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FN_DIR = join(ROOT, "supabase", "functions");

if (!existsSync(FN_DIR)) { console.log("check-functions: no supabase/functions dir — skipping."); process.exit(0); }

const entries = readdirSync(FN_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(FN_DIR, d.name, "index.ts"))
  .filter(existsSync);

let failures = 0;
for (const file of entries) {
  const rel = file.slice(ROOT.length + 1);
  try {
    await transform(readFileSync(file, "utf8"), { loader: "ts", format: "esm" });
    console.log("  ✓ " + rel);
  } catch (e) {
    failures++;
    const msg = (e.errors && e.errors[0]) ? `${e.errors[0].text} (line ${e.errors[0].location?.line})` : e.message;
    console.error("  ✗ " + rel + ": " + msg);
  }
}

if (!entries.length) { console.error("check-functions: found no function index.ts files — parser issue?"); process.exit(1); }
if (failures) { console.error(`\ncheck-functions: ${failures} function(s) have syntax errors — DO NOT deploy.`); process.exit(1); }
console.log(`\ncheck-functions: all ${entries.length} edge function(s) parse.`);
