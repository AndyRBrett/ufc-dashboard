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
// The REAL shape (probed on a GitHub runner 2026-09-29): thumb.wikimedia.org,
// with tracking parameters. A fixture on upload.wikimedia.org hid a CSP that
// refused every real photo.
const THUMB = (n) => ({ source: "https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f2/" + n + ".png/120px-" + n + ".png?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail", width: 120, height: 120 });
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
  // Accented article titles: the bare, unaccented name has no page at all.
  "Natália Silva (fighter)": { description: "Brazilian mixed martial arts fighter", thumbnail: THUMB("NS") },
  "Natalia Silvano": { description: "Brazilian mixed martial artist", thumbnail: THUMB("WRONG") },
  "Roberto Soldić": { description: "Croatian boxer and mixed martial artist", thumbnail: THUMB("RS") },
  "Roberto Soldic (actor)": { description: "Croatian actor", thumbnail: THUMB("ACTOR2") },
  // A fighter page with no photo (most UFC fighters, checked 2026-10-01).
  "Payton Talbott": { description: "American mixed martial artist (born 1998)" },
};
// What generator=search returns for a query, best first (real shape: pages
// carry an `index` rank, not array order).
const SEARCH = {
  "Natalia Silva": ["Natalia Silvano", "Natália Silva (fighter)"],
  "Roberto Soldic": ["Roberto Soldic (actor)", "Roberto Soldić"],
  "Payton Talbott": ["Payton Talbott"],
};
function searchReply(q) {
  const pages = (SEARCH[q] || []).map((t, i) => Object.assign({ title: t, index: i + 1 }, PAGES[t].description ? { description: PAGES[t].description } : {}, PAGES[t].thumbnail ? { thumbnail: PAGES[t].thumbnail } : {}));
  pages.reverse();
  return pages.length ? { query: { pages } } : { batchcomplete: true };
}
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

const safeSrc = (html.match(/function _safeImgUrl\(url\)\{[^\n]*\}/) || [])[0];
check("_safeImgUrl is found in index.html", !!safeSrc);
const _safeImgUrl = new Function(safeSrc + "\nreturn _safeImgUrl;")();

function boot(store = {}, opts = {}) {
  const calls = [], saved = {}, slots = [];
  const ctx = {
    calls, saved, slots,
    // The app's own filter, not a stand-in: a stub that only knew one host is
    // how the CSP mismatch went unseen.
    _safeImgUrl,
    _setPhoto: (slot, src, onfail) => { slot.photo = src; slot.onfail = onfail; },
    FIGHTER_ESPN: opts.espn || {},
    _saveJSON: (k, o) => { saved[k] = JSON.parse(JSON.stringify(o)); },
    Date: { now: () => opts.now || 1e12 },
    FIGHTER_PHOTOS: store.photos || {}, FIGHTER_PHOTO_MISS: store.miss || {},
    fetch: opts.fetch || ((url) => {
      calls.push(decodeURIComponent(url));
      if (opts.fail) return Promise.reject(new Error("offline"));
      const sp = new URL(url).searchParams;
      if (sp.get("generator") === "search") return Promise.resolve({ ok: true, json: async () => searchReply(sp.get("gsrsearch")) });
      return Promise.resolve({ ok: true, json: async () => reply(sp.get("titles")) });
    }),
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
  check("a disambiguation page is skipped for the fighter's own page", /\/CC\.png\//.test(s.photo || ""));
  check("the hit is remembered (and persisted) with no miss recorded", /CC\.png/.test(m.FIGHTER_PHOTOS["Chris Curtis"]) && m.ctx.saved.ufc_photos2["Chris Curtis"] && !m.FIGHTER_PHOTO_MISS["Chris Curtis"]);
}
// 2. the bare name works, and a redirect is followed
{
  const m = boot(), a = slot(), b = slot();
  m._photoInto(a, "Alex Pereira"); m._photoInto(b, "Redirected Name"); await settle();
  check("a plain fighter page is used", /\/AP\.png\//.test(a.photo || ""));
  check("a redirect is followed to its target", /\/RT\.png\//.test(b.photo || ""));
}
// 3. someone else's face is never shown
{
  const m = boot(), s = slot();
  m._photoInto(s, "Jordan Smith"); await settle();
  check("a same-named non-fighter is skipped for the fighter's page", /\/JS\.png\//.test(s.photo || "") && !/ACTOR/.test(s.photo));
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
// 6b. the browser must be allowed to DRAW what the lookup accepts
{
  const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || "";
  const imgSrc = ((csp.match(/img-src([^;]*)/) || [])[1] || "").trim().split(/\s+/);
  const allowed = (u) => imgSrc.some((s) => s === "https://" + new URL(u).host);
  const real = THUMB("X").source;
  check("the CSP img-src allows the host the API really returns (thumb.wikimedia.org)", allowed(real));
  const m = boot(); const s = slot();
  m._photoInto(s, "Alex Pereira"); await settle();
  check("every photo the lookup accepts is one the CSP lets the browser draw", !!s.photo && allowed(s.photo));
}
// 6c. never more than PHOTO_MAX_INFLIGHT requests open at once
{
  let open = 0, peak = 0;
  const m = boot({}, { fetch: (url) => { open++; peak = Math.max(peak, open); return new Promise((res) => setTimeout(() => { open--; const sp = new URL(url).searchParams; res({ ok: true, json: async () => sp.get("generator") === "search" ? searchReply(sp.get("gsrsearch")) : reply(sp.get("titles")) }); }, 5)); } });
  const names = Array.from({ length: 30 }, (_, i) => "Fighter Number" + i);
  const slots = names.map(() => slot());
  names.forEach((n, i) => m._photoInto(slots[i], n));
  await new Promise((r) => setTimeout(r, 400));
  check("30 lookups at once never open more than 4 requests", peak > 0 && peak <= 4);
  check("...and every one of them still gets its turn", Object.keys(m.FIGHTER_PHOTO_MISS).length === 30);
}
// 7. wiring: both views use it, and the old permanent miss is gone
check("the UFC rows use _photoInto, with ESPN only for UFC fighters", /_photoInto\(phWrap,fighter\.n,!fighter\.other\)/.test(html));
check("the sport view builds its rows with makeFighter (so it uses _photoInto too)", /function sportFightRow[\s\S]*?makeFighter\(f1,[\s\S]*?makeFighter\(f2,/.test(html));
check("no lookup stores a miss as \"none\" any more", !/FIGHTER_PHOTOS\[[^\]]+\]\s*=\s*"none"/.test(html) && !/FIGHTER_PHOTOS\[[^\]]+\]\s*=\s*null/.test(html));
const load = html.slice(html.indexOf("var FIGHTER_PHOTOS"), html.indexOf("var FIGHTER_PHOTOS") + 1200);
check("legacy ufc_photos hits are discarded, not migrated (they were never checked against the page)",
  !/getItem\("ufc_photos"\)/.test(load) && /getItem\("ufc_photos2"\)/.test(load) && /removeItem\("ufc_photos"\)/.test(load));

// 8. ESPN headshots first (most fighters' Wikipedia pages have no photo)
{
  const espn = { "Payton Talbott": "5144008", "Bad Id": "12/../x", "Proto Name": "1" };
  const m = boot({}, { espn }), s = slot();
  m._photoInto(s, "Payton Talbott", true); await settle();
  check("a UFC fighter with an ESPN id gets ESPN's resized headshot, with no Wikipedia request",
    s.photo === "https://a.espncdn.com/combiner/i?img=/i/headshots/mma/players/full/5144008.png&w=120&h=87" && m.ctx.calls.length === 0);
  check("...which the page's own filter and CSP both accept", _safeImgUrl(s.photo) === s.photo &&
    /img-src[^;]*https:\/\/a\.espncdn\.com/.test((html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/) || [])[1] || ""));
  s.photo = null; s.onfail(); await settle();
  check("a headshot that fails to load falls back to the Wikipedia lookup", m.ctx.calls.length >= 1 && /titles=Payton Talbott\|/.test(m.ctx.calls[0]));
  const o = boot({}, { espn }), so = slot();
  o._photoInto(so, "Payton Talbott", false); await settle();
  check("another promotion's fighter sharing a UFC name never gets the UFC fighter's ESPN face", !/espncdn/.test(so.photo || "") && o.ctx.calls.length >= 1);
  const b = boot({}, { espn }), sb = slot();
  b._photoInto(sb, "Bad Id", true); await settle();
  check("an ESPN id that isn't plain digits is ignored", !/espncdn/.test(sb.photo || ""));
  const p = boot({}, { espn: Object.create({ "Proto Name": "1" }) }), sp = slot();
  p._photoInto(sp, "Proto Name", true); await settle();
  check("only FIGHTER_ESPN's own keys count", !/espncdn/.test(sp.photo || ""));
  check("_safeImgUrl takes ESPN's image host only, not look-alikes",
    _safeImgUrl("https://a.espncdn.com/x.png") && !_safeImgUrl("https://evil.espncdn.com/x.png") && !_safeImgUrl("https://a.espncdn.com.evil.example/x.png") && !_safeImgUrl("http://a.espncdn.com/x.png"));
}
{
  // The test stubs _setPhoto; the real one must hand a load failure to onfail.
  const real = (html.match(/function _setPhoto\(container,src,onfail\)\{[\s\S]*?\n\}/) || [])[0] || "";
  const made = [];
  const doc = { createElement: () => { const img = { style: {} }; made.push(img); return img; } };
  new Function("document", real + "\nreturn _setPhoto;")(doc)({ style: {}, dataset: {}, appendChild() {} }, "https://a.espncdn.com/x.png", () => made.push("fell back"));
  if (made[0] && made[0].onerror) made[0].onerror();
  check("the real _setPhoto calls onfail when the image fails to load", made.includes("fell back"));
}
// 9. accented article titles are found by one search, and only by exact name
{
  const m = boot(), a = slot(), b = slot();
  m._photoInto(a, "Natalia Silva"); m._photoInto(b, "Roberto Soldic"); await settle(); await settle();
  check("\"Natalia Silva\" finds \"Natália Silva (fighter)\", skipping a higher-ranked different name", /\/NS\.png\//.test(a.photo || ""));
  check("\"Roberto Soldic\" finds \"Roberto Soldić\", never the same-named actor", /\/RS\.png\//.test(b.photo || ""));
  check("...cached like any hit", /NS\.png/.test(m.FIGHTER_PHOTOS["Natalia Silva"]) && /RS\.png/.test(m.FIGHTER_PHOTOS["Roberto Soldic"]));
  const t = boot(), st = slot();
  t._photoInto(st, "Payton Talbott"); await settle(); await settle();
  check("a fighter page with no photo is a miss with ONE request: search would only find that page again",
    st.photo === null && t.ctx.calls.length === 1 && !!t.FIGHTER_PHOTO_MISS["Payton Talbott"]);
  const n = boot(), sn = slot();
  n._photoInto(sn, "Nobody Atall"); await settle(); await settle();
  check("a name with no page anywhere is a miss after the search", sn.photo === null && n.ctx.calls.length === 2 && !!n.FIGHTER_PHOTO_MISS["Nobody Atall"]);
}

if (failures) { console.error("\ncheck:photos — " + failures + " failure(s)"); process.exit(1); }
console.log("\ncheck:photos — all good");
