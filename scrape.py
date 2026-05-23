#!/usr/bin/env python3
# UFC scraper
# Card structure: Wikipedia (full cards, all fights)
# Odds enrichment: The Odds API (live moneylines)
# Results: Wikipedia MMAevent bout parser (fight night)
import json, os, re, sys, time, unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests
from bs4 import BeautifulSoup

ODDS_API_KEY      = os.environ.get("ODDS_API_KEY", "")
ODDS_API_URL      = "https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds"
WIKI_API          = "https://en.wikipedia.org/w/api.php"
WIKI_HDR          = {"User-Agent": "UFC-Dashboard/1.0 (https://github.com/AndyRBrett/ufc-dashboard; andyrbrett@gmail.com)"}
SUPABASE_URL      = os.environ.get("SUPABASE_URL", "https://gkccophrdqtqcowmblre.supabase.co")
SUPABASE_ANON     = os.environ.get("SUPABASE_ANON", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrY2NvcGhyZHF0cWNvd21ibHJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NzAyMTAsImV4cCI6MjA5NTA0NjIxMH0.zSi-PcQL_ti5KXRq3YRQX4RbsP6HhQ5bAqh5x5kKkbE")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_CLAIMS      = {"sub": "mailto:andyrbrett@gmail.com"}

import urllib.request as _ur

def _sb_get(path):
    try:
        req = _ur.Request(SUPABASE_URL + path, headers={"apikey": SUPABASE_ANON, "Authorization": "Bearer " + SUPABASE_ANON})
        with _ur.urlopen(req, timeout=10) as r: return json.load(r)
    except Exception as e:
        print("Supabase GET error:", e, file=sys.stderr); return []

def send_push_notifications(new_results):
    """Send win/loss notifications after fight results are injected."""
    if not VAPID_PRIVATE_KEY or not new_results:
        return
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        print("pywebpush not installed, skipping push", file=sys.stderr); return

    subs  = _sb_get("/rest/v1/push_subs?select=*")
    picks = _sb_get("/rest/v1/picks?select=*")
    if not subs or not picks:
        return

    sub_map = {s["user_id"]: s for s in subs}

    for res in new_results:
        winner, loser = res["winner"], res["loser"]
        for pick in picks:
            f1, f2, chosen = pick["f1"], pick["f2"], pick["pick"]
            # Match this pick to the result
            is_this_fight = (names_match(f1, winner) and names_match(f2, loser)) or \
                            (names_match(f2, winner) and names_match(f1, loser))
            if not is_this_fight:
                continue
            sub = sub_map.get(pick["user_id"])
            if not sub:
                continue
            picked_winner = names_match(chosen, winner)
            title = "Your pick WON! 🔥" if picked_winner else "Tough luck ❌"
            body  = f"{winner} def. {loser}" + (" — you called it!" if picked_winner else "")
            try:
                webpush(
                    subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                    data=json.dumps({"title": title, "body": body}),
                    vapid_private_key=VAPID_PRIVATE_KEY,
                    vapid_claims=VAPID_CLAIMS
                )
                print(f"  Push sent to {pick['nickname']}: {title}", file=sys.stderr)
            except Exception as e:
                print(f"  Push failed for {pick['nickname']}: {e}", file=sys.stderr)

# Upcoming UFC events - Wikipedia page slugs
# Provides accurate venue/time data; auto-discovery fills in any missing events.
UPCOMING_EVENTS = [
    ("2026-05-16", "UFC_Fight_Night:_Allen_vs._Costa",         "UFC Fight Night: Allen vs. Costa",         "Meta APEX",                   "Las Vegas, NV",        "20:00", "17:00"),
    ("2026-05-30", "UFC_Fight_Night:_Song_vs._Figueiredo",     "UFC Fight Night: Song vs. Figueiredo",     "Galaxy Arena",                "Macau SAR, China",     "06:00", "03:00"),
    ("2026-06-06", "UFC_Fight_Night:_Muhammad_vs._Bonfim",     "UFC Fight Night: Muhammad vs. Bonfim",     "Meta APEX",                   "Las Vegas, NV",        "20:00", "17:00"),
    ("2026-06-14", "UFC_Freedom_250",                          "UFC Freedom 250: Topuria vs. Gaethje",     "South Lawn, White House",     "Washington, D.C.",     "20:00", "17:00"),
    ("2026-06-20", "UFC_Fight_Night:_Kape_vs._Horiguchi",      "UFC Fight Night: Kape vs. Horiguchi",      "Meta APEX",                   "Las Vegas, NV",        "20:00", "17:00"),
    ("2026-06-27", "UFC_Fight_Night:_Fiziev_vs._Torres",       "UFC Fight Night: Fiziev vs. Torres",       "National Gymnastics Arena",   "Baku, Azerbaijan",     "12:00", "09:00"),
    ("2026-07-12", "UFC_329",                                  "UFC 329",                                  "T-Mobile Arena",              "Las Vegas, NV",        "22:00", "18:00"),
]

MONTH_MAP = {m.lower(): i+1 for i, m in enumerate(
    ["January","February","March","April","May","June",
     "July","August","September","October","November","December"]
)}

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------
def asc(t):
    """Transliterate accented characters to ASCII equivalents (e.g. É->E, í->i)."""
    if not t: return ""
    normalized = unicodedata.normalize("NFKD", str(t))
    return "".join(c for c in normalized if ord(c) < 128).strip()

def clean(name):
    """Transliterate, strip accented chars, and remove parenthetical suffixes like (ic), (c)."""
    s = re.sub(r"\s*\([^)]+\)\s*$", "", str(name or "")).strip()
    normalized = unicodedata.normalize("NFKD", s)
    return "".join(c for c in normalized if ord(c) < 128).strip()

def last_name(n):
    p = clean(n).strip().split()
    return p[-1].lower() if p else ""

def names_match(a, b):
    a2 = re.sub(r"[^a-z]", "", a.lower())
    b2 = re.sub(r"[^a-z]", "", b.lower())
    return last_name(a) == last_name(b) or (len(a2) > 3 and a2 in b2) or (len(b2) > 3 and b2 in a2)

def norm_method(m):
    ml = (m or "").lower()
    if "ko" in ml or "tko" in ml: return "KO/TKO"
    if "submission" in ml or "sub" in ml: return "Submission"
    if "unanimous" in ml: return "Decision (Unanimous)"
    if "split" in ml or "deportation" in ml: return "Decision (Split)"
    if "majority" in ml: return "Decision (Majority)"
    if "decision" in ml: return "Decision"
    if "dq" in ml: return "DQ"
    return asc(m).strip()

def fmt_update(dt):
    h = dt.hour % 12 or 12
    ap = "AM" if dt.hour < 12 else "PM"
    return "%d %s %d %d:%02d %s UTC" % (dt.day, dt.strftime("%b"), dt.year, h, dt.minute, ap)

def norm_wc(raw):
    r = (raw or "").lower().strip()
    if "heavyweight" in r and "light" not in r: return "Heavyweight"
    if "light heavyweight" in r: return "Light Heavyweight"
    if "middleweight" in r: return "Middleweight"
    if "welterweight" in r: return "Welterweight"
    if "lightweight" in r: return "Lightweight"
    if "featherweight" in r and "women" not in r: return "Featherweight"
    if "bantamweight" in r and "women" not in r: return "Bantamweight"
    if "flyweight" in r and "women" not in r: return "Flyweight"
    if "women" in r and "featherweight" in r: return "Women's Featherweight"
    if "women" in r and "bantamweight" in r: return "Women's Bantamweight"
    if "women" in r and "flyweight" in r: return "Women's Flyweight"
    if "strawweight" in r: return "Women's Strawweight"
    if "atomweight" in r: return "Women's Atomweight"
    return r.title() if r else "TBD"

# ---------------------------------------------------------------------------
# Auto-discover upcoming events from Wikipedia "20XX_in_UFC"
# ---------------------------------------------------------------------------
def parse_date_wiki(s):
    """Parse a date from wikitext context. Returns 'YYYY-MM-DD' or ''."""
    m = re.search(r"\{\{dts\|(\d{4})\|(\d{1,2})\|(\d{1,2})", s)
    if m:
        return "%04d-%02d-%02d" % (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.search(
        r"(January|February|March|April|May|June|July|August"
        r"|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})",
        s, re.IGNORECASE,
    )
    if m:
        return "%04d-%02d-%02d" % (int(m.group(3)), MONTH_MAP[m.group(1).lower()], int(m.group(2)))
    return ""

def discover_upcoming_events(now):
    """Scrape 'YYYY_in_UFC' Wikipedia page and return list of (date, slug, name)."""
    wt = fetch_wikitext("%d_in_UFC" % now.year)
    if not wt:
        print("Auto-discovery: could not fetch %d_in_UFC" % now.year, file=sys.stderr)
        return []
    events = []
    seen = set()
    for lm in re.finditer(r"\[\[(UFC[^\]\|#]+?)(?:\|([^\]]+))?\]\]", wt):
        slug_raw = lm.group(1).strip()
        display  = (lm.group(2) or slug_raw).strip()
        slug = slug_raw.replace(" ", "_")
        if slug in seen:
            continue
        # Skip fighter/organisation pages (no colon or number = likely not an event)
        if ":" not in slug_raw and not re.search(r"\d", slug_raw):
            continue
        ctx = wt[max(0, lm.start()-400):lm.end()+200]
        ev_date = parse_date_wiki(ctx)
        if not ev_date:
            continue
        try:
            ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except:
            continue
        if ed < now - timedelta(days=2) or ed > now + timedelta(days=120):
            continue
        ev_name = clean_wiki(display)
        if not ev_name.startswith("UFC"):
            ev_name = slug_raw.replace("_", " ")
        seen.add(slug)
        events.append((ev_date, slug, asc(ev_name)))
        print("  Discovered: %s (%s)" % (ev_name, ev_date), file=sys.stderr)
    events.sort(key=lambda x: x[0])
    return events

# ---------------------------------------------------------------------------
# UFC Rankings - from Wikipedia UFC_Rankings page
# ---------------------------------------------------------------------------
def fetch_rankings():
    """Parse UFC_Rankings Wikipedia page. Returns dict of fighter_name -> rank (int)."""
    wt = fetch_wikitext("UFC_Rankings") if False else ""  # called after fetch_wikitext defined
    return {}  # placeholder - real impl below after fetch_wikitext

def _fetch_rankings_impl():
    """Actual rankings fetch - called in main() after fetch_wikitext is available."""
    # UFC_Rankings redirects to UFC_rankings; action=parse follows redirects automatically
    wt = fetch_wikitext("UFC_rankings")
    if not wt:
        print("Rankings: could not fetch", file=sys.stderr)
        return {}
    rankings = {}
    # Table format: "! N\n| {{flagicon|XX}}\n| [[Fighter Name]]"
    # Rank line can have any parenthetical annotation: (T), (T2), etc.
    for m in re.finditer(
        r"^!\s*(\d{1,2})(?:\s*\([^)]*\))?\s*\n\|[^\n]*flagicon[^\n]*\n\|\s*\[\[(?:[^\]|]+\|)?([^\]]+)\]\]",
        wt, re.MULTILINE
    ):
        rank = int(m.group(1))
        name = clean_wiki(m.group(2).strip())
        # Strip champion / interim champion markers and any trailing parentheticals
        name = re.sub(r"\s*\([^)]*\)\s*", "", name).strip()
        key = asc(name)   # strips diacritics → matches Odds API names
        if key and 1 <= rank <= 15 and key not in rankings:
            rankings[key] = rank
    print("Rankings: %d fighters indexed" % len(rankings), file=sys.stderr)
    return rankings

def write_rankings(html, rankings):
    """Replace var RANKINGS={...} in HTML with fresh data."""
    js_str = json.dumps(rankings, separators=(",", ":"), ensure_ascii=False)
    updated = re.sub(r"var RANKINGS=\{[^;]*\};", "var RANKINGS=%s;" % js_str, html)
    if updated == html:
        print("Rankings: RANKINGS placeholder not found in HTML", file=sys.stderr)
    return updated

# ---------------------------------------------------------------------------
# Wikipedia - fetch wikitext
# ---------------------------------------------------------------------------
def fetch_wikitext(slug):
    for method, url, params in [
        ("API", WIKI_API, {"action": "parse", "page": slug, "prop": "wikitext", "format": "json"}),
        ("raw", "https://en.wikipedia.org/w/index.php", {"title": slug, "action": "raw"}),
    ]:
        try:
            r = requests.get(url, headers=WIKI_HDR, params=params, timeout=15)
            print("  Wiki %s [%s]: %d" % (method, slug[:40], r.status_code), file=sys.stderr)
            if r.status_code == 200:
                wt = r.json().get("parse", {}).get("wikitext", {}).get("*", "") if method == "API" else r.text
                if wt and len(wt) > 200:
                    print("  Got %d chars" % len(wt), file=sys.stderr)
                    return wt
        except Exception as e:
            print("  Wiki error: %s" % e, file=sys.stderr)
        time.sleep(1)
    return ""

# ---------------------------------------------------------------------------
# Wikipedia - parse upcoming fight card (MMAevent fight template)
# ---------------------------------------------------------------------------
def parse_upcoming_card(wikitext):
    """
    Parse {{MMAevent bout}} templates - handles both upcoming (vs.) and completed (def.) formats.
    Format:
    {{MMAevent bout
    |Featherweight
    |[[Arnold Allen]]
    |vs.
    |[[Melquizael Costa]]
    |...
    }}
    """
    fights = []
    for block in re.finditer(r"\{\{MMAevent bout\s*\n(.*?)\}\}", wikitext, re.DOTALL | re.IGNORECASE):
        lines = [l.strip().lstrip("|").strip() for l in block.group(1).split("\n")
                 if l.strip().lstrip("|").strip()]
        if len(lines) < 3: continue
        vs_idx  = next((i for i,l in enumerate(lines) if l.lower().strip() in ("vs.","vs","v.")), -1)
        def_idx = next((i for i,l in enumerate(lines) if l.lower().strip() in ("def.","def","d.")), -1)
        if vs_idx > 0:
            wc_raw = lines[0]
            f1 = clean_wiki(lines[vs_idx - 1])
            f2 = clean_wiki(lines[vs_idx + 1]) if vs_idx + 1 < len(lines) else "TBD"
        elif def_idx > 0:
            wc_raw = lines[0]
            f1 = clean_wiki(lines[def_idx - 1])
            f2 = clean_wiki(lines[def_idx + 1]) if def_idx + 1 < len(lines) else ""
        else:
            continue
        f1_rk = "C" if re.search(r"\(c\)", f1, re.IGNORECASE) else ("IC" if re.search(r"\(ic\)", f1, re.IGNORECASE) else "")
        f2_rk = "C" if re.search(r"\(c\)", f2, re.IGNORECASE) else ("IC" if re.search(r"\(ic\)", f2, re.IGNORECASE) else "")
        f1 = re.sub(r"\s*\((ic|c)\)\s*", "", f1, flags=re.IGNORECASE).strip()
        f2 = re.sub(r"\s*\((ic|c)\)\s*", "", f2, flags=re.IGNORECASE).strip()
        if not f1 or len(f1) < 2: continue
        wc = norm_wc(clean_wiki(wc_raw))
        raw_block = block.group(1)
        title = "(c)" in raw_block.lower()
        fights.append({"f1": f1, "f1_rk": f1_rk, "f2": f2 or "TBD", "f2_rk": f2_rk, "wc": wc, "title": title})
    return fights


def clean_wiki(text):
    if not text: return ""
    text = re.sub(r"\[\[([^\]|]+\|)?([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\{\{[^}]+\}\}", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\[\d+\]", "", text)
    return asc(text).strip().strip(",").strip()



# ---------------------------------------------------------------------------
# Wikipedia - parse results (fight night)
# ---------------------------------------------------------------------------
def parse_results(wikitext):
    results = []
    for block in re.finditer(r"\{\{MMAevent bout\s*\n(.*?)\}\}", wikitext, re.DOTALL | re.IGNORECASE):
        lines = [l.strip().lstrip("|").strip() for l in block.group(1).split("\n")
                 if l.strip().lstrip("|").strip()]
        if len(lines) < 5: continue
        di = next((i for i, l in enumerate(lines) if l.lower().strip() in ("def.", "def", "d.")), -1)
        if di < 1: continue
        winner = re.sub(r"\s*\(c\)\s*", "", clean_wiki(lines[di - 1])).strip()
        loser  = re.sub(r"\s*\(c\)\s*", "", clean_wiki(lines[di + 1])).strip() if di + 1 < len(lines) else ""
        method = lines[di + 2] if di + 2 < len(lines) else ""
        rnd_s  = lines[di + 3] if di + 3 < len(lines) else ""
        if not winner or not method: continue
        try: rnd = int(rnd_s.strip())
        except: rnd = None
        results.append({"winner": winner, "loser": loser, "method": norm_method(method), "round": rnd})
    # Fallback: wikitable
    if not results:
        in_table = False; row = []
        for line in wikitext.split("\n"):
            s = line.strip()
            if "{|" in s and "wikitable" in s.lower(): in_table = True; row = []; continue
            if s.startswith("|}"): 
                if row:
                    res = flush_result(row)
                    if res: results.append(res)
                in_table = False; row = []; continue
            if not in_table: continue
            if s.startswith("|-"):
                if row:
                    res = flush_result(row)
                    if res: results.append(res)
                row = []; continue
            if s.startswith("!"): row = []; continue
            if s.startswith("|"):
                content = s.lstrip("|")
                if "||" in content: row.extend([clean_wiki(p.strip()) for p in content.split("||")])
                else: row.append(clean_wiki(content))
    return results

def flush_result(row):
    row = [clean_wiki(c) for c in row if clean_wiki(c)]
    if len(row) < 3: return None
    skip = ["weight class","winner","method","round","main card","preliminary","early prelim"]
    if any(h in " ".join(row).lower() for h in skip): return None
    winner = loser = method = ""
    rnd = None
    di = next((i for i,c in enumerate(row) if c.strip().lower() in ("def.","def","d.")), -1)
    if di > 0:
        winner = re.sub(r"\s*\(c\)\s*", "", row[di-1]).strip()
        loser  = re.sub(r"\s*\(c\)\s*", "", row[di+1]).strip() if di+1 < len(row) else ""
        rest   = row[di+2:]
    else:
        if len(row) < 4: return None
        winner=row[1]; loser=row[2]; rest=row[3:]
    if not winner or len(winner) < 2: return None
    for cell in rest:
        cl = cell.lower()
        if any(k in cl for k in ["ko","tko","decision","submission","sub","dq"]):
            if not method: method = cell
        elif re.match(r"^\d$", cell.strip()):
            try: rnd = int(cell.strip())
            except: pass
    if not method and winner and loser and rnd: method = "Decision"
    if not method: return None
    return {"winner":winner,"loser":loser,"method":norm_method(method),"round":rnd}

# ---------------------------------------------------------------------------
# Odds API - fetch and index by fighter pair
# ---------------------------------------------------------------------------
def fetch_odds():
    if not ODDS_API_KEY:
        print("No ODDS_API_KEY", file=sys.stderr)
        return {}
    try:
        r = requests.get(ODDS_API_URL, params={
            "apiKey": ODDS_API_KEY, "regions": "us",
            "markets": "h2h", "oddsFormat": "american",
        }, timeout=15)
        print("Odds API: %d | remaining: %s" % (
            r.status_code, r.headers.get("x-requests-remaining", "?")), file=sys.stderr)
        if r.status_code != 200: return {}
        data = r.json()
    except Exception as e:
        print("Odds API error:", e, file=sys.stderr)
        return {}

    # Index by sorted fighter pair for fast lookup
    preferred = ["fanduel","draftkings","betrivers","bovada","betonlineag","betus"]
    odds_index = {}
    for fight in data:
        h = clean(fight.get("home_team",""))
        a = clean(fight.get("away_team",""))
        if not h or not a: continue
        books = sorted(fight.get("bookmakers",[]),
                       key=lambda b: preferred.index(b["key"]) if b["key"] in preferred else 99)
        p1, p2 = [], []
        for bm in books[:3]:
            for mkt in bm.get("markets",[]):
                if mkt["key"] != "h2h": continue
                for o in mkt["outcomes"]:
                    nl = o["name"].lower()
                    if h.lower() in nl or nl in h.lower(): p1.append(o["price"])
                    elif a.lower() in nl or nl in a.lower(): p2.append(o["price"])
        if p1 and p2:
            pair = tuple(sorted([h.lower(), a.lower()]))
            odds_index[pair] = {
                "f1_name": h, "f2_name": a,
                "f1_odds": round(sum(p1)/len(p1)),
                "f2_odds": round(sum(p2)/len(p2)),
            }
    print("Odds indexed: %d fights" % len(odds_index), file=sys.stderr)
    return odds_index

def get_odds(odds_index, f1_name, f2_name):
    """Look up odds for a fight by fuzzy fighter name matching."""
    f1l = f1_name.lower(); f2l = f2_name.lower()
    f1_last = last_name(f1_name); f2_last = last_name(f2_name)
    for pair, o in odds_index.items():
        n1, n2 = pair
        # Match if last names appear in the indexed names
        match_f1 = f1_last in n1 or n1 in f1l or f1l in n1
        match_f2 = f2_last in n2 or n2 in f2l or f2l in n2
        match_swap1 = f1_last in n2 or n2 in f1l or f1l in n2
        match_swap2 = f2_last in n1 or n1 in f2l or f2l in n1
        if match_f1 and match_f2:
            return {"f1": o["f1_odds"], "f2": o["f2_odds"]}
        if match_swap1 and match_swap2:
            return {"f1": o["f2_odds"], "f2": o["f1_odds"]}
    return None

def extract_existing_odds(html):
    """Extract existing odds from the current EVENTS array in HTML.
    Returns dict keyed by frozenset of last names -> {f1_name, f2_name, f1_odds, f2_odds}."""
    existing = {}
    # Serialization order: odds:{f1:N,f2:M},...,f1:{n:"NAME"...},f2:{n:"NAME"...}
    pat = re.compile(
        r'odds:\{f1:(-?\d+),f2:(-?\d+)\}[^f]*?f1:\{n:"([^"]+)"[^}]*\},f2:\{n:"([^"]+)"'
    )
    for m in pat.finditer(html):
        f1o, f2o, f1n, f2n = int(m.group(1)), int(m.group(2)), m.group(3), m.group(4)
        key = frozenset([last_name(f1n), last_name(f2n)])
        existing[key] = {"f1_name": f1n, "f2_name": f2n, "f1_odds": f1o, "f2_odds": f2o}
    print("Existing odds preserved: %d fights" % len(existing), file=sys.stderr)
    return existing

def get_odds_with_fallback(odds_index, existing_odds, f1_name, f2_name):
    """Look up odds from API first, fall back to existing HTML odds."""
    result = get_odds(odds_index, f1_name, f2_name)
    if result:
        return result
    # Fall back to existing odds from previous HTML
    key = frozenset([last_name(f1_name), last_name(f2_name)])
    o = existing_odds.get(key)
    if not o:
        return None
    # Return odds in the right order (f1/f2 may be swapped vs stored)
    if last_name(f1_name) == last_name(o["f1_name"]):
        return {"f1": o["f1_odds"], "f2": o["f2_odds"]}
    return {"f1": o["f2_odds"], "f2": o["f1_odds"]}

# ---------------------------------------------------------------------------
# UFCStats - fighter stats
# ---------------------------------------------------------------------------
_ufcstats_letter_cache = {}  # letter -> list of (first, last, href, w, l, d)

def _load_ufcstats_letter(letter):
    """Fetch all fighters whose last name starts with letter. Cached per letter."""
    letter = letter.lower()
    if letter in _ufcstats_letter_cache:
        return _ufcstats_letter_cache[letter]
    try:
        r = requests.get(
            "http://www.ufcstats.com/statistics/fighters",
            params={"char": letter, "page": "all"},
            timeout=20, headers={"User-Agent": "UFC-Dashboard/1.0 (github.com/AndyRBrett/ufc-dashboard)"}
        )
        if r.status_code != 200:
            _ufcstats_letter_cache[letter] = []
            return []
        soup = BeautifulSoup(r.text, "html.parser")
        entries = []
        for row in soup.select("table.b-statistics__table tbody tr"):
            cells = row.select("td")
            if len(cells) < 10:
                continue
            fl = cells[0].find("a")
            ll = cells[1].find("a")
            if not fl and not ll:
                continue
            first = fl.get_text(strip=True) if fl else ""
            last  = ll.get_text(strip=True) if ll else ""
            href  = (fl or ll).get("href", "")
            try:
                w = int(cells[7].get_text(strip=True) or 0)
                l = int(cells[8].get_text(strip=True) or 0)
                d = int(cells[9].get_text(strip=True) or 0)
            except:
                w = l = d = 0
            entries.append((first, last, href, w, l, d))
        _ufcstats_letter_cache[letter] = entries
        time.sleep(0.5)
        return entries
    except Exception as e:
        print("  UFCStats letter fetch error (%s): %s" % (letter, e), file=sys.stderr)
        _ufcstats_letter_cache[letter] = []
        return []

def _name_tokens_match(row_first, row_last, target_name):
    """Strict match: require last name equality AND at least one first-name token match."""
    target_parts = clean(target_name).lower().split()
    if not target_parts:
        return False
    row_f = clean(row_first).lower()
    row_l = clean(row_last).lower()
    target_last = target_parts[-1]
    target_firsts = set(target_parts[:-1])

    # Allow last names to match in either direction (Western vs Asian ordering)
    if row_l == target_last:
        if not target_firsts:
            return True
        return any(t == row_f or row_f.startswith(t[:2]) for t in target_firsts if len(t) >= 2)
    # Also try if row_first matches target_last (reversed order like Song Yadong)
    if row_f == target_last:
        if not target_firsts:
            return True
        return any(t == row_l or row_l.startswith(t[:2]) for t in target_firsts if len(t) >= 2)
    return False

def _search_ufcstats(name, last):
    """Search ufcstats.com by last-name initial (with first-name fallback). Returns (detail_url, rec) or None."""
    if not last:
        return None
    parts = clean(name).split()
    # Try last-name initial first, then first-name initial as fallback (for Asian name ordering)
    letters_to_try = [last[0].lower()]
    if len(parts) >= 2 and parts[0][0].lower() != last[0].lower():
        letters_to_try.append(parts[0][0].lower())
    for letter in letters_to_try:
        entries = _load_ufcstats_letter(letter)
        for row_first, row_last, href, w, l, d in entries:
            if _name_tokens_match(row_first, row_last, name):
                rec = "%d-%d-%d" % (w, l, d) if (w or l) else ""
                return (href, rec)
    return None

def fetch_fighter_stats(name):
    """Fetch fighter stats from ufcstats.com. Returns dict or None."""
    parts = clean(name).strip().split()
    if not parts:
        return None
    last = parts[-1]

    print("  UFCStats search [%s] last=%r" % (name, last), file=sys.stderr)
    hit = _search_ufcstats(name, last)

    if not hit:
        print("  UFCStats: no match for %s" % name, file=sys.stderr)
        return None

    detail_url, rec = hit
    if not detail_url:
        return None

    # Fetch detail page for career stats, KO/sub counts, physical attributes, and fight form
    slpm = acc = td = tdd = 0.0
    ko = sub = 0
    ht = rch = stn = dob = ""
    form = []
    time.sleep(0.5)
    try:
        dr = requests.get(detail_url, timeout=15, headers={"User-Agent": "UFC-Dashboard/1.0"})
        if dr.status_code == 200:
            dsoup = BeautifulSoup(dr.text, "html.parser")
            # Career stats are in li.b-list__box-list-item as "SLpM:4.61" style text
            for li in dsoup.select("li.b-list__box-list-item"):
                txt = li.get_text(strip=True)
                if ":" not in txt:
                    continue
                key, _, val = txt.partition(":")
                key = key.strip().lower()
                raw_val = val.strip()
                val = raw_val.replace("%", "").replace("---", "0") or "0"
                try:
                    if "slpm" in key:
                        slpm = round(float(val), 2)
                    elif "str. acc" in key or "str.acc" in key:
                        acc = int(round(float(val)))
                    elif "td avg" in key:
                        td = round(float(val), 2)
                    elif "td def" in key:
                        tdd = int(round(float(val)))
                    elif "height" in key and raw_val and raw_val not in ("---", "--"):
                        ht = raw_val
                    elif "reach" in key and raw_val and raw_val not in ("---", "--"):
                        rch = raw_val
                    elif "stance" in key and raw_val and raw_val not in ("---", "--"):
                        stn = raw_val
                    elif "dob" in key and raw_val and raw_val not in ("---", "--"):
                        dob = raw_val
                except:
                    pass
            for frow in dsoup.select("tbody.b-fight-details__table-body tr"):
                cells_d = frow.select("td")
                if len(cells_d) < 8:
                    continue
                result_txt = cells_d[0].get_text(strip=True).lower()
                method_txt = cells_d[7].get_text(strip=True) if len(cells_d) > 7 else ""
                ml = method_txt.lower()
                if result_txt == "win":
                    if "ko" in ml or "tko" in ml:
                        ko += 1
                    elif "sub" in ml:
                        sub += 1
                if result_txt in ("win", "loss", "draw") and len(form) < 5:
                    r_char = "W" if result_txt == "win" else ("L" if result_txt == "loss" else "D")
                    if "tko" in ml:
                        ms_str = "TKO"
                    elif "ko" in ml:
                        ms_str = "KO"
                    elif "sub" in ml:
                        ms_str = "Sub"
                    elif "dec" in ml or "decision" in ml:
                        ms_str = "Dec"
                    elif "dq" in ml:
                        ms_str = "DQ"
                    else:
                        ms_str = method_txt.strip()[:3] if method_txt.strip() else ""
                    form.append({"r": r_char, "m": ms_str})
    except Exception as e:
        print("  UFCStats detail error: %s" % e, file=sys.stderr)

    print("  Stats %s: slpm=%s acc=%s td=%s tdd=%s ko=%s sub=%s rec=%s ht=%r form=%d" % (
        name, slpm, acc, td, tdd, ko, sub, rec, ht, len(form)), file=sys.stderr)
    return {"slpm": slpm, "acc": acc, "td": td, "tdd": tdd, "ko": ko, "sub": sub, "rec": rec,
            "ht": ht, "rch": rch, "stn": stn, "dob": dob, "form": form}

def extract_stats_cache(html):
    """Read FIGHTER_STATS JSON from HTML. Returns dict."""
    m = re.search(r"var FIGHTER_STATS=(\{.*?\});", html, re.DOTALL)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except:
        return {}

def write_stats_cache(html, cache):
    """Replace FIGHTER_STATS object in HTML with updated cache."""
    js_str = json.dumps(cache, separators=(",", ":"), ensure_ascii=False)
    return re.sub(r"var FIGHTER_STATS=\{.*?\};", "var FIGHTER_STATS=%s;" % js_str, html, flags=re.DOTALL)

# ---------------------------------------------------------------------------
# Inject results into JS
# ---------------------------------------------------------------------------
def inject_results(js, results):
    count = 0
    pattern = r'f1:\{n:"([^"]+)"[^}]+\},f2:\{n:"([^"]+)"'
    for res in results:
        winner=res["winner"]; loser=res["loser"]; method=res["method"]; rnd=res["round"]
        for m in re.finditer(pattern, js):
            f1n,f2n = m.group(1),m.group(2)
            f1w = names_match(f1n,winner) and (not loser or names_match(f2n,loser))
            f2w = names_match(f2n,winner) and (not loser or names_match(f1n,loser))
            if not f1w and not f2w: continue
            wn = f1n if f1w else f2n
            fs = js.rfind("{lbl:",0,m.start())
            if fs < 0: continue
            if 'state:"post"' in js[fs:fs+300]:
                print("  Already set: %s" % wn, file=sys.stderr)
                break
            depth=0; fe=fs
            for i in range(fs,min(fs+2000,len(js))):
                if js[i]=="{": depth+=1
                elif js[i]=="}": depth-=1
                if depth==0: fe=i+1; break
            fstr=js[fs:fe]
            fstr=re.sub(r'winner:"[^"]*"', lambda x:'winner:"'+wn+'"', fstr)
            fstr=re.sub(r'method:"[^"]*"', lambda x:'method:"'+method+'"', fstr)
            fstr=re.sub(r"round:(?:null|\d+)", "round:"+(str(rnd) if rnd else "null"), fstr)
            fstr=re.sub(r'state:"[^"]*"', 'state:"post"', fstr)
            js=js[:fs]+fstr+js[fe:]
            print("  Injected: %s def %s R%s" % (wn,f2n if f1w else f1n,rnd), file=sys.stderr)
            count+=1; break
    return js, count

# ---------------------------------------------------------------------------
# JS serialization
# ---------------------------------------------------------------------------
def fight_js(f, comma=""):
    f1=f["f1"]; f2=f["f2"]
    odds=f.get("odds")
    odds_s="{f1:%d,f2:%d}"%(odds["f1"],odds["f2"]) if odds else "null"
    rnd=str(f.get("round") or "null")
    return ("      {lbl:%s,wc:%s,title:%s,odds:%s,winner:%s,method:%s,"
            "round:%s,state:%s,f1:{n:%s,r:%s,rk:%s,s:null},"
            "f2:{n:%s,r:%s,rk:%s,s:null}}%s") % (
        json.dumps(f.get("label","")), json.dumps(f.get("wc","TBD")),
        "true" if f.get("title") else "false", odds_s,
        json.dumps(f.get("winner","")), json.dumps(f.get("method","")),
        rnd, json.dumps(f.get("state","pre")),
        json.dumps(f1.get("name","TBD")), json.dumps(f1.get("record","")),
        json.dumps(f1.get("ranking","")),
        json.dumps(f2.get("name","TBD")), json.dumps(f2.get("record","")),
        json.dumps(f2.get("ranking","")), comma)

def events_js(evs):
    out=["var EVENTS=["]
    for ei,ev in enumerate(evs):
        c="," if ei<len(evs)-1 else ""
        out+=["  {",
            "    name:"+json.dumps(ev["name"])+",",
            "    date:"+json.dumps(ev["date"])+",",
            "    venue:"+json.dumps(ev.get("venue",""))+",",
            "    loc:"+json.dumps(ev.get("loc",""))+",",
            "    tv:"+json.dumps(ev.get("tv","Paramount+"))+",",
            "    time:"+json.dumps(ev.get("time","TBD"))+","]
        if ev.get("prelimTime"):
            out.append("    prelimTime:"+json.dumps(ev["prelimTime"])+",")
        out.append("    fights:[")
        fs=ev.get("fights",[])
        for fi,f in enumerate(fs):
            out.append(fight_js(f,"," if fi<len(fs)-1 else ""))
        out+=["    ]","  }"+c]
    out.append("];")
    return "\n".join(out)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    index = Path("index.html")
    if not index.exists():
        print("No index.html", file=sys.stderr); sys.exit(1)

    html = index.read_text(encoding="utf-8")
    now  = datetime.now(timezone.utc)
    js_start = html.find("<script>") + 8
    js_end   = html.rfind("</script>")
    js       = html[js_start:js_end]

    ex_names = re.findall(r'name:"([^"]+)"', html)
    ex_dates = re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', html)
    print("Existing events:", list(zip(ex_dates[:6], ex_names[:6])), file=sys.stderr)

    # -- Step 1: Wikipedia results for recent events (fight night) --
    total_injected = 0
    for ev_name, ev_date in zip(ex_names, ex_dates):
        try: ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except: continue
        if ed < now - timedelta(days=2) or ed > now + timedelta(hours=6): continue
        print("Checking results:", ev_name, file=sys.stderr)
        slug = re.sub(r"[^a-zA-Z0-9 :._-]", "", ev_name).replace(" ", "_")
        wt = fetch_wikitext(slug)
        if wt:
            results = parse_results(wt)
            if results:
                js, n = inject_results(js, results)
                total_injected += n
        time.sleep(1)

    if total_injected > 0:
        html_new = html[:js_start] + js + html[js_end:]
        html_new = re.sub(r'var GENERATED_AT="[^"]*"', 'var GENERATED_AT="%s"' % fmt_update(now), html_new)
        index.write_text(html_new, encoding="utf-8")
        print("Results injected:", total_injected, file=sys.stderr)
        # Collect newly-injected results for push notifications
        new_results = []
        for ev_name, ev_date in zip(ex_names, ex_dates):
            try: ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            except: continue
            if ed < now - timedelta(days=2) or ed > now + timedelta(hours=6): continue
            slug = re.sub(r"[^a-zA-Z0-9 :._-]", "", ev_name).replace(" ", "_")
            wt = fetch_wikitext(slug)
            if wt:
                new_results.extend(parse_results(wt))
        send_push_notifications(new_results)
        sys.exit(0)

    # -- Step 2: Fetch Odds API for moneylines (preserve existing if key absent) --
    print("Fetching odds...", file=sys.stderr)
    existing_odds = extract_existing_odds(html)
    odds_index = fetch_odds()

    # -- Step 3: Build events from Wikipedia + enrich with odds --
    print("Building events from Wikipedia...", file=sys.stderr)
    new_events = []

    # Merge hardcoded events with auto-discovered ones from Wikipedia
    hc_slugs = {row[1] for row in UPCOMING_EVENTS}
    discovered = discover_upcoming_events(now)
    merged = list(UPCOMING_EVENTS)
    for ev_date, slug, ev_name in discovered:
        if slug not in hc_slugs:
            print("  Auto-adding missing event: %s (%s)" % (ev_name, ev_date), file=sys.stderr)
            merged.append((ev_date, slug, ev_name, "TBD", "TBD", "20:00", "17:00"))
            hc_slugs.add(slug)
    merged.sort(key=lambda x: x[0])

    for ev_date, slug, ev_name, venue, loc, main_time, prelim_time in merged:
        try: ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except: continue
        if ed < now - timedelta(days=30) or ed > now + timedelta(days=90): continue

        print("Fetching:", ev_name, file=sys.stderr)
        wt = fetch_wikitext(slug)
        wiki_fights = parse_upcoming_card(wt) if wt else []
        print("  Wiki fights found: %d" % len(wiki_fights), file=sys.stderr)

        if not wiki_fights:
            # No Wikipedia data yet - add placeholder with just main event from name
            m = re.search(r":\s*(\w+)\s+vs\.?\s+(\w+)", ev_name, re.IGNORECASE)
            if m:
                wiki_fights = [{"f1": m.group(1), "f2": m.group(2), "wc": "TBD", "title": False}]

        # Assign card labels
        card = []
        for i, wf in enumerate(wiki_fights):
            f1 = wf["f1"]; f2 = wf["f2"]
            if i == 0:   lbl = "Main Event"
            elif i == 1: lbl = "Co-Main"
            elif i < 5:  lbl = "Main Card"
            else:        lbl = "Prelim"
            odds = get_odds_with_fallback(odds_index, existing_odds, f1, f2)
            card.append({
                "label": lbl, "wc": wf.get("wc","TBD"), "title": wf.get("title",False),
                "odds": odds, "winner": "", "method": "", "round": None, "state": "pre",
                "f1": {"name": f1, "record": "", "ranking": wf.get("f1_rk", "")},
                "f2": {"name": f2, "record": "", "ranking": wf.get("f2_rk", "")},
            })

        if not card: continue

        ev = {
            "name": ev_name, "date": ev_date,
            "venue": venue, "loc": loc,
            "tv": "Paramount+", "time": main_time,
            "prelimTime": prelim_time,
            "fights": card,
        }
        new_events.append(ev)
        print("  Built: %s (%d fights)" % (ev_name, len(card)), file=sys.stderr)
        time.sleep(1)

    if not new_events:
        print("No events built - keeping existing", file=sys.stderr)
        sys.exit(0)

    # -- Step 4: Fetch stats before serialization so records can be back-filled --
    stats_cache = extract_stats_cache(html)
    all_fighters = set()
    for ev in new_events:
        for fight in ev["fights"]:
            for side in (fight["f1"], fight["f2"]):
                n = side.get("name", "")
                if n and n != "TBD":
                    all_fighters.add(n)
    new_fighters = sorted(n for n in all_fighters if n not in stats_cache)

    # Fighters missing form data (first-time backfill — no cap, fetch all at once)
    stale_fighters = sorted(n for n in all_fighters
                            if n in stats_cache and "form" not in stats_cache[n])

    # Fighters whose record has changed since last fetch (they had a new fight)
    # Build a record lookup from the current event cards
    card_records = {}
    for ev in new_events:
        for fight in ev["fights"]:
            for side in (fight["f1"], fight["f2"]):
                n = side.get("name", "")
                r = side.get("record", "")
                if n and r:
                    card_records[n] = r
    outdated_fighters = sorted(
        n for n in all_fighters
        if n in stats_cache and "form" in stats_cache[n]
        and card_records.get(n) and card_records[n] != stats_cache[n].get("rec", "")
    )

    to_fetch = new_fighters + stale_fighters + outdated_fighters
    print("Fetching stats for %d fighters (%d new, %d backfill, %d record-changed)..." % (
        len(to_fetch), len(new_fighters), len(stale_fighters), len(outdated_fighters)), file=sys.stderr)
    for fname in to_fetch:
        s = fetch_fighter_stats(fname)
        if s:
            stats_cache[fname] = s
        time.sleep(1)
    print("Stats cache: %d fighters" % len(stats_cache), file=sys.stderr)

    # Back-fill fighter records from stats cache into new_events before serialization
    for ev in new_events:
        for fight in ev["fights"]:
            for sk in ("f1", "f2"):
                f = fight[sk]
                if not f.get("record"):
                    s = stats_cache.get(f.get("name", ""), {})
                    if s and s.get("rec"):
                        f["record"] = s["rec"]

    new_js = events_js(new_events)
    html_new = re.sub(r"var EVENTS\s*=\s*\[.*?\];", lambda m: new_js, html, flags=re.DOTALL)
    pass  # updateDate is computed dynamically in JS from fight data
    html_new = write_stats_cache(html_new, stats_cache)

    rankings = _fetch_rankings_impl()
    if rankings:
        html_new = write_rankings(html_new, rankings)

    if len(html_new) < 30000:
        print("Output too small - aborting", file=sys.stderr); sys.exit(0)

    html_new = re.sub(r'var GENERATED_AT="[^"]*"', 'var GENERATED_AT="%s"' % fmt_update(now), html_new)
    index.write_text(html_new, encoding="utf-8")
    print("Done: %d events, %d fights" % (
        len(new_events), sum(len(e["fights"]) for e in new_events)
    ), file=sys.stderr)

if __name__ == "__main__":
    main()