#!/usr/bin/env python3
# UFC scraper - Odds API for card structure/odds, Wikipedia for results
import json, os, re, sys, time
from collections import defaultdict
from datetime import datetime, timedelta, timezone, date as _date
from pathlib import Path
import requests
from bs4 import BeautifulSoup

ODDS_API_KEY = os.environ.get("ODDS_API_KEY", "")
ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds"
WIKI_API     = "https://en.wikipedia.org/w/api.php"
WIKI_HDR     = {"User-Agent": "UFC-Dashboard/1.0 (https://github.com/AndyRBrett/ufc-dashboard; andyrbrett@gmail.com)"}

MAJOR_BOOKS  = {"fanduel", "draftkings", "betrivers", "bovada", "betus"}
EXCLUDE      = {
    "ronda rousey", "gina carano", "francis ngannou", "junior dos santos",
    "nate diaz", "mike perry", "jason jackson", "jeff creighton",
    "salahdine parnasse", "kenneth cross", "robelis despaigne", "philipe lins",
}

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------
def asc(t):
    if not t: return ""
    return "".join(c for c in str(t) if ord(c) < 128).strip()

def last(name):
    return asc(name).strip().split()[-1].lower() if name.strip() else ""

def names_match(a, b):
    a2 = re.sub(r"[^a-z]", "", a.lower())
    b2 = re.sub(r"[^a-z]", "", b.lower())
    return last(a) == last(b) or (len(a2) > 3 and a2 in b2) or (len(b2) > 3 and b2 in a2)

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

def clean_fighter(name):
    return "".join(c for c in (name or "") if ord(c) < 128).strip()

# ---------------------------------------------------------------------------
# Odds API
# ---------------------------------------------------------------------------
def fetch_odds():
    if not ODDS_API_KEY:
        print("No ODDS_API_KEY", file=sys.stderr)
        return []
    try:
        r = requests.get(ODDS_API_URL, params={
            "apiKey": ODDS_API_KEY,
            "regions": "us",
            "markets": "h2h",
            "oddsFormat": "american",
        }, timeout=15)
        print("Odds API:", r.status_code,
              "remaining:", r.headers.get("x-requests-remaining", "?"), file=sys.stderr)
        if r.status_code == 200:
            return r.json()
        print("Odds API error:", r.text[:200], file=sys.stderr)
    except Exception as e:
        print("Odds API exception:", e, file=sys.stderr)
    return []

def is_ufc(fight):
    h = fight.get("home_team", "").lower()
    a = fight.get("away_team", "").lower()
    for name in EXCLUDE:
        if name in h or name in a:
            return False
    major = sum(1 for bm in fight.get("bookmakers", []) if bm["key"] in MAJOR_BOOKS)
    return major >= 2

def best_odds(fight, f1, f2):
    preferred = ["fanduel","draftkings","betrivers","bovada","betonlineag","betus"]
    books = sorted(fight.get("bookmakers",[]),
                   key=lambda b: preferred.index(b["key"]) if b["key"] in preferred else 99)
    p1, p2 = [], []
    for bm in books[:3]:
        for mkt in bm.get("markets",[]):
            if mkt["key"] != "h2h": continue
            for o in mkt["outcomes"]:
                nl = o["name"].lower()
                if f1.lower() in nl or nl in f1.lower(): p1.append(o["price"])
                elif f2.lower() in nl or nl in f2.lower(): p2.append(o["price"])
    if not p1 or not p2: return None
    return {"f1": round(sum(p1)/len(p1)), "f2": round(sum(p2)/len(p2))}

def build_events(raw_fights, existing_names):
    """
    Group Odds API fights into UFC events.
    existing_names: dict of {et_date: event_name} from current index.html
    """
    # Group by ET date
    by_date = defaultdict(list)
    for f in raw_fights:
        if not is_ufc(f): continue
        ct = datetime.fromisoformat(f["commence_time"].replace("Z", "+00:00"))
        et = ct - timedelta(hours=4)
        by_date[et.strftime("%Y-%m-%d")].append(f)

    now = datetime.now(timezone.utc)
    events = []

    for et_date in sorted(by_date.keys()):
        day = by_date[et_date]
        try:
            ed = datetime.strptime(et_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except:
            continue

        # Date window: not more than 2 days past, not more than 65 days future
        if ed < now - timedelta(days=2) or ed > now + timedelta(days=65):
            continue

        # Skip if all fights already happened
        future = [f for f in day if
                  datetime.fromisoformat(f["commence_time"].replace("Z","+00:00")) > now]
        if not future and ed <= now:
            print("Skipping past event:", et_date, file=sys.stderr)
            continue

        # Require at least 4 fights to be a real UFC event
        if len(day) < 4:
            continue

        # Deduplicate by fighter pair
        seen, unique = set(), []
        for f in day:
            pair = tuple(sorted([f["home_team"].lower(), f["away_team"].lower()]))
            if pair not in seen:
                seen.add(pair)
                unique.append(f)

        # Identify main event: latest commence_time, then most bookmakers
        ordered = sorted(unique,
                         key=lambda f: (f["commence_time"], len(f.get("bookmakers", []))),
                         reverse=True)
        main = ordered[0]

        # Override: if an existing event name matches a fight's fighters, that's the main event
        # e.g. "Allen vs. Costa" -> find fight with Allen and Costa
        for cand in ordered:
            h_last = clean_fighter(cand["home_team"]).split()[-1].lower() if cand["home_team"].strip() else ""
            a_last = clean_fighter(cand["away_team"]).split()[-1].lower() if cand["away_team"].strip() else ""
            for en in existing_names.values():
                en_lower = en.lower()
                if h_last and a_last and h_last in en_lower and a_last in en_lower:
                    main = cand
                    break
            else:
                continue
            break

        f1_main = clean_fighter(main["home_team"])
        f2_main = clean_fighter(main["away_team"])

        # Derive event name: use existing name if available, else build from fighters
        ev_name = existing_names.get(et_date, "")
        if not ev_name:
            # Check day before and after (prelim/main card split across midnight)
            d = _date.fromisoformat(et_date)
            for delta in [1, -1]:
                adj = (d + timedelta(days=delta)).isoformat()
                if adj in existing_names:
                    ev_name = existing_names[adj]
                    break
        if not ev_name:
            h_last = f1_main.strip().split()[-1]
            a_last = f2_main.strip().split()[-1]
            ev_name = "UFC Fight Night: %s vs. %s" % (h_last, a_last)

        # Determine card times from commence_time windows
        times = sorted(set(f["commence_time"] for f in unique))
        latest_ct = datetime.fromisoformat(times[-1].replace("Z", "+00:00"))
        latest_et = latest_ct - timedelta(hours=4)
        main_time = "%02d:%02d" % (latest_et.hour, latest_et.minute)
        prelim_time = None
        if len(times) > 1:
            early_ct = datetime.fromisoformat(times[0].replace("Z", "+00:00"))
            early_et = early_ct - timedelta(hours=4)
            prelim_time = "%02d:%02d" % (early_et.hour, early_et.minute)

        # Build fight list with card labels
        latest_time = times[-1]
        card = []
        idx = 0
        for f in ordered:
            f1 = clean_fighter(f["home_team"])
            f2 = clean_fighter(f["away_team"])
            if not f1 or not f2: continue
            odds = best_odds(f, f1, f2)
            is_mc = f["commence_time"] == latest_time
            if idx == 0:   lbl = "Main Event"
            elif idx == 1 and is_mc: lbl = "Co-Main"
            elif is_mc and idx < 5:  lbl = "Main Card"
            else:          lbl = "Prelim"
            card.append({
                "label": lbl, "wc": "TBD", "title": False,
                "odds": odds, "winner": "", "method": "",
                "round": None, "state": "pre",
                "f1": {"name": f1, "record": "", "ranking": ""},
                "f2": {"name": f2, "record": "", "ranking": ""},
            })
            idx += 1

        if not card: continue

        ev = {
            "name": ev_name, "date": et_date,
            "venue": "", "location": "",
            "broadcast": "Paramount+", "time": main_time,
            "fights": card,
        }
        if prelim_time:
            ev["prelimTime"] = prelim_time
        events.append(ev)
        print("  %s: %s (%d fights)" % (et_date, ev_name, len(card)), file=sys.stderr)

    return events

# ---------------------------------------------------------------------------
# Wikipedia results
# ---------------------------------------------------------------------------
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
            r = requests.get(url, headers=WIKI_HDR, params=params, timeout=15)
            print("  Wiki %s: %d" % (method, r.status_code), file=sys.stderr)
            if r.status_code == 200:
                wt = r.json().get("parse",{}).get("wikitext",{}).get("*","") if method=="API" else r.text
                if wt and len(wt) > 500:
                    print("  Got %d chars" % len(wt), file=sys.stderr)
                    return wt
        except Exception as e:
            print("  Wiki %s error: %s" % (method, e), file=sys.stderr)
        time.sleep(1)
    return ""

def parse_mmaevent(wikitext):
    results = []
    for block in re.finditer(r"\{\{MMAevent bout\s*\n(.*?)\}\}", wikitext, re.DOTALL | re.IGNORECASE):
        lines = [l.strip().lstrip("|").strip() for l in block.group(1).split("\n") if l.strip().lstrip("|").strip()]
        if len(lines) < 5: continue
        def_idx = next((i for i,l in enumerate(lines) if l.lower().strip() in ("def.","def","d.")), -1)
        if def_idx < 1: continue
        winner = re.sub(r"\s*\(c\)\s*", "", clean_wiki(lines[def_idx-1])).strip()
        loser  = re.sub(r"\s*\(c\)\s*", "", clean_wiki(lines[def_idx+1])).strip() if def_idx+1 < len(lines) else ""
        method = lines[def_idx+2] if def_idx+2 < len(lines) else ""
        rnd_s  = lines[def_idx+3] if def_idx+3 < len(lines) else ""
        if not winner or not method: continue
        try: rnd = int(rnd_s.strip())
        except: rnd = None
        results.append({"winner":winner,"loser":loser,"method":norm_method(method),"round":rnd})
    return results

def parse_wikitable(wikitext):
    results = []
    in_table = False
    row = []

    def flush(row):
        row = [clean_wiki(c) for c in row if clean_wiki(c)]
        if len(row) < 3: return None
        skip = ["weight class","winner","method","round","main card","preliminary","early prelim"]
        if any(h in " ".join(row).lower() for h in skip): return None
        winner = loser = method = ""
        rnd = None
        di = next((i for i,c in enumerate(row) if c.strip().lower() in ("def.","def","d.")), -1)
        if di > 0:
            winner = re.sub(r"\s*\(c\)\s*","",row[di-1]).strip()
            loser  = re.sub(r"\s*\(c\)\s*","",row[di+1]).strip() if di+1<len(row) else ""
            rest   = row[di+2:]
        else:
            if len(row) < 4: return None
            winner = row[1]; loser = row[2]; rest = row[3:]
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

    for line in wikitext.split("\n"):
        s = line.strip()
        if "{|" in s and "wikitable" in s.lower(): in_table=True; row=[]; continue
        if s.startswith("|}"):
            if row:
                res = flush(row)
                if res: results.append(res)
            in_table=False; row=[]; continue
        if not in_table: continue
        if s.startswith("|-"):
            if row:
                res = flush(row)
                if res: results.append(res)
            row=[]; continue
        if s.startswith("!"): row=[]; continue
        if s.startswith("|"):
            content = s.lstrip("|")
            if "||" in content:
                row.extend([clean_wiki(p.strip()) for p in content.split("||")])
            else:
                row.append(clean_wiki(content))
    return results

def fetch_wiki_results(ev_name):
    slug = wiki_slug(ev_name)
    print("Wiki results for:", slug, file=sys.stderr)
    wt = fetch_wikitext(slug)
    if not wt: return []
    results = parse_mmaevent(wt) or parse_wikitable(wt)
    print("  %d results" % len(results), file=sys.stderr)
    for r in results:
        print("  %s def %s by %s R%s" % (r["winner"],r["loser"],r["method"],r["round"]), file=sys.stderr)
    return results

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
            for i in range(fs, min(fs+2000,len(js))):
                if js[i]=="{": depth+=1
                elif js[i]=="}": depth-=1
                if depth==0: fe=i+1; break
            fstr = js[fs:fe]
            fstr = re.sub(r'winner:"[^"]*"', 'winner:"'+wn+'"', fstr)
            fstr = re.sub(r'method:"[^"]*"', 'method:"'+method+'"', fstr)
            fstr = re.sub(r"round:(?:null|\d+)", "round:"+(str(rnd) if rnd else "null"), fstr)
            fstr = re.sub(r'state:"[^"]*"', 'state:"post"', fstr)
            js = js[:fs]+fstr+js[fe:]
            print("  Injected: %s def %s by %s R%s" % (wn,f2n if f1w else f1n,method,rnd), file=sys.stderr)
            count += 1; break
    return js, count

# ---------------------------------------------------------------------------
# JS serialization
# ---------------------------------------------------------------------------
def fight_js(f, comma=""):
    f1=f["f1"]; f2=f["f2"]
    odds=f.get("odds")
    odds_s="{f1:%d,f2:%d}"%(odds["f1"],odds["f2"]) if odds else "null"
    f1s=json.dumps(f1.get("stats")) if f1.get("stats") else "null"
    f2s=json.dumps(f2.get("stats")) if f2.get("stats") else "null"
    rnd=str(f.get("round") or "null")
    return ("      {lbl:%s,wc:%s,title:%s,odds:%s,winner:%s,method:%s,"
            "round:%s,state:%s,f1:{n:%s,r:%s,rk:%s,s:%s},"
            "f2:{n:%s,r:%s,rk:%s,s:%s}}%s") % (
        json.dumps(f.get("label","")),json.dumps(f.get("wc","TBD")),
        "true" if f.get("title") else "false",odds_s,
        json.dumps(f.get("winner","")),json.dumps(f.get("method","")),
        rnd,json.dumps(f.get("state","pre")),
        json.dumps(f1.get("name","TBD")),json.dumps(f1.get("record","")),
        json.dumps(f1.get("ranking","")),f1s,
        json.dumps(f2.get("name","TBD")),json.dumps(f2.get("record","")),
        json.dumps(f2.get("ranking","")),f2s,comma)

def events_js(evs):
    out=["var EVENTS=["]
    for ei,ev in enumerate(evs):
        c="," if ei<len(evs)-1 else ""
        out+=["  {",
            "    name:"+json.dumps(ev["name"])+",",
            "    date:"+json.dumps(ev["date"])+",",
            "    venue:"+json.dumps(ev.get("venue",""))+",",
            "    loc:"+json.dumps(ev.get("location",""))+",",
            "    tv:"+json.dumps(ev.get("broadcast","Paramount+"))+",",
            "    time:"+json.dumps(ev.get("time","TBD"))+",",]
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

    # Read existing event names and dates from current index.html
    ex_names = re.findall(r'name:"([^"]+)"', html)
    ex_dates = re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', html)
    existing_names = dict(zip(ex_dates, ex_names))
    print("Current events:", list(zip(ex_dates[:6], ex_names[:6])), file=sys.stderr)

    # Step 1: Wikipedia results for recent/active events
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
        html_new = re.sub(
            r'Updated <span id="updateDate">[^<]*</span>',
            lambda m: 'Updated <span id="updateDate">' + label + '</span>',
            html_new)
        index.write_text(html_new, encoding="utf-8")
        print("Results injected:", total_injected, file=sys.stderr)
        sys.exit(0)

    # Step 2: Update card structure from Odds API
    if not ODDS_API_KEY:
        print("No ODDS_API_KEY - skipping card update", file=sys.stderr)
        sys.exit(0)

    print("Fetching Odds API...", file=sys.stderr)
    raw_fights = fetch_odds()
    if not raw_fights:
        print("No fights returned", file=sys.stderr); sys.exit(0)

    print("Building events...", file=sys.stderr)
    new_events = build_events(raw_fights, existing_names)
    if not new_events:
        print("No events built", file=sys.stderr); sys.exit(0)

    print("Built %d events" % len(new_events), file=sys.stderr)

    new_js = events_js(new_events)
    html_new = re.sub(
        r"var EVENTS\s*=\s*\[.*?\];",
        lambda m: new_js,
        html, flags=re.DOTALL)
    label = fmt_update(now)
    html_new = re.sub(
        r'Updated <span id="updateDate">[^<]*</span>',
        lambda m: 'Updated <span id="updateDate">' + label + '</span>',
        html_new)

    if len(html_new) < 30000:
        print("Output too small - aborting", file=sys.stderr); sys.exit(0)

    index.write_text(html_new, encoding="utf-8")
    print("Done: %d events, %d fights" % (
        len(new_events), sum(len(e["fights"]) for e in new_events)
    ), file=sys.stderr)

if __name__ == "__main__":
    main()