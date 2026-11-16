// kernel.js — the fight model and the Fight Week Intel filters.
//
// The Pick Engine's kernel (lab/engine.js loadKernel) is the app's own code run
// beside it, so a number in the Fight Lab, FightBot or the Friday brief can
// never drift from the app. scoring.js is its scoring half; this file is the
// rest: the fight model (Elo + style matchup, shown next to the market price)
// and the two pure functions that decide which curated fight-week links belong
// under a card. Both used to sit inside index.html between `// name:start …
// :end` markers, so every reader downloaded and sliced the whole ~900 KB page
// to get ~280 lines, and index.html could never be minified without breaking
// them.
//
// Plain script, no imports, no DOM: index.html loads it right after scoring.js
// (intelItemsFor's nmEq comes from there); loadKernel runs it whole in the Lab,
// FightBot and the tests; `npm run build:fn` bundles it into send-reminders.
// Required by the app like scoring.js, and version-pinned the same way: on any
// change bump KERNEL_VERSION here, KERNEL_EXPECT and the script tag in
// index.html, and the precache URL in sw.js (check:lab fails if they disagree),
// then run `npm run build:fn`.
var KERNEL_VERSION="2026-11-16-1";

// ── Fight model: Elo + style matchup (#74) ──────────────────────────────
// The dashboard reads the market well (movement, CLV, sharp-vs-square) but had
// no independent view of who should win, so a line move looked the same whether
// it carried information or just public money. This is that second opinion: a
// rating rebuilt from results plus a few matchup differentials, shown next to
// the de-vigged market price. The number that matters is the DIVERGENCE — the
// market is right far more often than this is, so a gap is a prompt to look,
// not a pick.
//
// Everything here runs off data.js (RESULTS_ARCHIVE, FIGHTER_STATS, RANKINGS),
// costs one pass at first use, and degrades to "no model" for any fighter the
// stats cache hasn't seen — never to a wrong number.
// model:start
// MODEL_EDGE_MIN is the smallest model-vs-market gap worth naming, and
// MODEL_FLAG_MAX caps how many bouts a card may flag. The cap is the important
// half: this model is a rough second opinion (see the note above), its typical
// disagreement with the price is around 12 points, and badging every bout that
// clears a fixed bar would badge half the card and mean nothing. Flagging only
// the biggest gaps keeps the signal comparative — "the market and the model are
// furthest apart HERE" — which is the question worth asking.
var MODEL_BASE=1500,MODEL_K=24,MODEL_FINISH_K=1.2,MODEL_EDGE_MIN=12,MODEL_FLAG_MAX=3;
// The confidence a bout needs before it may carry the flag. Thin data doesn't
// just weaken the model, it INVERTS the badge: _mConfidence shrinks the model
// toward 50/50, and against a lopsided market (an 18/82 line) a coin flip is
// maximally divergent. So the bouts the model knew least about were producing
// the widest gaps and taking the badge off the honest disagreements — thin-data
// bouts averaged a 23-point gap against 10 for fully-known ones. The number
// still shows on these bouts; only the "widest gap" claim is withheld, because
// an absence of data is not a disagreement with the market.
var MODEL_FLAG_MIN_CONF=0.6;
function _mClamp(v,lo,hi){return v<lo?lo:v>hi?hi:v;}
function _mNum(v){return typeof v==="number"&&isFinite(v)?v:0;}
// Was this half of the profile actually scraped? The two blocks are asked about
// separately because a RECORDED ZERO is real data and must not be mistaken for a
// missing one: a counter-striker genuinely averages td 0 alongside a tdd of 70,
// and dropping his grappling term throws away that 70. So the test is whether
// the block was populated at all, never whether one stat is above zero.
//   - striking is populated when slpm is: nobody who has fought lands 0.00/min.
//   - grappling is populated when either td or tdd is: 0/0 is the scraper's
//     placeholder for a fighter with no UFC bouts logged yet, not a real line.
function _mHasStriking(st){return _mNum(st.slpm)>0;}
function _mHasGrappling(st){return _mNum(st.td)>0||_mNum(st.tdd)>0;}
// "24-3-1" → {w:24,l:3,d:1}. Anything else reads as an empty record rather than NaN.
function _mRecord(rec){
  var m=/^(\d+)-(\d+)-(\d+)/.exec(String(rec||""));
  return m?{w:+m[1],l:+m[2],d:+m[3]}:{w:0,l:0,d:0};
}
// '78"' → 78. Reach is the one physical edge that survives across divisions.
function _mInches(s){var m=/(\d+(?:\.\d+)?)/.exec(String(s||""));return m?parseFloat(m[1]):null;}
function _mAge(dob,now){
  if(!dob)return null;
  var t=Date.parse(dob);if(isNaN(t))return null;
  return ((now||Date.now())-t)/31557600000;
}
// Last five results, most recent first: a win is +1 (+0.4 if it was a finish),
// a loss −1. Decayed so last month outweighs last year.
function _mForm(form){
  if(!form||!form.length)return 0;
  var s=0,w=0;
  for(var i=0;i<form.length&&i<5;i++){
    var f=form[i],d=Math.pow(0.8,i),fin=/ko|tko|sub/i.test(f.m||"");
    var v=f.r==="W"?1+(fin?0.4:0):f.r==="L"?-1:0;
    s+=v*d;w+=d;
  }
  return w?s/w:0;
}
// Share of wins that came inside the distance — the finisher's tail the market
// prices in but a pure record does not.
function _mFinishRate(st){
  var r=_mRecord(st.rec);
  if(!r.w)return 0;
  return _mClamp((_mNum(st.ko)+_mNum(st.sub))/r.w,0,1);
}
// A fighter's starting rating before any archived result is replayed: career
// record, current divisional ranking, recent form.
function modelSeed(name,stats,rankings){
  var st=(stats||{})[name];
  if(!st)return null;
  var r=_mRecord(st.rec),fights=r.w+r.l;
  var winPct=fights?r.w/fights:0.5;
  // Win RATE, not win margin: a 12-0 prospect and a 24-12 journeyman have the
  // same +12 margin and the market treats them nothing alike. The margin still
  // contributes, but only as a small tiebreaker.
  var seed=MODEL_BASE+_mClamp(260*(winPct-0.5),-130,130)+_mClamp(4*(r.w-r.l),-40,40);
  var rk=(rankings||{})[name];
  if(rk)seed+=130-7*(rk-1);
  seed+=60*_mForm(st.form);
  return seed;
}
var _modelRatings=null;
// Elo over every archived result, seeded as above. K is bumped for finishes:
// stopping someone says more than out-pointing them.
function modelRatings(stats,rankings,archive){
  // Memoised only for the app's own data; a test or a what-if passing its own
  // tables always gets a fresh table.
  var memo=!stats&&!rankings&&!archive;
  if(memo&&_modelRatings)return _modelRatings;
  stats=stats||(typeof FIGHTER_STATS!=="undefined"?FIGHTER_STATS:{});
  rankings=rankings||(typeof RANKINGS!=="undefined"?RANKINGS:{});
  archive=archive||(typeof RESULTS_ARCHIVE!=="undefined"?RESULTS_ARCHIVE:{});
  // Seed EVERY known fighter, not just the ones the archive happens to mention.
  // Seeding lazily inside the replay left anyone who hasn't fought since the
  // archive began sitting at the 1500 baseline — which had a #2-ranked 23-3
  // lightweight rated as an unknown and produced a 59-point disagreement with
  // the market.
  var R={};
  for(var n0 in stats){
    if(!Object.prototype.hasOwnProperty.call(stats,n0))continue;
    var s0=modelSeed(n0,stats,rankings);
    if(s0!==null)R[n0]=s0;
  }
  function rating(n){
    if(!(n in R)){var s=modelSeed(n,stats,rankings);R[n]=s===null?MODEL_BASE:s;}
    return R[n];
  }
  var dates=Object.keys(archive).sort();
  for(var i=0;i<dates.length;i++){
    var fights=(archive[dates[i]]||{}).fights||[];
    for(var j=0;j<fights.length;j++){
      var f=fights[j];
      if(!f.winner||!f.f1||!f.f2)continue;
      var loser=f.winner===f.f1?f.f2:f.winner===f.f2?f.f1:null;
      if(!loser)continue;              // a name we can't align — skip, don't guess
      var ra=rating(f.winner),rb=rating(loser);
      var exp=1/(1+Math.pow(10,(rb-ra)/400));
      var k=MODEL_K*(/ko|tko|sub/i.test(f.method||"")?MODEL_FINISH_K:1);
      R[f.winner]=ra+k*(1-exp);
      R[loser]=rb-k*(1-exp);
    }
  }
  if(memo)_modelRatings=R;
  return R;
}
// Style matchup, expressed in Elo points so it adds straight onto the rating
// gap. Every term is clamped: one freak stat line must never swing a fight.
function modelStyleAdj(a,b,now){
  if(!a||!b)return {adj:0,factors:[]};
  var factors=[],adj=0;
  function add(label,pts){
    pts=Math.round(pts);
    if(!pts)return;
    adj+=pts;factors.push({label:label,pts:pts});
  }
  var ra=_mInches(a.rch),rb=_mInches(b.rch);
  if(ra!==null&&rb!==null&&ra!==rb)
    add((ra>rb?"+":"")+Math.round(ra-rb)+"\" reach",_mClamp(4*(ra-rb),-40,40));
  var aa=_mAge(a.dob,now),ab=_mAge(b.dob,now);
  if(aa!==null&&ab!==null&&Math.abs(aa-ab)>=1)
    add(Math.round(Math.abs(aa-ab))+"yr "+(aa<ab?"younger":"older"),_mClamp(-6*(aa-ab),-45,45));
  // Each differential needs the stat on BOTH sides. Reading a missing stat as 0
  // (what _mNum does) doesn't say "unknown", it says "worst in the division" —
  // so a fighter the stats cache has nothing on was handing his opponent the
  // full +40 striking and +40 grappling swing for having no data. That is how a
  // +348 market underdog came out a 61% model favourite off an empty profile.
  if(_mHasStriking(a)&&_mHasStriking(b))
    add("striking volume",_mClamp(12*(_mNum(a.slpm)*_mNum(a.acc)/100
                                     -_mNum(b.slpm)*_mNum(b.acc)/100),-40,40));
  if(_mHasGrappling(a)&&_mHasGrappling(b))
    add("grappling",_mClamp(0.6*((_mNum(a.td)*6+_mNum(a.tdd)*0.5)
                                -(_mNum(b.td)*6+_mNum(b.tdd)*0.5)),-40,40));
  var fa=_mFinishRate(a),fb=_mFinishRate(b);
  if(_mRecord(a.rec).w&&_mRecord(b.rec).w)add("finish rate",_mClamp(60*(fa-fb),-30,30));
  // Southpaws see orthodox opponents constantly; the reverse isn't true.
  var stA=String(a.stn||"").toLowerCase(),stB=String(b.stn||"").toLowerCase();
  if(stA==="southpaw"&&stB==="orthodox")add("southpaw vs orthodox",12);
  else if(stB==="southpaw"&&stA==="orthodox")add("southpaw vs orthodox",-12);
  return {adj:_mClamp(adj,-120,120),factors:factors};
}
// How much of the two profiles we actually have, 0.35–1. A fighter with no
// record, no form and no striking stats is not a fighter the model knows
// anything about, and posting a confident number on him is how a 20% market
// underdog came out an 79% model favourite. Thin data shrinks the whole rating
// gap toward a coin flip instead.
function _mConfidence(a,b){
  function known(st){
    var r=_mRecord(st.rec),fights=r.w+r.l,c=0;
    if(fights)c+=0.5*Math.min(fights,10)/10;
    if(st.form&&st.form.length)c+=0.3*Math.min(st.form.length,3)/3;
    if(_mNum(st.slpm))c+=0.2;
    return c;
  }
  return _mClamp(Math.min(known(a),known(b)),0.35,1);
}
// The widest rating gap the model is allowed to claim (~91%). It is a rough
// second opinion built from a few public numbers; it has no business posting
// a 97% certainty on anybody.
var MODEL_MAX_DIFF=400;
// Model win probability for a bout. null when either fighter is missing from the
// stats cache — a half-known matchup is not a weaker prediction, it's a guess.
function modelProb(n1,n2,stats,rankings,archive,now){
  var S=stats||(typeof FIGHTER_STATS!=="undefined"?FIGHTER_STATS:{});
  var a=S[n1],b=S[n2];
  if(!a||!b)return null;
  var R=modelRatings(stats,rankings,archive);
  var ea=(n1 in R)?R[n1]:MODEL_BASE,eb=(n2 in R)?R[n2]:MODEL_BASE;
  var style=modelStyleAdj(a,b,now);
  var conf=_mConfidence(a,b);
  var diff=_mClamp(((ea-eb)+style.adj)*conf,-MODEL_MAX_DIFF,MODEL_MAX_DIFF);
  var p1=1/(1+Math.pow(10,-diff/400));
  return {p1:p1,p2:1-p1,elo1:Math.round(ea),elo2:Math.round(eb),
          styleAdj:style.adj,confidence:Math.round(conf*100)/100,
          factors:style.factors};
}
// American moneyline → implied probability.
function modelImplied(o){
  if(typeof o!=="number"||!isFinite(o))return null;
  return o<0?(-o)/((-o)+100):100/(o+100);
}
// The market's own probabilities with the bookmaker's margin divided out, so
// model and market are compared on the same scale. Without this the market side
// always sums past 100% and the model looks systematically low on both fighters.
function modelDeVig(odds){
  if(!odds)return null;
  var p1=modelImplied(odds.f1),p2=modelImplied(odds.f2);
  if(p1===null||p2===null)return null;
  var s=p1+p2;
  if(!(s>0))return null;
  return {p1:p1/s,p2:p2/s};
}
// Model vs market for one bout, plus the divergence worth flagging.
function modelEdge(fight,stats,rankings,archive,now){
  if(!fight||!fight.f1||!fight.f2)return null;
  var m=modelProb(fight.f1.n,fight.f2.n,stats,rankings,archive,now);
  if(!m)return null;
  var mkt=modelDeVig(fight.odds);
  var out={model:m,market:mkt,edge:0,side:0};
  if(mkt){
    var d1=(m.p1-mkt.p1)*100;
    out.edge=Math.round(Math.abs(d1)*10)/10;
    out.side=d1>0?1:d1<0?2:0;
  }
  return out;
}
// Which bouts on a card carry the flag: the biggest model-vs-market gaps, at
// most MODEL_FLAG_MAX of them, and none below MODEL_EDGE_MIN. Keyed by the
// fighter pair so the row renderer can ask about one bout at a time.
function modelCardFlags(ev,stats,rankings,archive,now){
  var flags={};
  if(!ev||!ev.fights)return flags;
  var scored=[];
  for(var i=0;i<ev.fights.length;i++){
    var f=ev.fights[i],e=modelEdge(f,stats,rankings,archive,now);
    if(e&&e.market&&e.edge>=MODEL_EDGE_MIN&&e.model.confidence>=MODEL_FLAG_MIN_CONF)
      scored.push({key:modelBoutKey(f),edge:e.edge});
  }
  scored.sort(function(a,b){return b.edge-a.edge;});
  for(var j=0;j<scored.length&&j<MODEL_FLAG_MAX;j++)flags[scored[j].key]=true;
  return flags;
}
function modelBoutKey(f){return f&&f.f1&&f.f2?f.f1.n+"|"+f.f2.n:"";}
// model:end

// ── Fight Week Intel filters ─────────────────────────────────────────────
// intel.json (built by intel.py) is fetched by the app (loadIntel, in
// index.html's fight-week-intel block) and by the Lab; these two decide what
// of it may be shown under a card.
function intelKey(ev){return (ev&&ev.slug)||(ev&&ev.date)||"";}
// Every item is re-validated here rather than trusted from the file. intel.py
// matches fighters by string, and the expensive failure is mis-attribution: an
// article about a different Silva surfacing under this card, or a stale bucket
// whose slug got reused. Both are caught by checking the item against the card
// the app is actually rendering.
function intelItemsFor(intel,ev){
  if(!intel||!intel.events||!ev)return [];
  var bucket=intel.events[intelKey(ev)];
  if(!bucket||!bucket.items)return [];
  if(bucket.date&&bucket.date!==ev.date)return [];          // slug reused by a later card
  var roster=[];
  (ev.fights||[]).forEach(function(f){
    if(f&&f.f1&&f.f1.n)roster.push(f.f1.n);
    if(f&&f.f2&&f.f2.n)roster.push(f.f2.n);
  });
  return bucket.items.filter(function(it){
    if(!it||!it.title||typeof it.url!=="string")return false;
    // Only absolute https links leave this app. Anything else (javascript:,
    // data:, a relative path) is a link we would be wrong to render.
    if(it.url.indexOf("https://")!==0)return false;
    var tags=it.fighters||[];
    if(!tags.length)return false;
    // Every fighter the item claims must actually be on this card.
    return tags.every(function(n){
      return roster.some(function(r){return nmEq(r,n);});
    });
  });
}
