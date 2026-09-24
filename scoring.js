// scoring.js — the app's scoring, in one place (engine migration stage 3,
// docs/MIGRATION.md option A).
//
// Everything that decides a number on the board lives here: fighter-name
// matching (nmKey/nmEq/nmBout), nickname identity (splitNick), the segment
// labels scoring reads (isMainCardBout/isEarlyPrelimBout), per-pick points
// (pickPts: winner, method, underdog bonus, locks), the bout lookup
// (_boutLookup), finished-card detection (_eventFinished) and the board scorer
// itself (_lbScoreUsers, userPts). It used to be inline in index.html and every
// other consumer — the Fight Lab, FightBot, the Friday brief, the tests —
// sliced it back out by comment markers. Now they all run THIS file.
//
// A plain classic script: top-level functions become globals, and they read the
// app's globals (EVENTS, RESULTS_ARCHIVE, lbScope, USER_ID, MAIN_CARD_BOUTS,
// DAY_MS, userName, _lbRows, _commRows) only when called, never at load. Node
// consumers run it in a context that supplies those names.
//
// It is REQUIRED, like data.js: index.html loads it right after data.js, sw.js
// serves it network-first and precaches it, and a load that fails falls into
// the same one-shot purge-and-reload self-heal a missing data.js does.
// check:parity pins every score it produces to the pre-migration golden.

// The rulebook's version. index.html requests scoring.js?v=<this> and refuses
// (self-heals) a file whose version doesn't match, and sw.js caches it under
// that versioned URL — so a page can never run on a previous release's rules,
// even offline with an old copy cached. Bump it on ANY change to this file, in
// all three places (index.html's script src + SCORING_EXPECT, sw.js's precache);
// check:lab fails if they disagree.
var SCORING_VERSION="2026-09-24-5";

// fighter-names:start
var _NM_SUFFIX_RE=/\b(?:jr|sr|ii|iii|iv)\b/g;
function nmKey(n){
  var s=String(n==null?"":n);
  if(s.normalize)s=s.normalize("NFD").replace(/[̀-ͯ]/g,"");
  return s.toLowerCase()
    .replace(/[.,'’`‘\-]/g," ")
    .replace(_NM_SUFFIX_RE," ")
    .replace(/\s+/g," ").trim();
}
// True when two fighter names refer to the same person. Blank never matches
// blank — an undecided bout has winner:"" and must not read as "you were right".
function nmEq(a,b){
  if(a&&a===b)return true;
  var x=nmKey(a);
  return !!x&&x===nmKey(b);
}
// True when `f` (an EVENTS bout) is the bout between `a` and `b`, in either corner.
function nmBout(f,a,b){
  return (nmEq(f.f1.n,a)&&nmEq(f.f2.n,b))||(nmEq(f.f1.n,b)&&nmEq(f.f2.n,a));
}
// fighter-names:end
// Nicknames are stored as "<emoji> <name>" — but not reliably. Legacy rows carry
// no emoji at all, and nothing stops an emoji with no space after it. Nine places
// independently split on the FIRST SPACE, which meant:
//   "Adam B"    → avatar "Adam", name "B"        (first word eaten as the emoji)
//   "🦂JPeso"   → avatar 🥊, name "🦂JPeso"       (emoji rendered inside the name)
// The second is worse than cosmetic: _lbBaseName is the identity key behind
// leaderboard dedup, the belt lineage and challenge matching, so the emoji leaked
// into it and the same person could key as two different users.
//
// Detect a leading emoji grapheme instead — pictographic code point plus any
// variation selectors, skin-tone modifiers, ZWJ-joined parts and tag sequences.
// No leading emoji means the whole string is the name.
//
// The regex is built at RUNTIME inside try/catch on purpose: \p{...} property
// escapes are a parse-time SyntaxError on browsers that don't support them, and
// a parse error in this inline script white-pages the entire app. The surrogate
// -pair fallback covers the same ground well enough for older engines.
var _EMOJI_HEAD=(function(){
  var mods="(?:[\\u{1F3FB}-\\u{1F3FF}]|\\uFE0F|\\u{E0020}-\\u{E007F}|\\u200D\\p{Extended_Pictographic})*";
  try{return new RegExp("^(\\p{Extended_Pictographic}"+mods+")\\s*","u");}
  catch(e){
    var pic="(?:[\\u203C-\\u3299]|[\\uD83C-\\uDBFF][\\uDC00-\\uDFFF])";
    try{return new RegExp("^("+pic+"(?:[\\uD83C][\\uDFFB-\\uDFFF]|\\uFE0F|\\u200D"+pic+")*)\\s*");}
    catch(e2){return null;}
  }
})();
// → {emoji, name}. An emoji-only nickname keeps the emoji AS the name rather than
// resolving to an empty string, which is what the old first-space split did and
// what every caller (including the identity key) still expects.
function splitNick(nick){
  var s=String(nick==null?"":nick).trim();
  if(_EMOJI_HEAD){
    var m=_EMOJI_HEAD.exec(s);
    if(m){
      var rest=s.slice(m[0].length).trim();
      if(rest)return{emoji:m[1],name:rest};
    }
  }
  return{emoji:"",name:s};
}

function isMainCardBout(f){
  var l=f&&f.lbl;
  return l==="Main Event"||l==="Co-Main"||l==="Main Card";
}
function isEarlyPrelimBout(f){return !!f&&f.lbl==="Early Prelim";}

// pick-match:start
var DOG_TIERS=[{min:250,pts:1},{min:150,pts:0.5}];
// Underdog points for one moneyline. Favourites (negative odds) and short dogs
// under the first tier earn nothing extra.
function dogPtsFor(odds){
  if(typeof odds!=="number"||!isFinite(odds)||odds<=0)return 0;
  for(var i=0;i<DOG_TIERS.length;i++){if(odds>=DOG_TIERS[i].min)return DOG_TIERS[i].pts;}
  return 0;
}
// Underdog points a correct pick of `pickName` earns on this bout. `odds` is the
// {f1,f2} line and `f1n`/`f2n` the two fighters, in that order. A bout with no
// stored line (odds:null — the API had nothing for it) simply scores no bonus.
function dogPtsForPick(odds,f1n,f2n,pickName){
  if(!odds||!pickName)return 0;
  if(nmEq(pickName,f1n))return dogPtsFor(odds.f1);
  if(nmEq(pickName,f2n))return dogPtsFor(odds.f2);
  return 0;
}
// Total points for a leaderboard user row — the one formula every board, badge
// and projection reads, so they can't drift apart.
function userPts(u){return u.correct+u.methods*0.5+u.fotn+(u.dogPts||0)+(u.lockPts||0);}

// Locks 🔒 — "this one's a lock." Up to LOCKS_PER_CARD per card: a lock that
// hits earns LOCK_HIT on top of the pick's normal points, a lock that misses
// costs LOCK_MISS. Stored in the picks row's `confidence` column (>0 = locked).
// That column used to hold 1–3 "confidence stars" that never scored, and old
// cards carry plenty of them (one player starred seven bouts on a card), so a
// lock only counts on cards dated LOCKS_START or later — otherwise switching
// the feature on would rewrite every past standing and the belt's history.
var LOCKS_PER_CARD=2,LOCK_HIT=1,LOCK_MISS=-1,LOCKS_START="2026-09-26";
function locksOn(date){return !!date&&date>=LOCKS_START;}
function isLockPick(p){return !!p&&Number(p.confidence)>0&&locksOn(p.event_date);}
// Lock swing for one resolved pick. No result (cancelled bout, NC) → 0.
function lockPtsFor(locked,winner,pickName){
  if(!locked||!winner)return 0;
  return nmEq(winner,pickName)?LOCK_HIT:LOCK_MISS;
}
// Points for one picks row against one result — every per-pick scorer (belt,
// challenges, card score) reads this so a lock can't count in one and not another.
function pickPts(p,res){
  if(!res||!res.winner)return 0;
  var base=nmEq(res.winner,p.pick)?1+(scoreMethod(p.method||"",res.method||"")?0.5:0)+dogPtsForPick(res.odds,res.f1n,res.f2n,p.pick):0;
  return base+lockPtsFor(isLockPick(p),res.winner,p.pick);
}

function scoreMethod(userMethod, fightMethod){
  if(!userMethod||!fightMethod)return false;
  var fm=fightMethod.toUpperCase();
  return (userMethod==="KO/TKO"&&(fm.indexOf("KO")>=0||fm.indexOf("TKO")>=0))||
         (userMethod==="Sub"&&fm.indexOf("SUB")>=0)||
         (userMethod==="Dec"&&(fm.indexOf("DEC")>=0||fm==="UD"||fm==="SD"||fm==="MD"));
}

// Strip the leading emoji by taking everything after the first space — a regex
// like /^.\s/ fails on emoji that are surrogate pairs (🐺,😀,…), which would
// leave the emoji in the key and break matching when a user changes their emoji.
function _lbBaseName(nick){return splitNick(nick).name.toLowerCase();}
// Challenge rows freeze challenger/target nicknames at creation time (and RLS
// only lets the target touch status/responded_at), but a profile edit renames
// every picks row. Resolve the freshest display name for the same base
// identity so old challenges don't keep showing a stale avatar. My own name
// short-circuits to userName so an edit shows instantly, before any refetch.
function _freshNick(name){
  var base=_lbBaseName(name);
  if(!base)return name;
  if(userName&&_lbBaseName(userName)===base)return userName;
  if(_lbRows)for(var i=0;i<_lbRows.length;i++)            // updated_at DESC — first hit is freshest
    if(_lbBaseName(_lbRows[i].nickname)===base)return _lbRows[i].nickname;
  if(_commRows)for(var j=_commRows.length-1;j>=0;j--)     // updated_at ASC — last hit is freshest
    if(_lbBaseName(_commRows[j].nickname)===base)return _commRows[j].nickname;
  return name;
}

// Bout lookup — every "which fight is this pick on?" question goes through here
// (engine migration stage 2, docs/MIGRATION.md). The Pick Engine (lab/engine.js,
// loaded before this script) answers it from its normalized index; if that file
// didn't load — a 404, a first launch offline — the original loops below answer
// instead, so the app never depends on it. Both must give identical answers:
// check:parity runs the whole board, Belt, recaps and Wrapped through each path
// against the same golden.
//
// Order of preference is the app's long-standing one: the live EVENTS window
// first (every card on that date, in EVENTS order), then that date's
// RESULTS_ARCHIVE entry — even for a date still in the window, which catches a
// bout the live card no longer carries.
//
// Returns {live:true, fight:<EVENTS bout>} or {live:false, fight:<archive bout>,
// k:<its index>}, or null.
var _appEng=null,_appEngEv=null,_appEngArc=null;
function _appEngine(){
  if(typeof PickEngine==="undefined"||!PickEngine||!PickEngine.createEngine)return null;
  if(_appEng&&_appEngEv===EVENTS&&_appEngArc===RESULTS_ARCHIVE)return _appEng;
  try{
    _appEng=PickEngine.createEngine({
      adapters:[PickEngine.ufcAdapter({EVENTS:EVENTS,RESULTS_ARCHIVE:RESULTS_ARCHIVE})],
      // Lookups only in this stage: the engine matches names with the app's own
      // nmEq; scoring still happens below, in pickPts.
      rules:{ufc:{id:"ufc",same:nmEq,isLock:isLockPick,score:function(){return 0;}}}
    });
    _appEngEv=EVENTS;_appEngArc=RESULTS_ARCHIVE;
  }catch(e){_appEng=null;}
  return _appEng;
}
function _boutLookup(date,f1,f2){
  var eng=_appEngine();
  if(eng){
    var h=eng.findBout(date,f1,f2,"ufc");
    if(!h)return null;
    return h.event.source==="live"?{live:true,fight:h.bout.raw}:{live:false,fight:h.bout.raw,k:h.bout.order};
  }
  for(var i=0;i<EVENTS.length;i++){
    if(EVENTS[i].date!==date)continue;
    for(var j=0;j<EVENTS[i].fights.length;j++){
      var f=EVENTS[i].fights[j];
      if(nmBout(f,f1,f2))return {live:true,fight:f};
    }
  }
  var a=RESULTS_ARCHIVE[date];
  if(a&&a.fights)for(var k=0;k<a.fights.length;k++){
    var af=a.fights[k];
    if((nmEq(af.f1,f1)&&nmEq(af.f2,f2))||(nmEq(af.f1,f2)&&nmEq(af.f2,f1)))return {live:false,fight:af,k:k};
  }
  return null;
}

// Was this pick on the main card? The live card's label is authoritative; an
// archived bout uses its own label.
//
// Archive entries written before labels existed carry no lbl, so they fall back
// to bout order. That is not a guess: the archive is generated by scanning the
// EVENTS block in order, and scrape.py assigns the labels purely by index, so
// index < MAIN_CARD_BOUTS reproduces the same split exactly. Verified against
// the Aug 8 card, where the inferred split matched all 12 real labels.
function _isMainCardPick(date,f1,f2){
  var h=_boutLookup(date,f1,f2);
  if(!h)return false;
  if(h.live)return isMainCardBout(h.fight);
  return h.fight.lbl?isMainCardBout(h.fight):h.k<MAIN_CARD_BOUTS;
}
// Scope gate for the standings. "all" short-circuits so the default path does no
// extra lookups and cannot be affected by a bout we fail to locate.
function _pickInScope(p){
  if(lbScope!=="main")return true;
  return _isMainCardPick(p.event_date,p.f1,p.f2);
}
// Resolve a finished fight by event date + fighter pair.
function _findFightResult(date,f1,f2){
  var h=_boutLookup(date,f1,f2);
  if(!h)return null;
  var f=h.fight;
  // odds/f1n/f2n ride along so callers can price the underdog bonus without
  // re-finding the bout. Archived bouts have no line on record, so those simply
  // score no bonus.
  if(h.live)return f.winner?{winner:f.winner,method:f.method||"",odds:f.odds||null,f1n:f.f1.n,f2n:f.f2.n}:null;
  return f.winner?{winner:f.winner,method:f.method||""}:null;
}

// An event is "finished" when every fight is final, or the card is >2 days old
// with results in (a cancelled bout would otherwise hold it "pre" forever).
// Cards that have aged out of EVENTS count as finished via the results archive.
// pick-match:end
function _eventFinished(date){
  for(var i=0;i<EVENTS.length;i++){
    if(EVENTS[i].date!==date)continue;
    var fs=EVENTS[i].fights;
    var allPost=fs.length>0&&fs.every(function(f){return f.state==="post";});
    var anyResult=fs.some(function(f){return f.state==="post"&&f.winner;});
    var old=new Date(date).getTime()<Date.now()-2*DAY_MS;
    return (allPost&&anyResult)||(old&&anyResult);
  }
  return !!RESULTS_ARCHIVE[date];
}

// The leaderboard's scoring, lifted out of loadLeaderboard verbatim so the card
// recap reads rank from the SAME code the board renders — a second copy of
// this logic is how the recap came to say #2 while the board said #3 (it
// scored archived cards the board doesn't). `keep(p)` is the row filter: the
// board passes its mode/scope, the recap passes a date cutoff. Returns the
// deduped users sorted exactly as the board sorts them.
// A picks row belongs to the UFC board unless it says otherwise: rows written
// before 0007_picks_promotion.sql, and fixtures, carry no promotion at all.
function _isUfcRow(p){return !p.promotion||p.promotion==="ufc";}
function _lbScoreUsers(rows,keep){
  // Keyed by user_id, nickname and base name, which are player-chosen strings:
  // prototype-free, or a player called "Constructor" or "toString" collides
  // with Object.prototype and crashes (or silently corrupts) the board.
  var users=Object.create(null);
  rows.forEach(function(p){
    // UFC standings only: another promotion's pick (sport switcher) never
    // counts here, even if a reader forgot promotion=eq.ufc.
    if(!_isUfcRow(p))return;
    if(keep&&!keep(p))return;
    var uid=p.user_id||p.nickname||"unknown";
    if(!users[uid])users[uid]={nickname:p.nickname||"",user_id:p.user_id||null,correct:0,total:0,methods:0,fotn:0,dogPts:0,lockPts:0,bonusPicks:{},isMe:uid===USER_ID,picks:[]};
    // Rows are newest-first, but the freshest row can carry a blank nickname (a
    // pick synced before the name was set), which would render an empty row.
    // Backfill from any row of the same user that does have a name.
    else if(!String(users[uid].nickname||"").trim()&&p.nickname&&String(p.nickname).trim())users[uid].nickname=p.nickname;
    // Which bout this pick is on: the live card, else the results archive
    // (All-Time means every card captured, not just the ones still in EVENTS —
    // scoring EVENTS alone once left ten cards of picks counted in `total` but
    // never scored). Same lookup _findFightResult uses, so the board and the
    // Belt can't disagree about a bout. Archived cards carry no line, so they
    // earn no underdog bonus — exactly as the belt scores them.
    var fight=null,_h=_boutLookup(p.event_date,p.f1,p.f2);
    if(_h&&_h.live)fight=_h.fight;
    else if(_h){
      var af=_h.fight;
      fight={f1:{n:af.f1},f2:{n:af.f2},winner:af.winner||"",method:af.method||"",odds:af.odds||null};
    }
    var result=null;
    var methodCorrect=false;
    var pickedMethod=p.method||"";
    // The underdog bonus this pick is worth if it lands, computed from the line
    // on the card (which is frozen at the closing line once the event is over,
    // so every device replays the same score).
    var dogPts=fight?dogPtsForPick(fight.odds,fight.f1.n,fight.f2.n,p.pick):0;
    var locked=isLockPick(p),lockPts=0;
    users[uid].total++;
    if(fight&&fight.winner){
      if(nmEq(fight.winner,p.pick)){
        users[uid].correct++;result=true;users[uid].dogPts+=dogPts;
        console.log("[lb score]",p.f1,"vs",p.f2,"→ winner match. p.method="+JSON.stringify(p.method)+" fallback="+JSON.stringify(pickedMethod)+" fight.method="+JSON.stringify(fight.method));
        if(scoreMethod(pickedMethod,fight.method||"")){users[uid].methods++;methodCorrect=true;}
      }else{result=false;}
      lockPts=lockPtsFor(locked,fight.winner,p.pick);users[uid].lockPts+=lockPts;
    }
    users[uid].picks.push({f1:p.f1,f2:p.f2,pick:p.pick,method:pickedMethod,result:result,methodCorrect:methodCorrect,dogPts:dogPts,locked:locked,lockPts:lockPts,evName:p.event_name,evDate:p.event_date});
    if(p.bonus_pick)users[uid].bonusPicks[p.event_date]=p.bonus_pick;
  });
  // De-duplicate by name (keep higher pick count)
  var seenNames=Object.create(null);
  Object.keys(users).forEach(function(uid){
    var base=_lbBaseName(users[uid].nickname);
    if(!seenNames[base]){seenNames[base]=uid;}
    else{
      var prev=seenNames[base];
      if(users[uid].total>users[prev].total){
        if(users[uid].isMe||!users[prev].isMe){delete users[prev];seenNames[base]=uid;}
        else{delete users[uid];}
      }else{
        if(users[prev].isMe||!users[uid].isMe){delete users[uid];}
        else{delete users[prev];seenNames[base]=uid;}
      }
    }
  });
  // Compute streak + accuracy per user
  Object.values(users).forEach(function(u){
    var resolved=u.picks.filter(function(p){return p.result!==null;}).sort(function(a,b){return a.evDate<b.evDate?-1:1;});
    var best=0,cur=0;
    resolved.forEach(function(p){if(p.result===true){cur++;if(cur>best)best=cur;}else{cur=0;}});
    u.bestStreak=best;
    var desc=resolved.slice().reverse(),streak=0;
    for(var j=0;j<desc.length;j++){if(desc[j].result===true)streak++;else break;}
    u.currentStreak=streak;
    u.accuracy=resolved.length>0?Math.round(u.correct/resolved.length*100):null;
  });
  // Score bonus picks (FOTN/POTN)
  Object.values(users).forEach(function(u){
    u.fotn=0;
    Object.keys(u.bonusPicks).forEach(function(evDate){
      var ev=null;
      for(var i=0;i<EVENTS.length;i++){if(EVENTS[i].date===evDate){ev=EVENTS[i];break;}}
      if(ev&&ev.fotn&&u.bonusPicks[evDate]===ev.fotn)u.fotn++;
    });
  });
  return Object.values(users).sort(function(a,b){
    var pa=userPts(a),pb=userPts(b);
    if(pa!==pb)return pb-pa;                                  // 1) most points
    var aa=a.accuracy==null?-1:a.accuracy,ab=b.accuracy==null?-1:b.accuracy;
    if(aa!==ab)return ab-aa;                                  // 2) tiebreak: higher pick %
    return b.total-a.total;                                   // 3) then more picks made
  });
}

// sport-standings:start
// The board for a non-UFC promotion (sport switcher). Its cards come from the
// curated feed (events-extra.json, validated by PickEngine.validateFeed), not
// data.js, and its picks are the rows with that promotion — never mixed with
// UFC (0007_picks_promotion.sql). Rules are deliberately plain until a
// promotion earns more: 1 point per correct winner, no underdog bonus (the
// feed carries no reliable line), no locks, no method. Identity and name
// matching are the board's own (user_id else nickname; nmEq), and every map
// is prototype-free for the same reason as _lbScoreUsers'.
function sportBout(events,promo,date,f1,f2){
  for(var i=0;i<(events||[]).length;i++){
    var ev=events[i];
    if(ev.promotion!==promo||ev.date!==date)continue;
    for(var j=0;j<ev.bouts.length;j++){
      var b=ev.bouts[j];
      if((nmEq(b.a,f1)&&nmEq(b.b,f2))||(nmEq(b.a,f2)&&nmEq(b.b,f1)))return {ev:ev,bout:b};
    }
  }
  return null;
}
function sportStandings(rows,events,promo){
  var users=Object.create(null);
  (rows||[]).forEach(function(p){
    if(p.promotion!==promo)return;
    var hit=sportBout(events,promo,p.event_date,p.f1,p.f2);
    if(!hit)return;                                     // a card that left the feed doesn't score
    var uid=p.user_id||p.nickname||"unknown";
    var u=users[uid]||(users[uid]={user_id:p.user_id||null,nickname:p.nickname||"",correct:0,resolved:0,total:0,pts:0});
    if(!String(u.nickname||"").trim()&&p.nickname)u.nickname=p.nickname;
    u.total++;
    var w=hit.bout.winner;
    if(w){u.resolved++;if(nmEq(w,p.pick)){u.correct++;u.pts++;}}
  });
  return Object.keys(users).map(function(k){
    var u=users[k];u.accuracy=u.resolved?Math.round(u.correct/u.resolved*100):null;return u;
  }).sort(function(a,b){
    if(a.pts!==b.pts)return b.pts-a.pts;
    var aa=a.accuracy==null?-1:a.accuracy,ab=b.accuracy==null?-1:b.accuracy;
    if(aa!==ab)return ab-aa;
    return b.total-a.total;
  });
}
// sport-standings:end

// standings:start
// Standings by scope (engine migration stage 4). Every standings consumer —
// the board, the card recap, Year Wrapped, the trash-talk pool, the Fight Lab,
// FightBot — asks for "the board, scoped to X" through here instead of hand-
// rolling a keep() predicate for _lbScoreUsers, so a new scope (a room's
// members) is added once and every view gets it.
//
// A scope is a plain object; every field is optional and they AND together:
//   date: "YYYY-MM-DD"    that card only
//   through: "YYYY-MM-DD" cards on or before it
//   before: "YYYY-MM-DD"  cards strictly before it
//   year: "YYYY"          that calendar year
//   mainCard: true        main-card bouts only (the board's Main Card toggle)
//   users: [ids]          only these players, by the board's identity key
//                         (user_id, else nickname) — a room's members.
//                         Prototype-free, so a legacy nickname like
//                         "constructor" can't pass as a member.
// No scope (or {}) is the all-time board. Date fields are checked before
// mainCard, so the bout lookup only runs for picks the dates already admit.
function standingsKeep(scope){
  scope=scope||{};
  var users=null;
  if(scope.users){users=Object.create(null);scope.users.forEach(function(u){users[u]=true;});}
  return function(p){
    if(scope.date!=null&&p.event_date!==scope.date)return false;
    if(scope.through!=null&&!(p.event_date<=scope.through))return false;
    if(scope.before!=null&&!(p.event_date<scope.before))return false;
    if(scope.year!=null&&String(p.event_date||"").slice(0,4)!==String(scope.year))return false;
    if(users&&!users[p.user_id||p.nickname||"unknown"])return false;
    if(scope.mainCard&&!_isMainCardPick(p.event_date,p.f1,p.f2))return false;
    return true;
  };
}
function boardStandings(rows,scope){
  return _lbScoreUsers(rows,scope?standingsKeep(scope):null);
}
// standings:end

// The Belt 🏆 — a lineal king-of-the-hill title replayed deterministically from
// everyone's pick history, so every phone computes the same champion. Rules:
// the belt is decided per finished event; the champion must defend on every
// card (skipping scores 0) and RETAINS on ties; a challenger takes the belt
// only by strictly outscoring the champion. When the belt is vacant or the
// champ is beaten by challengers tied on points, cumulative accuracy (then
// total picks) breaks the tie — a dead heat leaves the belt vacant.
function computeBeltLineage(rows,scope){
  // A scoped belt (a room's own title) replays the same rules over that
  // scope's picks only; no scope is the app's belt, unchanged.
  if(scope)rows=rows.filter(standingsKeep(scope));
  var evScores=Object.create(null);   // date -> base name -> {name,pts,correct,total}; prototype-free (see _lbScoreUsers)
  rows.forEach(function(p){
    if(!_isUfcRow(p))return;   // UFC belt only (see _lbScoreUsers)
    var base=_lbBaseName(p.nickname);
    if(!base)return;
    var res=_findFightResult(p.event_date,p.f1,p.f2);
    if(!res)return;
    var d=evScores[p.event_date]||(evScores[p.event_date]=Object.create(null));
    var u=d[base]||(d[base]={name:p.nickname,pts:0,correct:0,total:0});
    u.total++;
    if(nmEq(res.winner,p.pick))u.correct++;
    u.pts+=pickPts(p,res);
  });
  // Finished events, oldest first
  var evNames={},dates=[];
  EVENTS.forEach(function(ev){
    if(_eventFinished(ev.date)){dates.push(ev.date);evNames[ev.date]=ev.name;}
  });
  // The archive is re-snapshotted on every scrape while an event is still in
  // EVENTS, so a card that is HALFWAY THROUGH already has an archive entry
  // holding only the bouts decided so far. The EVENTS loop above screens those
  // out with _eventFinished; this loop had no such check and added them anyway,
  // which crowned a champion off a partial card — the belt changed hands on
  // Gamrot vs. Salkilld while the main event and co-main were still to come.
  // Only fall back to the archive for dates EVENTS no longer carries at all.
  var liveDates={};
  EVENTS.forEach(function(ev){if(!_eventFinished(ev.date))liveDates[ev.date]=true;});
  Object.keys(RESULTS_ARCHIVE).forEach(function(d){
    if(!evNames[d]&&!liveDates[d]){dates.push(d);evNames[d]=RESULTS_ARCHIVE[d].name;}
  });
  dates.sort();
  var holder=null,reigns=[],cum=Object.create(null);   // cum accuracy per base for tiebreaks
  dates.forEach(function(date){
    var scores=evScores[date]||Object.create(null);
    var entries=Object.keys(scores).map(function(b){var s=scores[b];return{base:b,name:s.name,pts:s.pts,correct:s.correct,total:s.total};});
    entries.forEach(function(e){var c=cum[e.base]||(cum[e.base]={correct:0,total:0});c.correct+=e.correct;c.total+=e.total;});
    entries.sort(function(a,b){return b.pts-a.pts;});
    if(!entries.length||entries[0].pts<=0)return;          // nobody scored — no contest
    var top=entries[0],tiedTop=entries.filter(function(e){return e.pts===top.pts;});
    var champPts=holder&&scores[holder.base]?scores[holder.base].pts:0;
    if(holder&&champPts>=top.pts){                          // ties go to the champion
      reigns[reigns.length-1].defenses++;
      reigns[reigns.length-1].defDates.push(date);   // Year Wrapped counts defences by when they happened
      return;
    }
    // How the belt was won, recorded so the title history can SAY so. A reign
    // that started on a tiebreak is indistinguishable from an outright win
    // otherwise, which makes a legitimate result look arbitrary to whoever
    // didn't get it.
    var wonVia=null;
    if(tiedTop.length>1){
      tiedTop.sort(function(a,b){
        var ca=cum[a.base],cb=cum[b.base];
        var aa=ca.total?ca.correct/ca.total:0,ab=cb.total?cb.correct/cb.total:0;
        if(aa!==ab)return ab-aa;
        return cb.total-ca.total;
      });
      var c0=cum[tiedTop[0].base],c1=cum[tiedTop[1].base];
      var a0=c0.total?c0.correct/c0.total:0,a1=c1.total?c1.correct/c1.total:0;
      if(a0===a1&&c0.total===c1.total){
        if(holder){reigns[reigns.length-1].end={evName:evNames[date],vacated:true};holder=null;}
        return;                                             // dead heat — belt goes vacant
      }
      wonVia=(a0!==a1)
        ? {tied:tiedTop.length,by:"accuracy",val:Math.round(a0*100)+"%"}
        : {tied:tiedTop.length,by:"picks",val:c0.total+" picks"};
    }
    var wn=tiedTop[0];
    if(holder)reigns[reigns.length-1].end={evName:evNames[date],takenBy:wn.name};
    holder={base:wn.base,name:wn.name};
    reigns.push({base:wn.base,name:wn.name,evName:evNames[date],date:date,defenses:0,end:null,
                 pts:wn.pts,via:wonVia,defDates:[]});
  });
  if(!reigns.length)return null;
  var cur=reigns[reigns.length-1];
  return {holderBase:holder?holder.base:null,holderName:holder?holder.name:null,
          defenses:holder?cur.defenses:0,reigns:reigns};
}
