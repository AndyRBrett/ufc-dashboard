// Fight Lab analytics — everything here is deterministic arithmetic over what
// the app already stores: resolved picks (PickEngine.resolvePicks), the odds
// history (odds-series.json), fighter stats and Fight Week Intel. No model
// call, no metered API, nothing written anywhere.
//
// Two rules keep the numbers honest:
//   * Every insight carries its sample size, and nothing is claimed below
//     MIN_SAMPLE decided picks. "You're 2–0 on heavyweights" isn't a trait.
//   * Market numbers are de-vigged (both sides, margin divided out) before
//     anything is compared to them, the same way the app's fight model does.
(function (root) {
  "use strict";
  var PE = root.PickEngine;
  var MIN_SAMPLE = 5;
  var STEAM_PP = 4;            // a ≥4-point move inside 24h reads as steam
  var DAY = 86400000;

  function pct(n, d) { return d ? Math.round(n / d * 1000) / 10 : null; }
  function rec(list) {
    var w = 0, l = 0;
    list.forEach(function (p) { if (p.correct === true) w++; else if (p.correct === false) l++; });
    return { w: w, l: l, n: w + l, pct: pct(w, w + l) };
  }
  function round1(x) { return Math.round(x * 10) / 10; }
  function fmtRec(r) { return r.w + "W–" + r.l + "L"; }   // labelled: "7–16" read as a fighter record was taken backwards

  // ---------------------------------------------------------- odds history --
  // odds-series.json keys events as "YYYY-MM-DD:slug" in UTC, and sometimes
  // names a fighter by surname alone, so a bout is matched by name pair (full
  // or surname) within two days of the card — never by exact id.
  function oddsIndex(series) {
    var byPair = {}, bySur = {};
    ((series && series.events) || []).forEach(function (ev) {
      var date = String(ev.event_id || "").slice(0, 10);
      (ev.bouts || []).forEach(function (b) {
        var entry = { date: date, eventId: ev.event_id, concluded: !!ev.concluded, bout: b };
        var pk = PE.pairKey(b.f1, b.f2), sk = [PE.surname(b.f1), PE.surname(b.f2)].sort().join("|");
        (byPair[pk] = byPair[pk] || []).push(entry);
        (bySur[sk] = bySur[sk] || []).push(entry);
      });
    });
    function near(list, date) {
      if (!list) return null;
      var t = Date.parse(date + "T00:00:00Z"), best = null;
      list.forEach(function (e) {
        var gap = Math.abs(Date.parse(e.date + "T00:00:00Z") - t);
        if (gap > 2 * DAY) return;
        var pts = (e.bout.series || []).length;
        if (!best || pts > best.pts || (pts === best.pts && gap < best.gap)) best = { e: e, pts: pts, gap: gap };
      });
      return best ? best.e : null;
    }
    return {
      // → { series:[{at,a,b}], open:{a,b}, close:{a,b}|null, current:{a,b} } oriented to (a, b)
      lookup: function (date, a, b) {
        var e = near(byPair[PE.pairKey(a, b)], date) || near(bySur[[PE.surname(a), PE.surname(b)].sort().join("|")], date);
        if (!e) return null;
        var bt = e.bout;
        var flip = !(PE.simpleEq(bt.f1, a) || PE.surname(bt.f1) === PE.surname(a));
        var o = function (pt) { return pt ? (flip ? { a: pt.f2_odds, b: pt.f1_odds, at: pt.at } : { a: pt.f1_odds, b: pt.f2_odds, at: pt.at }) : null; };
        var s = (bt.series || []).map(o);
        return { series: s, open: o(bt.open) || s[0] || null, close: o(bt.close), current: s[s.length - 1] || o(bt.open), concluded: e.concluded };
      }
    };
  }
  function probOf(line, side) { var d = line && PE.deVig(line.a, line.b); return d ? (side === 0 ? d.a : d.b) : null; }
  // The line a pick was made against: the last point at or before the pick's
  // updated_at (an edited pick is judged from its final edit), else the open.
  function lineAt(hist, iso) {
    if (!hist) return null;
    var t = iso ? Date.parse(iso) : NaN, hit = null;
    if (isFinite(t)) hist.series.forEach(function (p) { if (Date.parse(p.at) <= t) hit = p; });
    return hit || hist.open;
  }
  // A picked side's price: the card's own frozen line first, then history.
  function pickedOdds(p, idx) {
    if (!p.bout || p.side === null) return null;
    var c = p.bout.competitors[p.side];
    if (typeof c.odds === "number") return c.odds;
    var h = idx && idx.lookup(p.date, p.bout.competitors[0].name, p.bout.competitors[1].name);
    var line = h && (h.close || h.current);
    return line ? (p.side === 0 ? line.a : line.b) : null;
  }
  function pickCLV(p, idx) {
    if (!p.bout || p.side === null || !idx) return null;
    var h = idx.lookup(p.date, p.bout.competitors[0].name, p.bout.competitors[1].name);
    if (!h) return null;
    var at = lineAt(h, p.updatedAt), close = h.close || (p.decided ? h.current : null);
    var pa = probOf(at, p.side), pc = probOf(close, p.side);
    if (pa === null || pc === null) return null;
    return { atPick: p.side === 0 ? at.a : at.b, close: p.side === 0 ? close.a : close.b, pp: round1((pc - pa) * 100) };
  }

  // ---------------------------------------------------------------- styles --
  function styleOf(st) {
    if (!st || !(st.slpm > 0 || st.td > 0)) return null;
    if (st.td >= 2 || (st.td >= 1.2 && st.sub > st.ko)) return "grappler";
    if (st.slpm >= 3.5 || st.ko >= st.sub) return "striker";
    return null;
  }
  // Was the fighter on a 3-fight win streak GOING INTO this bout? The stats
  // cache is today's, so its form already includes the bout being judged (and
  // everything after it). Read only the fights before it, found by opponent;
  // if the bout isn't in the list we can't place it, so we don't guess.
  function streakBefore(st, opponent) {
    var f = st && st.form, opp = st && st.opp;
    if (!f || !opp) return null;
    for (var i = 0; i < opp.length; i++) {
      if (PE.simpleEq(opp[i], opponent)) {
        var prior = f.slice(i + 1, i + 4);
        return prior.length === 3 && prior.every(function (x) { return x.r === "W"; });
      }
    }
    return null;
  }

  // --------------------------------------------------------------- Fight IQ --
  // ctx: { odds: oddsIndex, stats: FIGHTER_STATS, group: all resolved picks }
  function fightIQ(mine, ctx) {
    ctx = ctx || {};
    var stats = ctx.stats || {}, idx = ctx.odds || null;
    var decided = mine.filter(function (p) { return p.decided && p.side !== null; });
    var all = rec(decided);
    var pts = 0; mine.forEach(function (p) { pts += p.points || 0; });
    // Card bonus (Fight of the Night), once per card, the way _lbScoreUsers
    // adds it: the player's bonus_pick for that date against the event's fotn.
    // Rows come in the board's order and the last one seen for a date wins,
    // exactly as the board's bonusPicks[date] assignment does.
    var bonusBy = {}, evBy = {};
    mine.forEach(function (p) { if (p.raw && p.raw.bonus_pick) { bonusBy[p.date] = p.raw.bonus_pick; if (p.event) evBy[p.date] = p.event; } });
    var fotn = 0;
    Object.keys(bonusBy).forEach(function (d) { var ev = evBy[d]; if (ev && ev.fotn && bonusBy[d] === ev.fotn) fotn++; });
    pts += fotn;
    var splits = [];
    function split(kind, key, list) { var r = rec(list); if (r.n) splits.push({ kind: kind, key: key, rec: r }); }
    function groupBy(fn) {
      var m = {}; decided.forEach(function (p) { var k = fn(p); if (k) (m[k] = m[k] || []).push(p); }); return m;
    }

    var byDiv = groupBy(function (p) { return PE.divisionGroup(p.bout.division); });
    Object.keys(byDiv).forEach(function (k) { if (k !== "Unknown") split("division", k, byDiv[k]); });
    var bySeg = groupBy(function (p) { return p.bout.segment === "main" ? "Main card" : "Prelims"; });
    Object.keys(bySeg).forEach(function (k) { split("segment", k, bySeg[k]); });

    // Market role of the fighter picked.
    var priced = decided.map(function (p) { return { p: p, o: pickedOdds(p, idx) }; }).filter(function (x) { return typeof x.o === "number"; });
    var favs = priced.filter(function (x) { return x.o < 0; }).map(function (x) { return x.p; });
    var dogs = priced.filter(function (x) { return x.o > 0; }).map(function (x) { return x.p; });
    var bigDogs = priced.filter(function (x) { return x.o >= 200; }).map(function (x) { return x.p; });
    split("market", "Favorites", favs); split("market", "Underdogs", dogs); split("market", "+200 or longer", bigDogs);

    // Style of the fighter picked against the style of the opponent.
    var byStyle = groupBy(function (p) {
      var me = styleOf(stats[p.bout.competitors[p.side].name]), op = styleOf(stats[p.bout.competitors[1 - p.side].name]);
      return me && op && me !== op ? (me === "grappler" ? "Grapplers over strikers" : "Strikers over grapplers") : null;
    });
    Object.keys(byStyle).forEach(function (k) { split("style", k, byStyle[k]); });
    split("form", "Fighters on a 3+ win streak", decided.filter(function (p) {
      return streakBefore(stats[p.bout.competitors[p.side].name], p.bout.competitors[1 - p.side].name) === true;
    }));

    // Method calls: a method is only "right" when the winner was too.
    var meth = decided.filter(function (p) { return p.method; });
    var methHit = meth.filter(function (p) { return p.correct && PE.methodGroup(p.bout.result.method) === p.method; }).length;

    var locks = decided.filter(function (p) { return p.locked; });
    split("locks", "Locks", locks);

    // Against the group: contrarian picks, and head-to-head disagreements.
    var group = ctx.group || [], tally = {}, byBoutPlayer = {};
    group.forEach(function (g) {
      if (!g.bout || g.side === null) return;
      var t = tally[g.bout.id] = tally[g.bout.id] || [0, 0]; t[g.side]++;
      (byBoutPlayer[g.bout.id] = byBoutPlayer[g.bout.id] || []).push(g);
    });
    var contrarian = decided.filter(function (p) {
      var t = tally[p.bout.id]; return t && t[0] + t[1] >= 3 && t[p.side] < t[1 - p.side];
    });
    split("crowd", "Against the group", contrarian);
    var rivals = {};
    decided.forEach(function (p) {
      (byBoutPlayer[p.bout.id] || []).forEach(function (g) {
        if (g.player === p.player || g.side === p.side) return;
        var r = rivals[g.player] = rivals[g.player] || { nickname: g.nickname, list: [] };
        if (g.nickname) r.nickname = g.nickname;
        r.list.push(p);
      });
    });
    var rivalry = Object.keys(rivals).map(function (k) { return { player: k, nickname: rivals[k].nickname, rec: rec(rivals[k].list) }; })
      .filter(function (r) { return r.rec.n >= MIN_SAMPLE; })
      .sort(function (a, b) { return b.rec.n - a.rec.n; });

    // Closing-line value across every pick we can price at both ends.
    var clvs = mine.map(function (p) { return pickCLV(p, idx); }).filter(Boolean);
    var avgClv = clvs.length ? round1(clvs.reduce(function (s, c) { return s + c.pp; }, 0) / clvs.length) : null;

    // Worst active lock skid.
    var lockSkid = 0;
    // Newest first: by card date, then — for two locks on one card — by when
    // the result landed. Results arrive prelims first, main event last, so a
    // lower bout order is the later result.
    locks.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.bout.order - b.bout.order;
    }).some(function (p) { if (p.correct) return true; lockSkid++; return false; });

    // Insights: splits that differ from the player's own baseline, by enough
    // and on enough picks to be worth a sentence.
    var base = all.pct || 0, insights = [];
    splits.forEach(function (s) {
      if (s.rec.n < MIN_SAMPLE || s.kind === "segment") return;
      var gap = s.rec.pct - base;
      if (Math.abs(gap) < 8 && s.kind !== "market") return;
      insights.push({ kind: s.kind, weight: Math.abs(gap) * Math.sqrt(s.rec.n), good: gap >= 0,
        text: describe(s, gap) });
    });
    rivalry.slice(0, 3).forEach(function (r) {
      insights.push({ kind: "rival", weight: Math.abs(r.rec.pct - 50) * Math.sqrt(r.rec.n) / 2, good: r.rec.w >= r.rec.l,
        text: "When you and " + r.nickname + " disagree, you're " + fmtRec(r.rec) + "." });
    });
    if (lockSkid >= 3) insights.push({ kind: "locks", weight: lockSkid * 10, good: false, text: "Your last " + lockSkid + " locks all missed. 🔒💀" });
    if (avgClv !== null && clvs.length >= MIN_SAMPLE)
      insights.push({ kind: "clv", weight: Math.abs(avgClv) * 3, good: avgClv >= 0,
        text: "The market moved " + (avgClv >= 0 ? "toward" : "away from") + " your picks by " + Math.abs(avgClv) + " points on average after you made them (" + clvs.length + " picks)." });
    insights.sort(function (a, b) { return b.weight - a.weight; });

    var shares = {
      dog: priced.length ? dogs.length / priced.length : 0,
      fav: priced.length ? favs.length / priced.length : 0,
      contrarian: decided.length ? contrarian.length / decided.length : 0,
      finish: meth.length ? meth.filter(function (p) { return p.method !== "Dec"; }).length / meth.length : 0,
      grappler: decided.length ? decided.filter(function (p) { return styleOf(stats[p.bout.competitors[p.side].name]) === "grappler"; }).length / decided.length : 0
    };
    return {
      record: all, points: Math.round(pts * 10) / 10, fotn: fotn, picks: mine.length, splits: splits,
      methods: { called: meth.length, hit: methHit, pct: pct(methHit, meth.length) },
      locks: rec(locks), lockSkid: lockSkid, clv: { avg: avgClv, n: clvs.length },
      rivals: rivalry, shares: shares, insights: insights.slice(0, 8),
      archetype: archetype(all, shares, rec(locks), meth.length)
    };
  }
  function describe(s, gap) {
    var r = s.rec, tail = " (" + fmtRec(r) + ", " + r.pct + "%)";
    var dir = gap >= 0 ? "better" : "worse";
    switch (s.kind) {
      case "division": return "You're " + Math.abs(Math.round(gap)) + " points " + dir + " than usual picking " + s.key + tail + ".";
      case "market": return s.key === "Favorites" ? "Backing the favorite: " + r.pct + "%" + tail.replace(/, [\d.]+%/, "") + "."
        : "Picking " + s.key.toLowerCase() + ": you hit " + r.pct + "% of them" + tail.replace(/, [\d.]+%/, "") + ".";
      case "style": return s.key + ": " + r.pct + "%" + tail.replace(/, [\d.]+%/, "") + " — " + (gap >= 0 ? "a real edge." : "a blind spot.");
      case "form": return gap >= 0 ? "Riding hot streaks works for you" + tail + "." : "You overrate fighters on winning streaks" + tail + ".";
      case "crowd": return gap >= 0 ? "Going against the group pays off" + tail + "." : "When you fade the group, the group is usually right" + tail + ".";
      case "locks": return "Your locks: " + fmtRec(r) + " (" + r.pct + "%).";
      default: return s.key + tail;
    }
  }
  var ARCHETYPES = {
    casual: { emoji: "🍿", name: "Casual", blurb: "Not enough decided picks to read you yet." },
    oracle: { emoji: "🔮", name: "Oracle", blurb: "Picks at a rate the market would respect." },
    lock: { emoji: "🔒", name: "Lock Merchant", blurb: "When you say it's a lock, it usually is." },
    dog: { emoji: "🐶", name: "Dog Hunter", blurb: "Lives on the plus side of the line." },
    chalk: { emoji: "🧱", name: "Chalk Eater", blurb: "Takes the favorite and dares anyone to argue." },
    contrarian: { emoji: "🙃", name: "Contrarian", blurb: "If the group likes it, you don't." },
    grappling: { emoji: "🤼", name: "Grappling Nerd", blurb: "Trusts the wrestler, every time." },
    chaos: { emoji: "💥", name: "Chaos Merchant", blurb: "Expects every fight to end early." },
    solid: { emoji: "🥋", name: "Student of the Game", blurb: "Balanced picker — no single tell." }
  };
  function archetype(all, s, locks, methodsCalled) {
    var key;
    if (all.n < 10) key = "casual";
    else if (all.pct >= 65 && all.n >= 20) key = "oracle";
    else if (locks.n >= 4 && locks.pct >= 70) key = "lock";
    else if (s.dog >= 0.35) key = "dog";
    else if (s.contrarian >= 0.35) key = "contrarian";
    else if (s.fav >= 0.85) key = "chalk";
    else if (s.grappler >= 0.5) key = "grappling";
    else if (methodsCalled >= 10 && s.finish >= 0.75) key = "chaos";
    else key = "solid";
    var a = ARCHETYPES[key];
    return { key: key, emoji: a.emoji, name: a.name, blurb: a.blurb };
  }

  // ------------------------------------------------------------ Fight Market --
  function marketMovers(events, idx, now) {
    var out = [], t = (now || new Date()).getTime();
    events.forEach(function (ev) {
      ev.bouts.forEach(function (b) {
        if (b.result) return;
        var a = b.competitors[0], c = b.competitors[1];
        var h = idx.lookup(ev.date, a.name, c.name);
        if (!h || !h.open || !h.current) return;
        var p0 = probOf(h.open, 0), p1 = probOf(h.current, 0);
        if (p0 === null || p1 === null) return;
        var move = round1((p1 - p0) * 100);
        // Steam: the biggest 24h swing anywhere in the series.
        var steam = 0;
        for (var i = 0; i < h.series.length; i++) for (var j = i + 1; j < h.series.length; j++) {
          if (Date.parse(h.series[j].at) - Date.parse(h.series[i].at) > DAY) break;
          var d = (probOf(h.series[j], 0) - probOf(h.series[i], 0)) * 100;
          if (Math.abs(d) > Math.abs(steam)) steam = d;
        }
        var recent = h.series.filter(function (p) { return t - Date.parse(p.at) <= DAY; }).length;
        out.push({
          event: ev, bout: b, open: h.open, current: h.current, points: h.series.length,
          move: move, toward: move >= 0 ? a.name : c.name, steam: Math.abs(steam) >= STEAM_PP ? round1(Math.abs(steam)) : 0,
          dogGaining: (h.open.a > 0 && move > 0) || (h.open.b > 0 && move < 0), fresh: recent > 0
        });
      });
    });
    return out.sort(function (x, y) { return Math.abs(y.move) - Math.abs(x.move); });
  }
  // You vs the market: how often you won against how often the closing market
  // said the side you took would win.
  function versusMarket(mine, idx) {
    var rows = [];
    mine.forEach(function (p) {
      if (!p.decided || p.side === null) return;
      var h = idx && idx.lookup(p.date, p.bout.competitors[0].name, p.bout.competitors[1].name);
      var close = h && (h.close || h.current);
      var line = close || (typeof p.bout.competitors[0].odds === "number" ? { a: p.bout.competitors[0].odds, b: p.bout.competitors[1].odds } : null);
      var prob = probOf(line, p.side);
      if (prob === null) return;
      var moveAgainst = h && h.open ? probOf(h.open, p.side) - prob > 0.02 : false;
      rows.push({ p: p, prob: prob, fav: prob > 0.5, against: moveAgainst, clv: pickCLV(p, idx) });
    });
    var hits = rows.filter(function (r) { return r.p.correct; }).length;
    var exp = rows.reduce(function (s, r) { return s + r.prob; }, 0);
    var dogs = rows.filter(function (r) { return !r.fav; });
    var dogExp = dogs.reduce(function (s, r) { return s + r.prob; }, 0);
    var against = rows.filter(function (r) { return r.against; });
    var clvs = rows.map(function (r) { return r.clv; }).filter(Boolean);
    return {
      n: rows.length, accuracy: pct(hits, rows.length), expected: pct(exp, rows.length),
      edge: rows.length ? round1((hits - exp) / rows.length * 100) : null,
      favRate: pct(rows.filter(function (r) { return r.fav; }).length, rows.length),
      dogs: { n: dogs.length, hit: pct(dogs.filter(function (r) { return r.p.correct; }).length, dogs.length),
              vsExpected: dogs.length ? round1((dogs.filter(function (r) { return r.p.correct; }).length - dogExp) / dogs.length * 100) : null },
      againstMove: rec(against.map(function (r) { return r.p; })),
      avgClv: clvs.length ? round1(clvs.reduce(function (s, c) { return s + c.pp; }, 0) / clvs.length) : null,
      clvRows: rows.filter(function (r) { return r.clv; }).sort(function (a, b) { return Math.abs(b.clv.pp) - Math.abs(a.clv.pp); }).slice(0, 8)
    };
  }
  // Upcoming bouts where the group's majority is on the market's underdog.
  function crowdVsMarket(events, group, idx) {
    var out = [];
    events.forEach(function (ev) {
      ev.bouts.forEach(function (b) {
        if (b.result) return;
        var t = [0, 0];
        group.forEach(function (g) { if (g.bout === b && g.side !== null) t[g.side]++; });
        if (t[0] + t[1] < 2 || t[0] === t[1]) return;
        var h = idx.lookup(ev.date, b.competitors[0].name, b.competitors[1].name);
        var line = (h && h.current) || (typeof b.competitors[0].odds === "number" ? { a: b.competitors[0].odds, b: b.competitors[1].odds } : null);
        var p = probOf(line, 0);
        if (p === null) return;
        var crowd = t[0] > t[1] ? 0 : 1, mktFav = p >= 0.5 ? 0 : 1;
        if (crowd !== mktFav) out.push({ event: ev, bout: b, crowd: b.competitors[crowd].name, share: Math.round(Math.max(t[0], t[1]) / (t[0] + t[1]) * 100),
          market: b.competitors[mktFav].name, marketProb: Math.round((mktFav === 0 ? p : 1 - p) * 100) });
      });
    });
    return out;
  }

  // -------------------------------------------------------------- Fight Week --
  // ctx: { odds, intel, group, mine, edgeFor(bout)→{edge,side,model,market}|null, now }
  function fightWeekBrief(ev, ctx) {
    if (!ev) return null;
    var now = ctx.now || new Date();
    var days = Math.round((Date.parse(ev.date + "T00:00:00") - new Date(PE.isoDate(now) + "T00:00:00").getTime()) / DAY);
    var items = [];
    var movers = ctx.odds ? marketMovers([ev], ctx.odds, now) : [];
    var unpriced = ev.bouts.filter(function (b) { return typeof b.competitors[0].odds !== "number"; }).length;
    if (movers[0] && Math.abs(movers[0].move) >= 2) {
      var m = movers[0];
      var side = m.move >= 0 ? "a" : "b";
      items.push({ icon: "📉", text: "Biggest line move: " + m.toward + " " + fmtOdds(m.open[side]) + " → " + fmtOdds(m.current[side]) +
        " (" + Math.abs(m.move) + " pts" + (m.steam ? ", steam" : "") + ")" });
    }
    var steam = movers.filter(function (m) { return m.steam; }).length;
    if (steam > 1) items.push({ icon: "♨️", text: steam + " bouts have seen a 24-hour steam move." });
    if (unpriced) items.push({ icon: "⏳", text: unpriced + " of " + ev.bouts.length + " bouts have no line yet." });
    var intel = ctx.intel || [];
    if (intel.length) items.push({ icon: "📰", text: intel.length + " fight-week piece" + (intel.length === 1 ? "" : "s") + " curated for this card." });

    // The most disputed fight among the group.
    var disputed = null;
    ev.bouts.forEach(function (b) {
      var t = [0, 0];
      (ctx.group || []).forEach(function (g) { if (g.bout === b && g.side !== null) t[g.side]++; });
      var n = t[0] + t[1];
      if (n < 3) return;
      var split = Math.abs(t[0] - t[1]) / n;
      if (!disputed || split < disputed.split || (split === disputed.split && n > disputed.n)) disputed = { bout: b, t: t, n: n, split: split };
    });
    if (disputed) items.push({ icon: "🔥", text: "Most disputed: " + disputed.bout.competitors[0].name + " (" + disputed.t[0] + ") vs " +
      disputed.bout.competitors[1].name + " (" + disputed.t[1] + ")." });

    // The fights worth studying: where the app's own model and the market disagree most.
    var study = [];
    if (ctx.edgeFor) ev.bouts.forEach(function (b) {
      if (b.result) return;
      var e = ctx.edgeFor(b);
      if (e && e.market && e.edge >= 5) study.push({ bout: b, edge: e.edge, side: e.side, model: e.model, market: e.market });
    });
    study.sort(function (a, b) { return b.edge - a.edge; });

    var mine = (ctx.mine || []).filter(function (p) { return p.event === ev; });
    var open = ev.bouts.filter(function (b) { return !b.result; }).length;
    var picked = {};
    mine.forEach(function (p) { if (p.bout) picked[p.bout.id] = true; });
    var pickedN = Object.keys(picked).length;
    items.push({ icon: "🎯", text: "You've picked " + pickedN + " of " + ev.bouts.length + " bouts" +
      (open && pickedN < ev.bouts.length ? " — " + (ev.bouts.length - pickedN) + " to go." : ".") });
    return { event: ev, days: days, items: items, study: study.slice(0, 3), movers: movers.slice(0, 5), intel: intel.slice(0, 6) };
  }
  function fmtOdds(n) { return typeof n !== "number" ? "—" : n > 0 ? "+" + n : String(n); }

  // ---------------------------------------------------------- Matchup Lab --
  function parseInches(s) { var m = /(\d+)'\s*(\d+)?/.exec(String(s || "")); if (m) return +m[1] * 12 + (+m[2] || 0); var r = /(\d+(?:\.\d+)?)/.exec(String(s || "")); return r ? +r[1] : null; }
  function ageOf(dob, now) { var t = Date.parse(dob); if (!isFinite(t)) return null; return Math.floor(((now || new Date()) - t) / (365.25 * DAY)); }
  function matchup(a, b, ctx) {
    var S = ctx.stats || {}, sa = S[a], sb = S[b];
    if (!sa || !sb) return { a: a, b: b, missing: [!sa ? a : null, !sb ? b : null].filter(Boolean) };
    var now = ctx.now || new Date();
    var rows = [
      ["Record", sa.rec || "—", sb.rec || "—", null],
      ["Rank", ctx.rankings && ctx.rankings[a] ? "#" + ctx.rankings[a] : "—", ctx.rankings && ctx.rankings[b] ? "#" + ctx.rankings[b] : "—", null],
      ["Age", ageOf(sa.dob, now), ageOf(sb.dob, now), "lower"],
      ["Height", sa.ht || "—", sb.ht || "—", null, parseInches(sa.ht), parseInches(sb.ht)],
      ["Reach", sa.rch || "—", sb.rch || "—", "higher", parseInches(sa.rch), parseInches(sb.rch)],
      ["Stance", sa.stn || "—", sb.stn || "—", null],
      ["Strikes landed / min", sa.slpm, sb.slpm, "higher"],
      ["Striking accuracy %", sa.acc, sb.acc, "higher"],
      ["Takedowns / 15 min", sa.td, sb.td, "higher"],
      ["Takedown defense %", sa.tdd, sb.tdd, "higher"],
      ["KO wins", sa.ko, sb.ko, "higher"],
      ["Submission wins", sa.sub, sb.sub, "higher"]
    ].map(function (r) {
      var va = r.length > 4 ? r[4] : r[1], vb = r.length > 4 ? r[5] : r[2], edge = 0;
      if (r[3] && typeof va === "number" && typeof vb === "number" && va !== vb)
        edge = (r[3] === "higher" ? va > vb : va < vb) ? 1 : 2;
      return { label: r[0], a: r[1] == null ? "—" : r[1], b: r[2] == null ? "—" : r[2], edge: edge };
    });
    var form = function (st) { return (st.form || []).slice(0, 5).map(function (f) { return f.r; }).join(""); };
    var model = ctx.kernel ? ctx.kernel.modelProb(a, b, S, ctx.rankings || {}, ctx.archive || {}) : null;
    var notes = [];
    var sty = [styleOf(sa), styleOf(sb)];
    if (sty[0] && sty[1] && sty[0] !== sty[1]) notes.push("Classic style clash: " + (sty[0] === "grappler" ? a : b) + " wants it on the mat, " + (sty[0] === "striker" ? a : b) + " wants it standing.");
    var tdEdge = (sa.td || 0) - (sb.tdd || 0) / 30 - ((sb.td || 0) - (sa.tdd || 0) / 30);
    if (Math.abs(tdEdge) >= 1.5) notes.push((tdEdge > 0 ? a : b) + " has the cleaner path to takedowns.");
    var reach = [parseInches(sa.rch), parseInches(sb.rch)];
    if (reach[0] && reach[1] && Math.abs(reach[0] - reach[1]) >= 3) notes.push((reach[0] > reach[1] ? a : b) + " has a " + Math.abs(reach[0] - reach[1]) + "\" reach advantage.");
    var fin = function (st) { var r = /^(\d+)-(\d+)/.exec(st.rec || ""); var w = r ? +r[1] : 0; return w ? Math.round(((st.ko || 0) + (st.sub || 0)) / w * 100) : null; };
    var fa = fin(sa), fb = fin(sb);
    if (fa !== null && fb !== null && Math.abs(fa - fb) >= 25) notes.push((fa > fb ? a : b) + " finishes far more often (" + Math.max(fa, fb) + "% of wins vs " + Math.min(fa, fb) + "%).");
    if (model && model.factors) model.factors.slice(0, 3).forEach(function (f) { if (f && f.label) notes.push("Model factor: " + f.label + "."); });
    return { a: a, b: b, rows: rows, formA: form(sa), formB: form(sb), model: model, notes: notes,
      history: { a: (ctx.fighterOdds && ctx.fighterOdds[a]) || [], b: (ctx.fighterOdds && ctx.fighterOdds[b]) || [] } };
  }
  // How the app's model would have done on every archived result it can rate.
  // Walk-forward on results: each card is rated from an archive that stops
  // the day before it (the model replays results into its ratings, so handing
  // it the whole archive would let it read the answer). Fighter stats are
  // only usable when they were fetched before the bout (see below), so the
  // sample is small today and grows as cards pass after a stats refresh.
  function backtest(ctx) {
    var S = ctx.stats || {}, k = ctx.kernel, rows = [];
    if (!k) return null;
    var dates = Object.keys(ctx.archive || {}).sort(), leaked = 0;
    dates.forEach(function (date, di) {
      var prior = {};
      dates.slice(0, di).forEach(function (d) { prior[d] = ctx.archive[d]; });
      (ctx.archive[date].fights || []).forEach(function (f) {
        if (!f.winner || !S[f.f1] || !S[f.f2]) return;
        // Only bouts both fighters' stats were fetched BEFORE — otherwise the
        // record and form the model reads already contain this result, and the
        // hit rate is the model reading the answer back (it scored 87% that way).
        var t = Date.parse(date + "T00:00:00Z");
        if (!(Date.parse(S[f.f1].fetched_at) < t && Date.parse(S[f.f2].fetched_at) < t)) { leaked++; return; }
        // No rankings: today's rankings can already reflect this very result.
        var m = k.modelProb(f.f1, f.f2, S, {}, prior, new Date(t));
        if (!m || m.p1 === 0.5) return;
        var fav = m.p1 > 0.5 ? f.f1 : f.f2;
        var h = ctx.odds && ctx.odds.lookup(date, f.f1, f.f2), line = h && (h.close || h.current);
        var mk = probOf(line, 0);
        rows.push({ date: date, hit: PE.simpleEq(fav, f.winner), conf: Math.max(m.p1, m.p2),
          mktHit: mk === null || mk === 0.5 ? null : PE.simpleEq(mk > 0.5 ? f.f1 : f.f2, f.winner) });
      });
    });
    var hits = rows.filter(function (r) { return r.hit; }).length;
    var withMkt = rows.filter(function (r) { return r.mktHit !== null; });
    var brier = rows.length ? rows.reduce(function (s, r) { var p = r.conf; return s + Math.pow((r.hit ? 1 : 0) - p, 2); }, 0) / rows.length : null;
    return { n: rows.length, excluded: leaked, pct: pct(hits, rows.length), brier: brier === null ? null : Math.round(brier * 1000) / 1000,
      vsMarket: { n: withMkt.length, model: pct(withMkt.filter(function (r) { return r.hit; }).length, withMkt.length),
                  market: pct(withMkt.filter(function (r) { return r.mktHit; }).length, withMkt.length) } };
  }

  // ------------------------------------------------------------- Watch Party --
  // Replays one card's results in the order they land (prelims first, main
  // event last) and emits what a friend group would want on a second screen.
  function activityTicker(ev, group) {
    if (!ev) return [];
    var players = {}, feed = [];
    group.forEach(function (g) {
      if (g.event !== ev) return;
      var pl = players[g.player] = players[g.player] || { player: g.player, nickname: g.nickname, pts: 0 };
      if (g.nickname) pl.nickname = g.nickname;
    });
    var ids = Object.keys(players);
    if (!ids.length) return [];
    function order() {
      return ids.slice().sort(function (a, b) { return players[b].pts - players[a].pts || (players[a].nickname < players[b].nickname ? -1 : 1); });
    }
    var leader = null, before = order();
    ev.bouts.slice().reverse().forEach(function (b) {
      if (!b.result || !b.result.winner) return;
      var onBout = group.filter(function (g) { return g.bout === b; });
      var t = [0, 0]; onBout.forEach(function (g) { if (g.side !== null) t[g.side]++; });
      var win = PE.simpleEq(b.competitors[0].name, b.result.winner) ? 0 : 1;
      feed.push({ icon: "🥊", bout: b, text: b.result.winner + " def. " + b.competitors[1 - win].name + (b.result.method ? " — " + b.result.method : "") +
        (t[0] + t[1] ? " · " + t[win] + "/" + (t[0] + t[1]) + " called it" : "") });
      var upset = [], odds = b.competitors[win].odds;
      onBout.forEach(function (g) {
        players[g.player].pts += g.points || 0;
        if (g.locked) feed.push({ icon: g.correct ? "🎯" : "💥", bout: b, text: g.nickname + "'s lock " + (g.correct ? "hit" : "missed") + "." });
        if (g.correct && typeof odds === "number" && odds >= 150) upset.push(g.nickname);
      });
      if (upset.length) feed.push({ icon: "🐶", bout: b, text: listNames(upset) + " called the +" + odds + " upset." });
      if (t[0] + t[1] >= 3 && t[win] === 1) {
        var lone = onBout.filter(function (g) { return g.correct; })[0];
        if (lone) feed.push({ icon: "🧠", bout: b, text: lone.nickname + " was the only one who had it." });
      }
      var after = order();
      var top = after[0];
      if (players[top].pts > 0 && top !== leader && (after.length < 2 || players[top].pts > players[after[1]].pts)) {
        feed.push({ icon: "🏆", bout: b, text: players[top].nickname + (leader ? " has taken the lead." : " leads the card.") });
        leader = top;
      }
      after.forEach(function (id, i) {
        var was = before.indexOf(id);
        if (i === after.length - 1 && was < i && after.length >= 3) feed.push({ icon: "💀", bout: b, text: players[id].nickname + " dropped to last." });
      });
      before = after;
    });
    // Newest bout first, but each bout's own lines stay in reading order
    // (the result, then what it did to people).
    var groups = [];
    feed.forEach(function (x) { var g = groups[groups.length - 1]; if (!g || g.bout !== x.bout) groups.push(g = { bout: x.bout, items: [] }); g.items.push(x); });
    return groups.reverse().reduce(function (out, g) { return out.concat(g.items); }, []);
  }

  function listNames(n) { return n.length < 3 ? n.join(" and ") : n.slice(0, -1).join(", ") + " and " + n[n.length - 1]; }

  root.FightLab = {
    MIN_SAMPLE: MIN_SAMPLE, oddsIndex: oddsIndex, pickCLV: pickCLV, lineAt: lineAt, probOf: probOf,
    styleOf: styleOf, streakBefore: streakBefore, fmtOdds: fmtOdds, fightIQ: fightIQ, archetype: archetype, ARCHETYPES: ARCHETYPES,
    marketMovers: marketMovers, versusMarket: versusMarket, crowdVsMarket: crowdVsMarket,
    fightWeekBrief: fightWeekBrief, matchup: matchup, backtest: backtest, activityTicker: activityTicker
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
