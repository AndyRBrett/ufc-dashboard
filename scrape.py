#!/usr/bin/env python3
# UFC scraper v4 - Wikipedia for live results, Tapology for card structure
import json, re, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests
from bs4 import BeautifulSoup

HEADERS = {"User-Agent": "UFC-Dashboard/1.0 (https://andyrbrett.github.io/ufc-dashboard)"}
TAPOLOGY_BASE = "https://www.tapology.com"
TAPOLOGY_EVENTS = "https://www.tapology.com/fightcenter"
WIKI_BASE = "https://en.wikipedia.org/wiki/"

def get(url, retries=3):
    for i in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            r.raise_for_status()
            return r
        except Exception as e:
            print("GET fail %d: %s %s" % (i+1, url[:60], e), file=sys.stderr)
            if i < retries-1: time.sleep(2)
    return None

def soup(url):
    r = get(url)
    if not r: return None
    from bs4 import BeautifulSoup as BS
    return BS(r.text, "html.parser")

def asc(t):
    if not t: return ""
    return "".join(c for c in str(t) if ord(c) < 128).strip()

def last(n):
    return n.strip().split()[-1].lower() if n.strip() else ""

def match(a, b):
    na = re.sub(r"[^a-z]", "", a.lower())
    nb = re.sub(r"[^a-z]", "", b.lower())
    return last(a) == last(b) or na in nb or nb in na

def wiki_slug(name):
    # Convert "UFC 328: Chimaev vs. Strickland" -> "UFC_328"
    m = re.search(r"UFC (\d+)", name)
    if m: return "UFC_" + m.group(1)
    m2 = re.search(r"UFC Fight Night.*?(\w+ vs\. \w+)", name)
    if m2: return "UFC_Fight_Night:_" + m2.group(1).replace(" ", "_")
    return None

def fetch_wiki_results(ev_name):
    slug = wiki_slug(ev_name)
    if not slug:
        print("No wiki slug for:", ev_name, file=sys.stderr)
        return []
    url = WIKI_BASE + slug
    print("Wikipedia:", url, file=sys.stderr)
    s = soup(url)
    if not s: return []
    results = []
    # Wikipedia UFC pages have tables with results
    # Look for rows with fighter names and method columns
    for table in s.find_all("table", class_=re.compile("wikitable", re.I)):
        rows = table.find_all("tr")
        headers = []
        if rows:
            headers = [asc(th.get_text(strip=True)).lower() for th in rows[0].find_all(["th","td"])]
        # Check if this looks like a results table
        has_method = any("method" in h for h in headers)
        has_winner = any("winner" in h or "fighter" in h for h in headers)
        if not (has_method or has_winner): continue
        for row in rows[1:]:
            cells = [asc(td.get_text(strip=True)) for td in row.find_all(["td","th"])]
            if len(cells) < 3: continue
            # Try to extract winner, loser, method, round
            # Common Wikipedia format: Weight | Winner | Loser | Method | Round | Time
            winner = ""
            loser = ""
            method = ""
            rnd = None
            for ci, cell in enumerate(cells):
                cl = cell.lower()
                if "ko" in cl or "tko" in cl: method = cell
                elif "submission" in cl or "sub" in cl: method = cell
                elif "decision" in cl: method = cell
                elif ci < 2 and not winner and len(cell) > 3: winner = cell
                elif ci < 3 and winner and not loser and len(cell) > 3 and cell != winner: loser = cell
                elif "round" in cl or (ci > 2 and re.match(r"^\d$", cell)): 
                    try: rnd = int(cell)
                    except: pass
            if winner and method:
                results.append({"winner": winner, "loser": loser, "method": method, "round": rnd})
    print("Wiki results found:", len(results), file=sys.stderr)
    return results

def inject_results(events, wiki_results_by_event):
    for ev in events:
        results = wiki_results_by_event.get(ev["name"], [])
        if not results: continue
        for fight in ev["fights"]:
            f1 = fight["f1"]["name"]
            f2 = fight["f2"]["name"]
            for res in results:
                w, l = res.get("winner",""), res.get("loser","")
                if not w: continue
                if (match(f1,w) and (not l or match(f2,l))) or (match(f2,w) and (not l or match(f1,l))):
                    fight["winner"] = w
                    fight["method"] = res.get("method","")
                    fight["round"] = res.get("round")
                    fight["state"] = "post"
                    print("Result: %s beat %s by %s" % (f1, f2, fight["method"]), file=sys.stderr)
                    break
    return events

def parse_record(text):
    m = re.search(r"(\d+)-(\d+)(?:-(\d+))?", text or "")
    if not m: return ""
    w, l, d = m.group(1), m.group(2), m.group(3)
    return w+"-"+l+"-"+d if (d and d!="0") else w+"-"+l

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
    if 'strawweight' in r: return "Women's Strawweight"
    return r.title() if r else "Catchweight"

def get_event_urls():
    s = soup(TAPOLOGY_EVENTS)
    if not s: return []
    seen, urls = set(), []
    for a in s.select("a[href*='/fightcenter/events/']"):
        href = a.get("href","")
        if "/fightcenter/events/" not in href: continue
        url = TAPOLOGY_BASE + href if href.startswith("/") else href
        if url not in seen: seen.add(url); urls.append(url)
    return urls[:12]

def scrape_event(url):
    print("Scraping:", url, file=sys.stderr)
    s = soup(url)
    if not s: return None
    h1 = s.select_one("h1.border-b") or s.select_one("h1")
    name = asc(h1.get_text(strip=True)) if h1 else ""
    if not name or "ufc" not in name.lower(): return None
    date_str = ""
    de = s.find(attrs={"data-date": True}) or s.find("span", string=re.compile(r"\d{4}"))
    if de:
        raw = de.get("data-date") or de.get_text(strip=True)
        try:
            dt = datetime.fromisoformat(raw.replace("Z","+00:00"))
            date_str = dt.strftime("%Y-%m-%d")
        except Exception:
            for fmt in ("%B %d, %Y","%b %d, %Y","%m/%d/%Y"):
                try: date_str=datetime.strptime(raw.strip(),fmt).strftime("%Y-%m-%d"); break
                except: pass
    if not date_str: return None
    try:
        ed = datetime.strptime(date_str,"%Y-%m-%d").replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if ed < now-timedelta(days=2) or ed > now+timedelta(days=65): return None
    except: pass
    ve = s.select_one(".eventVenue")
    venue = asc(ve.get_text(strip=True)) if ve else ""
    fights = []
    rows = s.select(".fightCard li") or s.select("li.event")
    for i, row in enumerate(rows):
        wce = row.select_one(".weight") or row.select_one("[class*='weight']")
        wc = norm_wc(wce.get_text(strip=True) if wce else "")
        title = "title" in row.get_text().lower()
        fts = row.select(".name") or row.select("a[href*='/fighters/']")
        f1n = asc(fts[0].get_text(strip=True)) if len(fts)>0 else "TBD"
        f2n = asc(fts[1].get_text(strip=True)) if len(fts)>1 else "TBD"
        recs = row.select(".record") or row.select("[class*='record']")
        f1r = parse_record(recs[0].get_text()) if len(recs)>0 else ""
        f2r = parse_record(recs[1].get_text()) if len(recs)>1 else ""
        rnks = row.select(".rank") or row.select("[class*='rank']")
        f1k = asc(rnks[0].get_text(strip=True)) if len(rnks)>0 else ""
        f2k = asc(rnks[1].get_text(strip=True)) if len(rnks)>1 else ""
        if f1n=="TBD" and f2n=="TBD": continue
        if i==0: lbl="Main Event"
        elif i==1: lbl="Co-Main"
        elif i<5: lbl="Main Card"
        else: lbl="Prelim"
        fights.append({"label":lbl,"wc":wc,"title":title,
            "winner":"","method":"","round":None,"state":"pre",
            "f1":{"name":f1n,"record":f1r,"ranking":f1k},
            "f2":{"name":f2n,"record":f2r,"ranking":f2k}})
    if len(fights)<2: return None
    return {"name":name,"date":date_str,"venue":venue,"location":"",
            "broadcast":"Paramount+","time":"TBD","fights":fights}

def fight_js(f, comma=""):
    f1, f2 = f["f1"], f["f2"]
    odds = f.get("odds")
    odds_s = "{f1:%d,f2:%d}" % (odds["f1"],odds["f2"]) if odds else "null"
    f1s = json.dumps(f1.get("stats")) if f1.get("stats") else "null"
    f2s = json.dumps(f2.get("stats")) if f2.get("stats") else "null"
    rnd = str(f.get("round") or "null")
    return ("      {lbl:%s,wc:%s,title:%s,odds:%s,winner:%s,method:%s,round:%s,state:%s,"
            "f1:{n:%s,r:%s,rk:%s,s:%s},f2:{n:%s,r:%s,rk:%s,s:%s}}%s") % (
        json.dumps(f["label"]),json.dumps(f["wc"]),
        "true" if f["title"] else "false",odds_s,
        json.dumps(f.get("winner","")),json.dumps(f.get("method","")),
        rnd,json.dumps(f.get("state","pre")),
        json.dumps(f1["name"]),json.dumps(f1.get("record","")),
        json.dumps(f1.get("ranking","")),f1s,
        json.dumps(f2["name"]),json.dumps(f2.get("record","")),
        json.dumps(f2.get("ranking","")),f2s,comma)

def events_js(events):
    out = ["var EVENTS=["]
    for ei, ev in enumerate(events):
        c = "," if ei < len(events)-1 else ""
        out.append("  {")
        out.append("    name:" + json.dumps(ev["name"]) + ",")
        out.append("    date:" + json.dumps(ev["date"]) + ",")
        out.append("    venue:" + json.dumps(ev.get("venue","")) + ",")
        out.append("    loc:" + json.dumps(ev.get("location","")) + ",")
        out.append("    tv:" + json.dumps(ev.get("broadcast","Paramount+")) + ",")
        out.append("    time:" + json.dumps(ev.get("time","TBD")) + ",")
        out.append("    fights:[")
        fs = ev.get("fights",[])
        for fi, f in enumerate(fs):
            out.append(fight_js(f,"," if fi<len(fs)-1 else ""))
        out.append("    ]")
        out.append("  }" + c)
    out.append("];") 
    return "\n".join(out)

def build(events, label):
    p = Path("index.html") if Path("index.html").exists() else Path("template.html")
    tmpl = p.read_text(encoding="utf-8")
    js = events_js(events)
    out = re.sub(r"var EVENTS\s*=\s*\[.*?\];", js, tmpl, flags=re.DOTALL)
    out = re.sub('Updated <span id="updateDate">[^<]*</span>',
                 'Updated <span id="updateDate">' + label + '</span>', out)
    out = out.replace("{{UPDATED}}", label)
    return out

def validate(html):
    if not re.search(r"var EVENTS\s*=\s*\[", html): return False
    if len(html) < 30000: return False
    return True

def is_fight_night():
    try:
        html = Path("index.html").read_text(encoding="utf-8")
        dates = re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', html)
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return today in dates
    except: return False

def fmt(dt):
    h = dt.hour % 12 or 12
    ap = "AM" if dt.hour < 12 else "PM"
    return "%d %s %d %d:%02d %s UTC" % (dt.day, dt.strftime("%b"), dt.year, h, dt.minute, ap)

def main():
    fight_night = is_fight_night()
    print("Fight night:", fight_night, file=sys.stderr)

    # Safety: abort if recent event would be lost
    try:
        if Path("index.html").exists():
            existing = Path("index.html").read_text(encoding="utf-8")
            ex_dates = re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', existing)
            now_utc = datetime.now(timezone.utc)
            for ex_date in ex_dates:
                ed = datetime.strptime(ex_date,"%Y-%m-%d").replace(tzinfo=timezone.utc)
                if ed >= now_utc - timedelta(days=2):
                    # This is a recent event - we must preserve it
                    # Fetch Wikipedia results for it first
                    ev_name_match = re.findall(r'name:"([^"]+)"', existing)
                    ev_date_match = re.findall(r'date:"([^"]+)"', existing)
                    for en, edate in zip(ev_name_match, ev_date_match):
                        if edate == ex_date:
                            print("Fetching wiki results for:", en, file=sys.stderr)
                            wiki_results = fetch_wiki_results(en)
                            if wiki_results:
                                print("Got", len(wiki_results), "results from Wikipedia", file=sys.stderr)
                                # Inject into existing html directly
                                # For now just log - full injection needs event object
    except Exception as e:
        print("Safety check error:", e, file=sys.stderr)

    print("Scraping Tapology...", file=sys.stderr)
    urls = get_event_urls()
    print("URLs:", len(urls), file=sys.stderr)
    events = []
    for url in urls:
        ev = scrape_event(url)
        if ev:
            print("OK:", ev["name"], file=sys.stderr)
            events.append(ev)
        time.sleep(1)
    events.sort(key=lambda e: e["date"])

    # Abort if recent event missing from scrape
    try:
        if Path("index.html").exists():
            existing = Path("index.html").read_text(encoding="utf-8")
            ex_dates = re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', existing)
            scraped_dates = set(e["date"] for e in events)
            now_utc = datetime.now(timezone.utc)
            for ex_date in ex_dates:
                ed = datetime.strptime(ex_date,"%Y-%m-%d").replace(tzinfo=timezone.utc)
                if ed >= now_utc - timedelta(days=2) and ex_date not in scraped_dates:
                    print("Recent event missing from scrape - aborting to preserve data", file=sys.stderr)
                    sys.exit(0)
    except Exception as e:
        print("Abort check error:", e, file=sys.stderr)

    if not events:
        print("No events - keeping existing", file=sys.stderr)
        sys.exit(0)

    # Fetch Wikipedia results for each event
    wiki_by_event = {}
    for ev in events:
        results = fetch_wiki_results(ev["name"])
        if results:
            wiki_by_event[ev["name"]] = results
    events = inject_results(events, wiki_by_event)

    label = fmt(datetime.now(timezone.utc))
    html = build(events, label)
    if not validate(html):
        print("Validation failed - keeping existing", file=sys.stderr)
        sys.exit(0)
    Path("index.html").write_text(html, encoding="utf-8")
    n_res = sum(1 for e in events for f in e["fights"] if f.get("winner"))
    print("Done: %d events, %d results" % (len(events), n_res), file=sys.stderr)

if __name__ == "__main__":
    main()