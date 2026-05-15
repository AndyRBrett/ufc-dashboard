#!/usr/bin/env python3
# UFC scraper
# Card structure: Wikipedia (full cards, all fights)
# Odds enrichment: The Odds API (live moneylines)
# Results: Wikipedia MMAevent bout parser (fight night)
import json, os, re, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests
from bs4 import BeautifulSoup

ODDS_API_KEY = os.environ.get("ODDS_API_KEY", "")
ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds"
WIKI_API     = "https://en.wikipedia.org/w/api.php"
WIKI_HDR     = {"User-Agent": "UFC-Dashboard/1.0 (https://github.com/AndyRBrett/ufc-dashboard; andyrbrett@gmail.com)"}

# Upcoming UFC events - Wikipedia page slugs
# Scraper reads these to get full fight cards
UPCOMING_EVENTS = [
    ("2026-05-16", "UFC_Fight_Night:_Allen_vs._Costa",         "UFC Fight Night: Allen vs. Costa",         "Meta APEX", "Las Vegas, NV", "20:00", "17:00"),
    ("2026-06-06", "UFC_Fight_Night:_Muhammad_vs._Bonfim",     "UFC Fight Night: Muhammad vs. Bonfim",     "Meta APEX", "Las Vegas, NV", "20:00", "17:00"),
    ("2026-06-14", "UFC_Freedom_250:_Topuria_vs._Gaethje",     "UFC Freedom 250: Topuria vs. Gaethje",     "South Lawn, White House", "Washington, D.C.", "20:00", "17:00"),
    ("2026-06-20", "UFC_Fight_Night:_Kape_vs._Horiguchi",      "UFC Fight Night: Kape vs. Horiguchi",      "Meta APEX", "Las Vegas, NV", "20:00", "17:00"),
    ("2026-06-27", "UFC_Fight_Night:_Fiziev_vs._Torres",       "UFC Fight Night: Fiziev vs. Torres",       "National Gymnastics Arena", "Baku, Azerbaijan", "12:00", "09:00"),
    ("2026-07-12", "UFC_329",                                  "UFC 329",                                  "T-Mobile Arena", "Las Vegas, NV", "22:00", "18:00"),
]

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------
def asc(t):
    if not t: return ""
    return "".join(c for c in str(t) if ord(c) < 128).strip()

def clean(name):
    return "".join(c for c in (name or "") if ord(c) < 128).strip()

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
    if "strawweight" in r: return "Women's Strawweight"
    if "atomweight" in r: return "Women's Atomweight"
    return r.title() if r else "TBD"

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
    """Parse upcoming fight card - handles both || same-line and newline-per-cell formats."""
    fights = []
    in_table = False
    current_row = []

    def process_row(row):
        row = [clean_wiki(c) for c in row if clean_wiki(c).strip()]
        if len(row) < 2: return None
        skip = ["weight class","fighter","method","round","time","notes",
                "main card","preliminary","early prelim"]
        joined = " ".join(row).lower()
        if any(h in joined for h in skip): return None
        result_kw = ["decision","tko","ko/tko","submission","no contest"]
        if any(k in joined for k in result_kw): return None
        wc_raw = row[0]
        wc = norm_wc(wc_raw)
        wc_kw = ["weight","heavy","middle","welter","light","feather",
                 "bantam","fly","straw","catch","pound"]
        if not any(k in wc_raw.lower() for k in wc_kw): return None
        fighters = []
        for cell in row[1:]:
            c = cell.strip()
            if not c or len(c) < 2: continue
            if any(k in c.lower() for k in result_kw+["round","method","time"]): continue
            if re.match(r"^\d", c): continue
            fighters.append(re.sub(r"\s*\(c\)\s*", "", c).strip())
            if len(fighters) == 2: break
        if not fighters: return None
        f1 = fighters[0]
        f2 = fighters[1] if len(fighters) > 1 else "TBD"
        if len(f1) < 2: return None
        return {"f1": f1, "f2": f2, "wc": wc, "title": False}

    for line in wikitext.split("\n"):
        s = line.strip()
        if "{|" in s and "wikitable" in s.lower():
            in_table = True; current_row = []; continue
        if s.startswith("|}"):
            if current_row:
                res = process_row(current_row)
                if res: fights.append(res)
            in_table = False; current_row = []; continue
        if not in_table: continue
        if s.startswith("|-"):
            if current_row:
                res = process_row(current_row)
                if res: fights.append(res)
            current_row = []; continue
        if s.startswith("!"):
            if current_row:
                res = process_row(current_row)
                if res: fights.append(res)
            current_row = []; continue
        if s.startswith("|"):
            content = s.lstrip("|")
            if "||" in content:
                current_row.extend([clean_wiki(p.strip()) for p in content.split("||")])
            else:
                current_row.append(clean_wiki(content))

    if current_row:
        res = process_row(current_row)
        if res: fights.append(res)

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
                count += 1; break
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
        label = fmt_update(now)
        html_new = html[:js_start] + js + html[js_end:]
        html_new = re.sub(r'Updated <span id="updateDate">[^<]*</span>',
            lambda m: 'Updated <span id="updateDate">' + label + '</span>', html_new)
        index.write_text(html_new, encoding="utf-8")
        print("Results injected:", total_injected, file=sys.stderr)
        sys.exit(0)

    # -- Step 2: Fetch Odds API for moneylines --
    print("Fetching odds...", file=sys.stderr)
    odds_index = fetch_odds()

    # -- Step 3: Build events from Wikipedia + enrich with odds --
    print("Building events from Wikipedia...", file=sys.stderr)
    new_events = []

    for ev_date, slug, ev_name, venue, loc, main_time, prelim_time in UPCOMING_EVENTS:
        try: ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except: continue
        if ed < now - timedelta(days=2) or ed > now + timedelta(days=90): continue

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
            odds = get_odds(odds_index, f1, f2)
            card.append({
                "label": lbl, "wc": wf.get("wc","TBD"), "title": wf.get("title",False),
                "odds": odds, "winner": "", "method": "", "round": None, "state": "pre",
                "f1": {"name": f1, "record": "", "ranking": ""},
                "f2": {"name": f2, "record": "", "ranking": ""},
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

    new_js = events_js(new_events)
    html_new = re.sub(r"var EVENTS\s*=\s*\[.*?\];", lambda m: new_js, html, flags=re.DOTALL)
    label = fmt_update(now)
    html_new = re.sub(r'Updated <span id="updateDate">[^<]*</span>',
        lambda m: 'Updated <span id="updateDate">' + label + '</span>', html_new)

    if len(html_new) < 30000:
        print("Output too small - aborting", file=sys.stderr); sys.exit(0)

    index.write_text(html_new, encoding="utf-8")
    print("Done: %d events, %d fights" % (
        len(new_events), sum(len(e["fights"]) for e in new_events)
    ), file=sys.stderr)

if __name__ == "__main__":
    main()