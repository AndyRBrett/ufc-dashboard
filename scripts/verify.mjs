// `npm run verify`: every gate in `verify:serial`, run in parallel.
//
// The gates ran one after another (~46 of them, ~6 minutes locally), though
// none depends on another: each serves its own port-0 server, writes only to
// its own temp dir, and reads the repo. This runs the same list, parsed from
// package.json's `verify:serial` (so there is still one list, the one
// check:web holds validate-web.yml to), in a small pool. Each gate's output is
// buffered and printed whole only if it fails, so a failure reads the way it
// does run alone. The exit code is non-zero if any gate failed, as before.
//
//   npm run verify             the pool (VERIFY_JOBS overrides its size)
//   npm run verify:serial      the old one-at-a-time chain, unchanged
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function gates(pkg) {
  const chain = pkg.scripts && pkg.scripts["verify:serial"];
  if (typeof chain !== "string") throw new Error("package.json has no verify:serial script");
  const list = [...chain.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
  if (!list.length || chain.split("&&").length !== list.length) throw new Error("verify:serial must be `npm run X && npm run Y && …`, nothing else");
  return list;
}

// Browser gates are the heavy ones; more than the core count only adds
// contention (each boots Chromium), so the pool tracks the machine.
export function poolSize(env = process.env, cpus = os.cpus().length) {
  const n = parseInt(env.VERIFY_JOBS || "", 10);
  return n > 0 ? n : Math.max(1, Math.min(cpus, 6));
}

function run(gate) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("npm", ["run", "-s", gate], { cwd: ROOT, env: process.env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ gate, code, out, secs: (Date.now() - started) / 1000 }));
    child.on("error", (e) => resolve({ gate, code: 1, out: String(e), secs: (Date.now() - started) / 1000 }));
  });
}

async function main() {
  const list = gates(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")));
  const jobs = poolSize();
  const t0 = Date.now(), queue = [...list], results = [];
  console.log(`verify: ${list.length} gates, ${jobs} at a time`);
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (queue.length) {
      const r = await run(queue.shift());
      results.push(r);
      console.log(`  ${r.code === 0 ? "✓" : "✗"} ${r.gate.padEnd(20)} ${r.secs.toFixed(1)}s`);
    }
  }));
  const failed = results.filter((r) => r.code !== 0);
  for (const r of failed) {
    console.error(`\n──── ${r.gate} (exit ${r.code}) ────\n${r.out.trimEnd()}`);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (failed.length) {
    console.error(`\nverify: ${failed.length} of ${list.length} gate(s) FAILED in ${secs}s: ${failed.map((r) => r.gate).join(", ")} — DO NOT push.`);
    process.exit(1);
  }
  console.log(`\nverify: all ${list.length} gates passed in ${secs}s.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
