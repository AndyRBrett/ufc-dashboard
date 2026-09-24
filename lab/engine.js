// Pick Engine — the sport-agnostic core underneath the UFC app.
//
// The app itself (index.html) is still the one that takes picks, locks bouts and
// scores the board. This module is the layer beside it that everything in the
// Fight Lab (lab.html) and FightBot (fightbot/server.mjs) reads through:
//
//   Promotion → Event → Segment → Bout → Competitor
//
// Data arrives through ADAPTERS (ufcAdapter reads data.js; feedAdapter reads a
// curated JSON feed for PFL / ONE / boxing), and picks are scored by RULES.
//
// One rule this file exists to keep: the UFC rules are NOT a copy of the app's
// scoring. loadKernel() lifts the real blocks out of index.html — the same
// `// name:start … // name:end` markers the test suite already drives — so a
// score here can never drift from the board. check:lab fails the build if a
// marker this depends on is renamed or removed.
//
// Plain script, no imports: runs as a <script> in the browser (sets
// window.PickEngine) and under node via vm / new Function.
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- kernel --
  // Blocks and functions pulled out of index.html. Everything listed here is
  // pure: it reads only its arguments and the data.js globals passed in below.
  var KERNEL_BLOCKS = ["fighter-names", "pick-match", "model"];
  var KERNEL_FNS = ["isMainCardBout", "isEarlyPrelimBout", "_eventFinished", "_lbScoreUsers", "intelKey", "intelItemsFor"];
  var KERNEL_EXPORTS = [
    "nmKey", "nmEq", "nmBout", "splitNick",
    "dogPtsFor", "dogPtsForPick", "userPts", "locksOn", "isLockPick", "lockPtsFor",
    "pickPts", "scoreMethod", "_findFightResult", "_isMainCardPick", "_eventFinished",
    "_lbScoreUsers", "isMainCardBout", "isEarlyPrelimBout", "intelKey", "intelItemsFor",
    "modelProb", "modelImplied", "modelDeVig", "modelEdge",
    "DOG_TIERS", "LOCKS_PER_CARD", "LOCK_HIT", "LOCK_MISS", "LOCKS_START"
  ];

  function sliceBlock(html, name) {
    var a = html.indexOf("// " + name + ":start"), b = html.indexOf("// " + name + ":end");
    if (a < 0 || b < 0 || b < a) throw new Error("kernel: index.html has no // " + name + ":start … :end block");
    return html.slice(a, b);
  }
  // A top-level function by brace matching — the same approach the test suite
  // uses on these same functions, so if it ever mis-slices, CI sees it first.
  function sliceFn(html, name) {
    var a = html.indexOf("function " + name + "(");
    if (a < 0) throw new Error("kernel: index.html has no function " + name);
    var i = html.indexOf("{", a), depth = 0;
    for (; i < html.length; i++) {
      var c = html[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return html.slice(a, i + 1);
    }
    throw new Error("kernel: unbalanced function " + name);
  }
  function sliceSplitNick(html) {
    var a = html.indexOf("var _EMOJI_HEAD=");
    if (a < 0) throw new Error("kernel: index.html has no _EMOJI_HEAD");
    var fnSrc = sliceFn(html, "splitNick");
    var b = html.indexOf("function splitNick(");
    return html.slice(a, b) + fnSrc;
  }

  // env: { EVENTS, RESULTS_ARCHIVE, FIGHTER_STATS, RANKINGS, USER_ID? }
  // compile(params, body) → function. Defaults to new Function (node, tests,
  // FightBot); lab.html passes one that injects an inline <script> instead, so
  // the page keeps a CSP without 'unsafe-eval'.
  function loadKernel(html, env, compile) {
    env = env || {};
    var src = [sliceSplitNick(html)]
      .concat(KERNEL_BLOCKS.map(function (n) { return sliceBlock(html, n); }))
      .concat(KERNEL_FNS.map(function (n) { return sliceFn(html, n); }))
      .join("\n;\n");
    var params = ["EVENTS", "RESULTS_ARCHIVE", "FIGHTER_STATS", "RANKINGS", "USER_ID",
                  "MAIN_CARD_BOUTS", "DAY_MS", "lbScope", "userName", "_lbRows", "_commRows", "console"];
    var ret = "return {" + KERNEL_EXPORTS.map(function (n) {
      return JSON.stringify(n) + ":(typeof " + n + "!=='undefined'?" + n + ":undefined)";
    }).join(",") + "};";
    /* jshint evil:true */
    var factory = (compile || function (p, b) { return new Function(p.join(","), b); })(params, src + "\n;\n" + ret);
    var quiet = { log: function () {}, warn: function () {}, error: function () {} };
    var k = factory(env.EVENTS || [], env.RESULTS_ARCHIVE || {}, env.FIGHTER_STATS || {},
                    env.RANKINGS || {}, env.USER_ID || null, 5, 86400000, "all", "", null, null, quiet);
    KERNEL_EXPORTS.forEach(function (n) {
      if (k[n] === undefined) throw new Error("kernel: " + n + " missing after load — renamed in index.html?");
    });
    return k;
  }

  // ------------------------------------------------------------ primitives --
  function americanToProb(o) {
    if (typeof o !== "number" || !isFinite(o) || o === 0) return null;
    return o < 0 ? (-o) / ((-o) + 100) : 100 / (o + 100);
  }
  // Both sides, margin divided out — the only fair basis for "the market thinks".
  function deVig(a, b) {
    var pa = americanToProb(a), pb = americanToProb(b);
    if (pa === null || pb === null || !(pa + pb > 0)) return null;
    return { a: pa / (pa + pb), b: pb / (pa + pb) };
  }
  function simpleKey(n) {
    var s = String(n == null ? "" : n);
    if (s.normalize) s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return s.toLowerCase().replace(/[.,'’`‘\-]/g, " ").replace(/\b(?:jr|sr|ii|iii|iv)\b/g, " ").replace(/\s+/g, " ").trim();
  }
  function simpleEq(a, b) { var x = simpleKey(a); return !!x && x === simpleKey(b); }
  function surname(n) { var p = simpleKey(n).split(" "); return p[p.length - 1] || ""; }
  function pairKey(a, b) { return [simpleKey(a), simpleKey(b)].sort().join("|"); }
  function segmentOf(label) {
    if (label === "Main Event" || label === "Co-Main" || label === "Main Card") return "main";
    if (label === "Early Prelim") return "early";
    return "prelims";
  }
  function divisionGroup(wc) {
    var s = String(wc || "");
    if (!s) return "Unknown";
    if (/catch/i.test(s)) return "Catchweight";
    return s.replace(/\s*\(.*\)\s*/, "").trim();
  }
  function methodGroup(m) {
    var s = String(m || "").toUpperCase();
    if (!s) return "";
    if (s.indexOf("SUB") >= 0) return "Sub";
    if (s.indexOf("KO") >= 0) return "KO/TKO";
    if (s.indexOf("DEC") >= 0 || s === "UD" || s === "SD" || s === "MD") return "Dec";
    return "Other";
  }

  // -------------------------------------------------------------- adapters --
  // Each adapter turns one source into normalized events. `promotion` is the
  // namespace every id below is scoped by, so two promotions on one Saturday
  // never share a bout id.
  function makeBout(evId, i, src) {
    var comps = [src.a, src.b];
    return {
      id: evId + "#" + pairKey(comps[0].name, comps[1].name),
      eventId: evId, order: i, label: src.label || "",
      segment: src.segment || segmentOf(src.label),
      division: src.division || "", title: !!src.title,
      competitors: comps,
      result: src.winner ? { winner: src.winner, method: src.method || "", round: src.round || null } : null,
      state: src.state || (src.winner ? "post" : "pre"),
      raw: src.raw || null
    };
  }

  function ufcAdapter(env) {
    return {
      id: "ufc",
      promotion: { id: "ufc", name: "UFC", sport: "mma" },
      events: function () {
        var out = [], seen = {};
        (env.EVENTS || []).forEach(function (ev) {
          var id = "ufc:" + ev.date + ":" + (ev.slug || ev.name);
          seen[ev.date] = true;
          var segs = [{ id: "main", name: "Main Card", time: ev.time || null }];
          if (ev.prelimTime) segs.push({ id: "prelims", name: "Prelims", time: ev.prelimTime });
          if (ev.earlyPrelimTime) segs.push({ id: "early", name: "Early Prelims", time: ev.earlyPrelimTime });
          out.push({
            id: id, promotion: "ufc", name: ev.name, date: ev.date, venue: ev.venue || "",
            location: ev.loc || "", broadcast: ev.tv || "", segments: segs, source: "live",
            fotn: ev.fotn || null, slug: ev.slug || "",
            bouts: (ev.fights || []).map(function (f, i) {
              return makeBout(id, i, {
                label: f.lbl, division: f.wc, title: f.title, winner: f.winner, method: f.method,
                round: f.round, state: f.state, raw: f,
                a: { name: f.f1.n, record: f.f1.r || "", rank: f.f1.rk || "", odds: f.odds ? f.odds.f1 : null },
                b: { name: f.f2.n, record: f.f2.r || "", rank: f.f2.rk || "", odds: f.odds ? f.odds.f2 : null }
              });
            })
          });
        });
        // Cards that aged out of the live window live on in the archive.
        var arc = env.RESULTS_ARCHIVE || {};
        Object.keys(arc).forEach(function (date) {
          if (seen[date]) return;
          var a = arc[date], id = "ufc:" + date + ":archive";
          out.push({
            id: id, promotion: "ufc", name: a.name || ("UFC — " + date), date: date, venue: "", location: "",
            broadcast: "", segments: [{ id: "main", name: "Main Card", time: null }], source: "archive",
            fotn: null, slug: "",
            bouts: (a.fights || []).map(function (f, i) {
              return makeBout(id, i, {
                label: f.lbl || (i < 5 ? "Main Card" : "Prelim"), division: f.wc || "", winner: f.winner,
                method: f.method, state: f.winner ? "post" : "pre", raw: f,
                a: { name: f.f1, record: "", rank: "", odds: f.odds ? f.odds.f1 : null },
                b: { name: f.f2, record: "", rank: "", odds: f.odds ? f.odds.f2 : null }
              });
            })
          });
        });
        return out;
      }
    };
  }

  // A curated feed for promotions the scraper doesn't cover (events-extra.json).
  // It is untrusted input: an invalid event is dropped with a reason, never
  // half-loaded, and a feed can't publish under the "ufc" namespace — the UFC
  // card comes from data.js only, so the feed can't shadow or duplicate it.
  var FEED_DATE = /^\d{4}-\d{2}-\d{2}$/;
  function validateFeed(feed) {
    var problems = [], promos = {}, events = [];
    if (!feed || typeof feed !== "object") return { promotions: [], events: [], problems: ["feed is not an object"] };
    (Array.isArray(feed.promotions) ? feed.promotions : []).forEach(function (p, i) {
      if (!p || typeof p.id !== "string" || !/^[a-z0-9-]{2,20}$/.test(p.id)) return problems.push("promotion #" + i + ": bad id");
      if (p.id === "ufc") return problems.push("promotion #" + i + ": 'ufc' is reserved for data.js");
      promos[p.id] = { id: p.id, name: String(p.name || p.id).slice(0, 40), sport: String(p.sport || "mma").slice(0, 20) };
    });
    (Array.isArray(feed.events) ? feed.events : []).forEach(function (e, i) {
      var why = !e ? "empty" : !promos[e.promotion] ? "unknown promotion " + JSON.stringify(e.promotion)
        : !FEED_DATE.test(e.date || "") ? "bad date" : !e.name ? "no name"
        : !Array.isArray(e.bouts) || !e.bouts.length ? "no bouts" : "";
      if (!why) e.bouts.forEach(function (b, j) {
        if (why) return;
        if (!b || !b.a || !b.b || typeof b.a !== "string" || typeof b.b !== "string") why = "bout #" + j + " needs two names";
        else if (simpleEq(b.a, b.b)) why = "bout #" + j + " has one fighter twice";
        else if (b.winner && !simpleEq(b.winner, b.a) && !simpleEq(b.winner, b.b)) why = "bout #" + j + " winner isn't in the bout";
      });
      if (why) return problems.push("event #" + i + ": " + why);
      events.push(e);
    });
    return { promotions: Object.keys(promos).map(function (k) { return promos[k]; }), events: events, problems: problems };
  }
  function feedAdapter(feed) {
    var v = validateFeed(feed);
    return {
      id: "feed", problems: v.problems, promotionsList: v.promotions,
      events: function () {
        return v.events.map(function (e) {
          var id = e.promotion + ":" + e.date + ":" + simpleKey(e.name).replace(/ /g, "-");
          var num = function (x) { return typeof x === "number" && isFinite(x) ? x : null; };
          return {
            id: id, promotion: e.promotion, name: String(e.name), date: e.date, venue: String(e.venue || ""),
            location: String(e.location || ""), broadcast: String(e.broadcast || ""), source: "feed",
            segments: [{ id: "main", name: "Main Card", time: e.time || null }], fotn: null, slug: "",
            bouts: e.bouts.map(function (b, i) {
              var odds = b.odds || {};
              return makeBout(id, i, {
                label: b.label || (i === 0 ? "Main Event" : "Main Card"), division: b.division || "",
                title: !!b.title, winner: b.winner || "", method: b.method || "", round: b.round || null,
                a: { name: b.a, record: b.aRecord || "", rank: "", odds: num(odds.a) },
                b: { name: b.b, record: b.bRecord || "", rank: "", odds: num(odds.b) }
              });
            })
          };
        });
      }
    };
  }

  // ----------------------------------------------------------------- rules --
  // A ruleset answers two questions: are these the same competitor, and what is
  // this pick worth against this result. The UFC one is the app's own code.
  function ufcRules(kernel) {
    return {
      id: "ufc",
      same: kernel.nmEq,
      isLock: kernel.isLockPick,
      score: function (pick, bout) {
        if (!bout || !bout.result || !bout.result.winner) return 0;
        // The line rides on the source bout exactly as the board reads it
        // (EVENTS' frozen closing line; archived cards carry none, so no bonus).
        var odds = (bout.raw && bout.raw.odds) || null;
        return kernel.pickPts(pick.raw || pick, {
          winner: bout.result.winner, method: bout.result.method || "", odds: odds,
          f1n: bout.competitors[0].name, f2n: bout.competitors[1].name
        });
      }
    };
  }
  // Default rules for a feed promotion: 1 for the winner, +0.5 for the method.
  function simpleRules(opts) {
    opts = opts || {};
    var W = opts.winner == null ? 1 : opts.winner, M = opts.method == null ? 0.5 : opts.method;
    return {
      id: "simple", same: simpleEq, isLock: function () { return false; },
      score: function (pick, bout) {
        if (!bout || !bout.result || !simpleEq(bout.result.winner, pick.pick)) return 0;
        return W + (pick.method && pick.method === methodGroup(bout.result.method) ? M : 0);
      }
    };
  }

  // ---------------------------------------------------------------- engine --
  function createEngine(opts) {
    var adapters = opts.adapters || [];
    var rulesBy = opts.rules || {};
    var events = [], promotions = {}, index = {};
    adapters.forEach(function (ad) {
      if (ad.promotion) promotions[ad.promotion.id] = ad.promotion;
      (ad.promotionsList || []).forEach(function (p) { promotions[p.id] = p; });
      ad.events().forEach(function (ev) { events.push(ev); });
    });
    events.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    events.forEach(function (ev) {
      ev.bouts.forEach(function (b) {
        index[ev.promotion + "|" + ev.date + "|" + pairKey(b.competitors[0].name, b.competitors[1].name)] = { event: ev, bout: b };
      });
    });
    function rulesFor(promo) { return rulesBy[promo] || rulesBy["default"] || simpleRules(); }

    function findBout(date, a, b, promo) {
      promo = promo || "ufc";
      var hit = index[promo + "|" + date + "|" + pairKey(a, b)];
      if (hit) return hit;
      // Slow path: the ruleset's own name equality (accents, suffixes, a
      // scrape that flipped the corners) — the same match the board makes.
      var same = rulesFor(promo).same;
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.promotion !== promo || ev.date !== date) continue;
        for (var j = 0; j < ev.bouts.length; j++) {
          var c = ev.bouts[j].competitors;
          if ((same(c[0].name, a) && same(c[1].name, b)) || (same(c[0].name, b) && same(c[1].name, a)))
            return { event: ev, bout: ev.bouts[j] };
        }
      }
      return null;
    }

    // Picks rows (the Supabase `picks` table) → normalized, resolved picks.
    // Identity is user_id, falling back to nickname — the board's own key.
    function resolvePicks(rows, promo) {
      promo = promo || "ufc";
      var rules = rulesFor(promo), out = [];
      (rows || []).forEach(function (r) {
        if (!r || !r.pick) return;
        var hit = findBout(r.event_date, r.f1, r.f2, promo);
        var bout = hit && hit.bout, res = bout && bout.result;
        var decided = !!(res && res.winner);
        var mine = null;
        if (bout) mine = rules.same(bout.competitors[0].name, r.pick) ? 0 : rules.same(bout.competitors[1].name, r.pick) ? 1 : null;
        out.push({
          player: r.user_id || r.nickname || "unknown", nickname: r.nickname || "", userId: r.user_id || null,
          date: r.event_date, pick: r.pick, method: r.method || "", locked: !!rules.isLock(r),
          updatedAt: r.updated_at || null, event: hit ? hit.event : null, bout: bout || null, side: mine,
          decided: decided, correct: decided ? rules.same(res.winner, r.pick) : null,
          points: decided ? rules.score({ raw: r, pick: r.pick, method: r.method }, bout) : 0,
          raw: r
        });
      });
      return out;
    }

    function upcoming(now, promo) {
      var today = isoDate(now || new Date());
      return events.filter(function (ev) {
        return (!promo || ev.promotion === promo) && ev.date >= today && ev.bouts.some(function (b) { return !b.result; });
      });
    }

    return {
      events: function (promo) { return promo ? events.filter(function (e) { return e.promotion === promo; }) : events.slice(); },
      promotions: function () { return Object.keys(promotions).map(function (k) { return promotions[k]; }); },
      findBout: findBout,
      resolvePicks: resolvePicks,
      rulesFor: rulesFor,
      upcoming: upcoming,
      nextEvent: function (now, promo) { return upcoming(now, promo)[0] || null; },
      concluded: function (promo) {
        return events.filter(function (ev) {
          return (!promo || ev.promotion === promo) && ev.bouts.length && ev.bouts.some(function (b) { return b.result; });
        });
      }
    };
  }

  // The board shows one row per person. A device reset leaves a ghost
  // identity (new user_id, same nickname — sometimes a different case or
  // emoji), and _lbScoreUsers collapses those by base name, keeping the
  // identity with more picks (yours, when it's you). Every reader of the
  // picks table goes through this so the Lab and FightBot list the same
  // people the board does — never "T" twice. The board's own code decides.
  function boardRows(kernel, rows) {
    rows = rows || [];
    var keep = {};
    kernel._lbScoreUsers(rows).forEach(function (u) { keep[u.user_id || u.nickname || "unknown"] = true; });
    return rows.filter(function (r) { return keep[r.user_id || r.nickname || "unknown"]; });
  }

  function isoDate(d) {
    var dt = d instanceof Date ? d : new Date(d);
    return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
  }

  var api = {
    loadKernel: loadKernel, sliceBlock: sliceBlock, sliceFn: sliceFn,
    KERNEL_BLOCKS: KERNEL_BLOCKS, KERNEL_FNS: KERNEL_FNS,
    ufcAdapter: ufcAdapter, feedAdapter: feedAdapter, validateFeed: validateFeed,
    ufcRules: ufcRules, simpleRules: simpleRules, createEngine: createEngine, boardRows: boardRows,
    americanToProb: americanToProb, deVig: deVig, simpleKey: simpleKey, simpleEq: simpleEq,
    surname: surname, pairKey: pairKey, segmentOf: segmentOf, divisionGroup: divisionGroup,
    methodGroup: methodGroup, isoDate: isoDate
  };
  root.PickEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
