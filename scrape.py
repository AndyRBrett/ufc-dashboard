#!/usr/bin/env python3
# UFC scraper - The Odds API for card structure + odds, Wikipedia for results
import json, os, re, sys, time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests
from bs4 import BeautifulSoup

# -- Config ------------------------------------------------------------------
ODDS_API_KEY = os.environ.get("ODDS_API_KEY", "")
ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds"
WIKI_API     = "https://en.wikipedia.org/w/api.php"
WIKI_UA      = "UFC-Dashboard/1.0 (https://github.com/AndyRBrett/ufc-dashboard; andyrbrett@gmail.com)"
WIKI_HEADERS = {"User-Agent": WIKI_UA}

# Known UFC event names keyed by ET date string
# Scraper updates these when it finds new fights on a date
EVENT_NAMES = {
    "2026-05-16": "UFC Fight Night: Allen vs. Costa",
    "2026-05-30": "UFC Fight Night: Song vs. Figueiredo",
    "2026-06-14": "UFC Freedom 250: Topuria vs. Gaethje",
    "2026-06-27": "UFC Fight Night: Fiziev vs. Torres",
    "2026-07-11": "UFC 329",
}

# Fights to exclude (non-UFC promotions appearing in MMA API)
EXCLUDE_FIGHTERS = {
    "ronda rousey","gina carano","francis ngannou","junior dos santos",
    "nate diaz","mike perry","jason jackson","jeff creighton",
    "salahdine parnasse","kenneth cross","junior dos santos","robelis despaigne",
    "philipe lins",
}

# -- Utilities ----------------------------------------------------------------
def asc(t):
    if not t: return ""
    return "".join(c for c in str(t) if ord(c) < 128).strip()

def names_match(a, b):
    a2 = re.sub(r"[^a-z]", "", a.lower())
    b2 = re.sub(r"[^a-z]", "", b.lower())
    la = a.strip().split()[-1].lower() if a.strip() else ""
    lb = b.strip().split()[-1].lower() if b.strip() else ""
    return la == lb or (len(a2) > 3 and a2 in b2) or (len(b2) > 3 and b2 in a2)

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

def fmt_time(dt):
    h = dt.hour % 12 or 12
    ap = "AM" if dt.hour < 12 else "PM"
    return "%d:%02d %s" % (h, dt.minute, ap)

def fmt_label(dt):
    h = dt.hour % 12 or 12
    ap = "AM" if dt.hour < 12 else "PM"
    return "%d:%02d" % (h, dt.minute)

def fmt_update(dt):
    h = dt.hour % 12 or 12
    ap = "AM" if dt.hour < 12 else "PM"
    return "%d %s %d %d:%02d %s UTC" % (dt.day, dt.strftime("%b"), dt.year, h, dt.minute, ap)

# -- The Odds API ------------------------------------------------------------
def fetch_odds():
    if not ODDS_API_KEY:
        print("No ODDS_API_KEY set", file=sys.stderr)
        return []
    try:
        r = requests.get(ODDS_API_URL, params={
            "apiKey": ODDS_API_KEY,
            "regions": "us",
            "markets": "h2h",
            "oddsFormat": "american",
        }, timeout=15)
        print("Odds API status:", r.status_code, file=sys.stderr)
        remaining = r.headers.get("x-requests-remaining", "?")
        print("API requests remaining:", remaining, file=sys.stderr)
        if r.status_code == 200:
            return r.json()
        print("Odds API error:", r.text[:200], file=sys.stderr)
    except Exception as e:
        print("Odds API exception:", e, file=sys.stderr)
    return []

MAJOR_BOOKS = {"fanduel", "draftkings", "betrivers", "bovada", "betus"}

def is_ufc_fight(fight):
    h = fight.get("home_team", "").lower()
    a = fight.get("away_team", "").lower()
    # Exclude known non-UFC fighters
    for name in EXCLUDE_FIGHTERS:
        if name in h or name in a:
            return False
    # Require at least 2 major US bookmakers - filters out small/regional shows
    # UFC fights are covered by FanDuel, DraftKings, BetRivers, Bovada, BetUS
    # Non-UFC fringe fights usually only appear on BetOnline
    major_count = sum(1 for bm in fight.get("bookmakers", []) if bm["key"] in MAJOR_BOOKS)
    if major_count < 2:
        return False
    return True

def best_odds(fight, f1_name, f2_name):
    """Average odds for f1 and f2 across up to 3 preferred bookmakers."""
    preferred = ["fanduel", "draftkings", "betrivers", "bovada", "betonlineag", "betus"]
    bookmakers = sorted(
        fight.get("bookmakers", []),
        key=lambda b: preferred.index(b["key"]) if b["key"] in preferred else 99
    )
    f1_prices, f2_prices = [], []
    for bm in bookmakers[:3]:
        for mkt in bm.get("markets", []):
            if mkt["key"] != "h2h": continue
            for o in mkt["outcomes"]:
                nl = o["name"].lower()
                if f1_name.lower() in nl or nl in f1_name.lower():
                    f1_prices.append(o["price"])
                elif f2_name.lower() in nl or nl in f2_name.lower():
                    f2_prices.append(o["price"])
    if not f1_prices or not f2_prices:
        return None
    return {
        "f1": round(sum(f1_prices) / len(f1_prices)),
        "f2": round(sum(f2_prices) / len(f2_prices)),
    }

def group_by_event(fights):
    """Group individual fights into events by ET date."""
    events = defaultdict(list)
    for f in fights:
        if not is_ufc_fight(f): continue
        ct = datetime.fromisoformat(f["commence_time"].replace("Z", "+00:00"))
        et = ct - timedelta(hours=4)  # UTC to ET
        et_date = et.strftime("%Y-%m-%d")
        events[et_date].append(f)
    return dict(sorted(events.items()))

def build_events_from_odds(fights):
    """Convert Odds API fights into EVENTS array structure."""
    grouped = group_by_event(fights)
    now = datetime.now(timezone.utc)
    events = []

    for et_date, day_fights in grouped.items():
        try:
            ed = datetime.strptime(et_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except: continue
        # Skip past events (more than 2 days ago) and far future (>65 days)
        if ed < now - timedelta(days=2) or ed > now + timedelta(days=65):
            continue
        # Skip events happening today or earlier if they have no future fights
        # (avoids pulling in fights that already happened today)
        day_future = [f for f in day_fights
                      if datetime.fromisoformat(f["commence_time"].replace("Z","+00:00")) > now]
        if not day_future and ed <= now:
            print("Skipping past-day event:", et_date, file=sys.stderr)
            continue
        if len(day_fights) < 4:
            continue  # UFC events have at least 4-6 fights with major odds

        # Get event name from known map or derive from fighters
        ev_name = EVENT_NAMES.get(et_date, "UFC Fight Night")

        # Sort fights by commence_time to determine card position
        day_fights_sorted = sorted(day_fights, key=lambda f: f["commence_time"])

        # The main event is typically the last fight (latest start time)
        # For numbered events, reverse the order since early prelims come first
        # Use commence time: later = higher card position
        fights_by_time = sorted(day_fights_sorted, key=lambda f: f["commence_time"])

        # Deduplicate fights (API may have dupes with different bookmakers)
        seen_pairs = set()
        unique_fights = []
        for f in fights_by_time:
            pair = tuple(sorted([f["home_team"].lower(), f["away_team"].lower()]))
            if pair not in seen_pairs:
                seen_pairs.add(pair)
                unique_fights.append(f)

        # Reverse to get main event first (latest commence = main card)
        unique_fights = list(reversed(unique_fights))

        # Assign labels
        card_fights = []
        for i, f in enumerate(unique_fights):
            # Strip non-ASCII from fighter names (API uses unicode like \u0107)
            f1 = "".join(c for c in f["home_team"] if ord(c) < 128).strip()
            f2 = "".join(c for c in f["away_team"] if ord(c) < 128).strip()
            if not f1 or not f2: continue
            odds = best_odds(f, f1, f2)
            if i == 0: lbl = "Main Event"
            elif i == 1: lbl = "Co-Main"
            elif i < 5: lbl = "Main Card"
            else: lbl = "Prelim"
            card_fights.append({
                "label": lbl, "wc": "TBD", "title": False,
                "odds": odds,
                "winner": "", "method": "", "round": None, "state": "pre",
                "f1": {"name": f1, "record": "", "ranking": ""},
                "f2": {"name": f2, "record": "", "ranking": ""},
            })

        # Determine main card time from last few fights
        if unique_fights:
            last_ct = datetime.fromisoformat(unique_fights[0]["commence_time"].replace("Z", "+00:00"))
            last_et = last_ct - timedelta(hours=4)
            main_time = "%02d:%02d" % (last_et.hour, last_et.minute)
        else:
            main_time = "TBD"

        events.append({
            "name": ev_name,
            "date": et_date,
            "venue": "", "location": "",
            "broadcast": "Paramount+",
            "time": main_time,
            "fights": card_fights,
        })

    return events

# -- Wikipedia results --------------------------------------------------------
def wiki_slug(ev_name):
    m = re.search(r"UFC (\d+)", ev_name)
    if m: return "UFC_" + m.group(1)
    clean = re.sub(r"[^a-zA-Z0-9 :._-]", "", ev_name)
    return clean.replace(" ", "_")

def clean_wiki(text):
    if not text: return ""
    text = re.sub(r"\[\[([^\]|]+\|)?([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\{\{[^}]+\}\}", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\[\d+\]", "", text)
    return asc(text).strip().strip(",").strip()

def fetch_wikitext(slug):
    for method, url, params in [
        ("API", WIKI_API, {"action":"parse","page":slug,"prop":"wikitext","format":"json"}),
        ("raw", "https://en.wikipedia.org/w/index.php", {"title":slug,"action":"raw"}),
    ]:
        try:
            r = requests.get(url, headers=WIKI_HEADERS, params=params, timeout=15)
            print("  Wiki %s: %d" % (method, r.status_code), file=sys.stderr)
            if r.status_code == 200:
                if method == "API":
                    wt = r.json().get("parse",{}).get("wikitext",{}).get("*","")
                else:
                    wt = r.text
                if wt and len(wt) > 500:
                    print("  Got %d chars" % len(wt), file=sys.stderr)
                    return wt
        except Exception as e:
            print("  Wiki %s error: %s" % (method, e), file=sys.stderr)
        time.sleep(1)
    return ""

def parse_mmaevent_bouts(wikitext):
    """Parse {{MMAevent bout}} template - the standard UFC Wikipedia format."""
    results = []
    for block in re.finditer(r"\{\{MMAevent bout\s*\n(.*?)\}\}", wikitext, re.DOTALL | re.IGNORECASE):
        lines = [l.strip().lstrip("|").strip() for l in block.group(1).split("\n") if l.strip().lstrip("|").strip()]
        if len(lines) < 5: continue
        def_idx = next((i for i, l in enumerate(lines) if l.lower().strip() in ("def.", "def", "d.")), -1)
        if def_idx < 1: continue
        winner = clean_wiki(lines[def_idx - 1])
        loser  = clean_wiki(lines[def_idx + 1]) if def_idx + 1 < len(lines) else ""
        winner = re.sub(r"\s*\(c\)\s*", "", winner).strip()
        loser  = re.sub(r"\s*\(c\)\s*", "", loser).strip()
        method_raw = lines[def_idx + 2] if def_idx + 2 < len(lines) else ""
        rnd_raw    = lines[def_idx + 3] if def_idx + 3 < len(lines) else ""
        if not winner or not method_raw: continue
        try: rnd = int(rnd_raw.strip())
        except: rnd = None
        results.append({"winner": winner, "loser": loser,
            "method": norm_method(method_raw), "round": rnd})
    return results

def parse_wikitable(wikitext):
    """Fallback: parse standard wikitable row format."""
    results = []
    in_table = False
    current_row = []

    def process_row(row):
        row = [clean_wiki(c) for c in row if c and clean_wiki(c)]
        if len(row) < 3: return None
        skip = ["weight class","winner","method","round","main card","preliminary","early prelim"]
        if any(h in " ".join(row).lower() for h in skip): return None
        winner = ""; loser = ""; method = ""; rnd = None
        def_idx = next((i for i, c in enumerate(row) if c.strip().lower() in ("def.","def","d.")), -1)
        if def_idx > 0:
            winner = row[def_idx - 1]
            loser  = row[def_idx + 1] if def_idx + 1 < len(row) else ""
            rest   = row[def_idx + 2:]
        else:
            if len(row) < 4: return None
            winner = row[1]; loser = row[2]; rest = row[3:]
        winner = re.sub(r"\s*\(c\)\s*", "", winner).strip()
        loser  = re.sub(r"\s*\(c\)\s*", "", loser).strip()
        if not winner or len(winner) < 2: return None
        for cell in rest:
            cl = cell.lower()
            if any(k in cl for k in ["ko","tko","decision","submission","sub","dq"]):
                if not method: method = cell
            elif re.match(r"^\d$", cell.strip()):
                try: rnd = int(cell.strip())
                except: pass
        if not method and winner and loser and rnd:
            method = "Decision"
        if not method: return None
        return {"winner": winner, "loser": loser, "method": norm_method(method), "round": rnd}

    for line in wikitext.split("\n"):
        s = line.strip()
        if "{|" in s and "wikitable" in s.lower(): in_table = True; current_row = []; continue
        if s.startswith("|}"):
            if current_row:
                res = process_row(current_row)
                if res: results.append(res)
            in_table = False; current_row = []; continue
        if not in_table: continue
        if s.startswith("|-"):
            if current_row:
                res = process_row(current_row)
                if res: results.append(res)
            current_row = []; continue
        if s.startswith("!"): current_row = []; continue
        if s.startswith("|"):
            content = s.lstrip("|")
            if "||" in content:
                current_row.extend([clean_wiki(p.strip()) for p in content.split("||")])
            else:
                current_row.append(clean_wiki(content))
    return results

def fetch_wiki_results(ev_name):
    slug = wiki_slug(ev_name)
    print("Fetching wiki results:", slug, file=sys.stderr)
    wikitext = fetch_wikitext(slug)
    if not wikitext: return []
    results = parse_mmaevent_bouts(wikitext) or parse_wikitable(wikitext)
    print("  Found %d results" % len(results), file=sys.stderr)
    for r in results:
        print("  %s def %s by %s R%s" % (r["winner"],r["loser"],r["method"],r["round"]), file=sys.stderr)
    return results

def inject_results(js, results):
    """Inject Wikipedia results into EVENTS JS array."""
    count = 0
    pattern = r'f1:\{n:"([^"]+)"[^}]+\},f2:\{n:"([^"]+)"'
    for res in results:
        winner = res["winner"]; loser = res["loser"]
        method = res["method"]; rnd = res["round"]
        for m in re.finditer(pattern, js):
            f1n, f2n = m.group(1), m.group(2)
            f1w = names_match(f1n, winner) and (not loser or names_match(f2n, loser))
            f2w = names_match(f2n, winner) and (not loser or names_match(f1n, loser))
            if not f1w and not f2w: continue
            winner_name = f1n if f1w else f2n
            pos = m.start()
            fs = js.rfind("{lbl:", 0, pos)
            if fs < 0: continue
            snip = js[fs:fs+300]
            if 'state:"post"' in snip:
                print("  Already set: %s" % winner_name, file=sys.stderr)
                count += 1; break
            depth = 0; fe = fs
            for i in range(fs, min(fs+2000, len(js))):
                if js[i] == "{": depth += 1
                elif js[i] == "}": depth -= 1
                if depth == 0: fe = i+1; break
            fstr = js[fs:fe]
            fstr = re.sub(r'winner:"[^"]*"', 'winner:"' + winner_name + '"', fstr)
            fstr = re.sub(r'method:"[^"]*"', 'method:"' + method + '"', fstr)
            fstr = re.sub(r"round:(?:null|\d+)", "round:" + (str(rnd) if rnd else "null"), fstr)
            fstr = re.sub(r'state:"[^"]*"', 'state:"post"', fstr)
            js = js[:fs] + fstr + js[fe:]
            print("  Injected: %s def %s by %s R%s" % (winner_name, f2n if f1w else f1n, method, rnd), file=sys.stderr)
            count += 1; break
    return js, count

# -- JS serialization --------------------------------------------------------
def fight_js(f, comma=""):
    f1 = f["f1"]; f2 = f["f2"]
    odds = f.get("odds")
    odds_s = "{f1:%d,f2:%d}" % (odds["f1"], odds["f2"]) if odds else "null"
    f1s = json.dumps(f1.get("stats")) if f1.get("stats") else "null"
    f2s = json.dumps(f2.get("stats")) if f2.get("stats") else "null"
    rnd = str(f.get("round") or "null")
    return ("      {lbl:%s,wc:%s,title:%s,odds:%s,winner:%s,method:%s,"
            "round:%s,state:%s,f1:{n:%s,r:%s,rk:%s,s:%s},"
            "f2:{n:%s,r:%s,rk:%s,s:%s}}%s") % (
        json.dumps(f.get("label","")), json.dumps(f.get("wc","TBD")),
        "true" if f.get("title") else "false", odds_s,
        json.dumps(f.get("winner","")), json.dumps(f.get("method","")),
        rnd, json.dumps(f.get("state","pre")),
        json.dumps(f1.get("name","TBD")), json.dumps(f1.get("record","")),
        json.dumps(f1.get("ranking","")), f1s,
        json.dumps(f2.get("name","TBD")), json.dumps(f2.get("record","")),
        json.dumps(f2.get("ranking","")), f2s, comma)

def events_js(evs):
    out = ["var EVENTS=["]
    for ei, ev in enumerate(evs):
        c = "," if ei < len(evs)-1 else ""
        out += ["  {",
            "    name:" + json.dumps(ev["name"]) + ",",
            "    date:" + json.dumps(ev["date"]) + ",",
            "    venue:" + json.dumps(ev.get("venue","")) + ",",
            "    loc:" + json.dumps(ev.get("location","")) + ",",
            "    tv:" + json.dumps(ev.get("broadcast","Paramount+")) + ",",
            "    time:" + json.dumps(ev.get("time","TBD")) + ",",
            "    fights:["]
        fs = ev.get("fights",[])
        for fi, f in enumerate(fs):
            out.append(fight_js(f, "," if fi<len(fs)-1 else ""))
        out += ["    ]", "  }" + c]
    out.append("];")
    return "\n".join(out)

# -- Main ----------------------------------------------------------------------
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
    print("Current events:", list(zip(ex_dates[:5], ex_names[:5])), file=sys.stderr)

    # -- Step 1: Inject Wikipedia results for recent events ------------------
    total_injected = 0
    for ev_name, ev_date in zip(ex_names, ex_dates):
        try: ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except: continue
        if ed < now - timedelta(days=2) or ed > now + timedelta(hours=6): continue
        print("Checking wiki results:", ev_name, file=sys.stderr)
        results = fetch_wiki_results(ev_name)
        if results:
            js, n = inject_results(js, results)
            total_injected += n
        time.sleep(1)

    if total_injected > 0:
        label = fmt_update(now)
        html_new = html[:js_start] + js + html[js_end:]
        html_new = re.sub('Updated <span id="updateDate">[^<]*</span>',
                         'Updated <span id="updateDate">' + label + '</span>', html_new)
        index.write_text(html_new, encoding="utf-8")
        print("Results injected: %d" % total_injected, file=sys.stderr)
        sys.exit(0)

    # -- Step 2: Update card structure from Odds API --------------------------
    if not ODDS_API_KEY:
        print("No ODDS_API_KEY - cannot update card structure", file=sys.stderr)
        sys.exit(0)

    print("Fetching from Odds API...", file=sys.stderr)
    raw_fights = fetch_odds()
    if not raw_fights:
        print("No fights from Odds API", file=sys.stderr)
        sys.exit(0)

    new_events = build_events_from_odds(raw_fights)
    if not new_events:
        print("No events built from API response", file=sys.stderr)
        sys.exit(0)

    print("Built %d events from Odds API:" % len(new_events), file=sys.stderr)
    for ev in new_events:
        print("  %s: %s (%d fights)" % (ev["date"], ev["name"], len(ev["fights"])), file=sys.stderr)

    # Preserve existing event data (stats, records, rankings) by merging
    # with what the Odds API returns - API gives us fighters + odds
    # We keep existing fight data if fighters match, otherwise use API data
    existing_events = {}
    for ev_name, ev_date in zip(ex_names, ex_dates):
        existing_events[ev_date] = ev_name

    for ev in new_events:
        # Try to pull weight classes from existing event if available
        # For now just ensure event name is preserved if we know it
        if ev["date"] in existing_events:
            ev["name"] = existing_events[ev["date"]]
        # Also try to enrich from Wikipedia fight card
        slug = wiki_slug(ev["name"])
        wikitext = fetch_wikitext(slug)
        if wikitext:
            # Try to get weight classes from Wikipedia
            bouts = parse_mmaevent_bouts(wikitext)
            if bouts:
                # Match wiki bouts to odds fights by fighter names
                for fight in ev["fights"]:
                    for bout in bouts:
                        if (names_match(fight["f1"]["name"], bout.get("winner","")) or
                            names_match(fight["f1"]["name"], bout.get("loser","")) or
                            names_match(fight["f2"]["name"], bout.get("winner","")) or
                            names_match(fight["f2"]["name"], bout.get("loser",""))):
                            pass  # Could pull weight class here if Wikipedia had it
        time.sleep(1)

    # Sort events by date
    new_events.sort(key=lambda e: e["date"])

    # Write new EVENTS array
    new_js_events = events_js(new_events)
    html_new = re.sub(r"var EVENTS\s*=\s*\[.*?\];", lambda m: new_js_events, html, flags=re.DOTALL)
    label = fmt_update(now)
    lbl_repl = 'Updated <span id="updateDate">' + label + '</span>'
    html_new = re.sub('Updated <span id="updateDate">[^<]*</span>', lambda m: lbl_repl, html_new)
    if len(html_new) < 30000:
        print("Output too small - aborting", file=sys.stderr); sys.exit(0)

    index.write_text(html_new, encoding="utf-8")
    print("Done: %d events, %d total fights" % (
        len(new_events),
        sum(len(e["fights"]) for e in new_events)
    ), file=sys.stderr)

if __name__ == "__main__":
    main()