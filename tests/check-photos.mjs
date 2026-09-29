// Guard: a fighter's photo is looked up once, correctly, and a miss heals.
//
// The lookup used to ask Wikipedia for the bare name only. "Chris Curtis" and
// "Makoto Takahashi" are disambiguation pages (the fighters are "... (fighter)"),
// so they never got a photo, and the miss was written to localStorage as "none"
// FOREVER. An in-flight lookup was persisted as null too, which a reload read as
// "still loading" and never retried. The PFL / RIZIN / DWCS view had no photo
// code at all. All of it is one block in index.html now (`fighter-photos:`
// markers), used by both views; this runs that real block against a stubbed
// Wikipedia shaped like the real replies (checked 2026-09-28).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));

const block = (html.match(/\/\/ fighter-photos:start\n([\s\S]*?)\/\/ fighter-photos:end/) || [])[1];
check("the fighter-photos block exists exactly once", !!block && html.split("// fighter-photos:start").length === 2);
if (!block) process.exit(1);

// The reply shapes, keyed by the (normalised) title asked for.
const THUMB = (n) => ({ source: "https://upload.wikimedia.org/wikipedia/commons/thumb/" + n + ".jpg/96px-" + n + ".jpg", width: 96, height: 96 });
const PAGES = {
  "Alex Pereira": { description: "Brazilian kickboxer and mixed martial artist (born 1987)", thumbnail: THUMB("AP") },
  "Chris Curtis": { description: "Topics referred to by the same term" },                      // disambiguation: no image
  "Chris Curtis (fighter)": { description: "American mixed martial artist (born 1987)", thumbnail: THUMB("CC") },
  "Makoto Takahashi": { description: "Topics referred to by the same term" },
  "Makoto Takahashi (fighter)": { description: "Japanese mixed martial artist (born 2000)", thumbnail: THUMB("MT") },
  "Jordan Smith": { description: "English actor (born 1990)", thumbnail: THUMB("ACTOR") },        // someone else's face
  "Jordan Smith (fighter)": { description: "American mixed martial artist", thumbnail: THUMB("JS") },
  "Nina Nobody": { description: "Brazilian mixed martial artist" },                            // a fighter with no image
  "Redirected Name": { redirectTo: "Redirected Target" },
  "Redirected Target": { description: "Canadian boxer", thumbnail: THUMB("RT") },
};
function reply(titles) {
  const asked = titles.split("|"), pages = [], redirects = [];
  for (const t of asked) {
    let title = t, p = PAGES[t];
    if (p && p.redirectTo) { redirects.push({ from: t, to: p.redirectTo }); title = p.redirectTo; p = PAGES[title]; }
    if (!p) { pages.push({ title, missing: true }); continue; }
    pages.push(Object.assign({ title }, p.description ? { description: p.description } : {}, p.thumbnail ? { thumbnail: p.thumbnail } : {}));
  }
  return { batchcomplete: true, query: { redirects, pages } };
}

function boot(store = {}, opts = {}) {
  const calls = [], saved = {}, slots = [];
  const ctx = {
    calls, saved, slots,
    _safeImgUrl: (u) => (typeof u === "string" && u.startsWith("https://upload.wikimedia.org/") ? u : null),
    _setPhoto: (slot, src) => slot.photo = src,
    _saveJSON: (k, o) => { saved[k] = JSON.parse(JSON.stringify(o)); },
    Date: { now: () => opts.now || 1e12 },
    FIGHTER_PHOTOS: store.photos || {}, FIGHTER_PHOTO_MISS: store.miss || {},
    fetch: (url) => {
      calls.push(decodeURIComponent(url));
      if (opts.fail) return Promise.reject(new Error("offline"));
      const titles = new URL(url).searchParams.get("titles");
      return Promise.resolve({ ok: true, json: async () => reply(titles) });
    },
  };
  const fn = new Function(...Object.keys(ctx), block + "\nreturn {_photoInto, _photoCandidates, _photoFromReply, FIGHTER_PHOTOS, FIGHTER_PHOTO_MISS};");
  return Object.assign(fn(...Object.values(ctx)), { ctx });
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const slot = () => ({ photo: null });

// 1. one request carries the name and its disambiguated titles
{
  const m = boot(), s = slot();
  m._photoInto(s, "Chris Curtis"); await settle();
  check("one request, asking for the name and its (fighter) titles", m.ctx.calls.length === 1 &&
    /titles=Chris Curtis\|Chris Curtis \(fighter\)\|Chris Curtis \(mixed martial artist\)/.test(m.ctx.calls[0]) && /redirects=1/.test(m.ctx.calls[0]));
  check("a disambiguation page is skipped for the fighter's own page", /\/CC\.jpg\//.test(s.photo || ""));
  check("the hit is remembered (and persisted) with no miss recorded", /CC\.jpg/.test(m.FIGHTER_PHOTOS["Chris Curtis"]) && m.ctx.saved.ufc_photos2["Chris Curtis"] && !m.FIGHTER_PHOTO_MISS["Chris Curtis"]);
}
// 2. the bare name works, and a redirect is followed
{
  const m = boot(), a = slot(), b = slot();
  m._photoInto(a, "Alex Pereira"); m._photoInto(b, "Redirected Name"); await settle();
  check("a plain fighter page is used", /\/AP\.jpg\//.test(a.photo || ""));
  check("a redirect is followed to its target", /\/RT\.jpg\//.test(b.photo || ""));
}
// 3. someone else's face is never shown
{
  const m = boot(), s = slot();
  m._photoInto(s, "Jordan Smith"); await settle();
  check("a same-named non-fighter is skipped for the fighter's page", /\/JS\.jpg\//.test(s.photo || "") && !/ACTOR/.test(s.photo));
  PAGES["Jordan Smith (fighter)"].thumbnail = null;
  const m2 = boot(), s2 = slot();
  m2._photoInto(s2, "Jordan Smith"); await settle();
  check("...and with no fighter photo at all, shows initials rather than the actor", s2.photo === null && !!m2.FIGHTER_PHOTO_MISS["Jordan Smith"]);
  PAGES["Jordan Smith (fighter)"].thumbnail = THUMB("JS");
}
// 4. one lookup fills every slot for a name
{
  const m = boot(), a = slot(), b = slot(), c = slot();
  m._photoInto(a, "Alex Pereira"); m._photoInto(b, "Alex Pereira"); m._photoInto(c, "Alex Pereira"); await settle();
  check("three cards for one fighter make one request and all get the photo", m.ctx.calls.length === 1 && a.photo && b.photo && c.photo);
  const d = slot(); m._photoInto(d, "Alex Pereira");
  check("a cached photo fills a slot synchronously, with no request", d.photo && m.ctx.calls.length === 1);
}
// 5. misses heal
{
  const m = boot(), s = slot();
  m._photoInto(s, "Nina Nobody"); await settle();
  check("no photo: a miss is recorded with its time, not stored as a photo", s.photo === null && m.FIGHTER_PHOTO_MISS["Nina Nobody"] === 1e12 && !m.FIGHTER_PHOTOS["Nina Nobody"]);
  const fresh = boot({ miss: { "Nina Nobody": 1e12 } }, { now: 1e12 + 6 * 864e5 }); fresh._photoInto(slot(), "Nina Nobody"); await settle();
  check("a miss under a week old is not asked again", fresh.ctx.calls.length === 0);
  const stale = boot({ miss: { "Nina Nobody": 1e12 } }, { now: 1e12 + 8 * 864e5 }); stale._photoInto(slot(), "Nina Nobody"); await settle();
  check("a miss over a week old is retried (a page may exist by now)", stale.ctx.calls.length === 1);
  const off = boot({}, { fail: true }); off._photoInto(slot(), "Alex Pereira"); await settle();
  check("a network failure records NO miss, so the next visit retries", !off.FIGHTER_PHOTO_MISS["Alex Pereira"] && !off.ctx.saved.ufc_photo_miss);
  off._photoInto(slot(), "Alex Pereira"); await settle();
  check("...but is not hammered again within the same visit", off.ctx.calls.length === 1);
}
// 6. hostile names
{
  const m = boot();
  check("pipes and underscores in a name can't smuggle in extra titles", m._photoCandidates("A|B_C").every((t) => !t.includes("|")) && m._photoCandidates("A|B_C")[0] === "A B C");
  check("a blank name asks for nothing", m._photoCandidates("  ").length === 0);
  const s = slot(); m._photoInto(s, "  "); await settle();
  check("...and makes no request", m.ctx.calls.length === 0);
  const bad = m._photoFromReply({ query: { pages: [{ title: "X", description: "American boxer", thumbnail: { source: "https://evil.example/x.jpg" } }] } }, ["X"]);
  check("a thumbnail off Wikimedia is refused", bad === null);
}
// 7. wiring: both views use it, and the old permanent miss is gone
check("the UFC rows use _photoInto", /_photoInto\(phWrap,fighter\.n\)/.test(html));
check("the sport view uses _photoInto", /_photoInto\(av,nm\)/.test(html));
check("no lookup stores a miss as \"none\" any more", !/FIGHTER_PHOTOS\[[^\]]+\]\s*=\s*"none"/.test(html) && !/FIGHTER_PHOTOS\[[^\]]+\]\s*=\s*null/.test(html));
check("old cached photos are migrated, misses dropped", /getItem\("ufc_photos"\)/.test(html) && /\^https:/.test(html.slice(html.indexOf("var FIGHTER_PHOTOS"), html.indexOf("var FIGHTER_PHOTOS") + 900)));

if (failures) { console.error("\ncheck:photos — " + failures + " failure(s)"); process.exit(1); }
console.log("\ncheck:photos — all good");
