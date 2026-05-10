#!/usr/bin/env python3
# UFC scraper - Wikipedia results injector
import json, re, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests
from bs4 import BeautifulSoup

HEADERS = {"User-Agent": "UFC-Dashboard/1.0 (github.com/AndyRBrett/ufc-dashboard)"}
WIKI = "https://en.wikipedia.org/wiki/"
TAPOLOGY_BASE = "https://www.tapology.com"
TAPOLOGY_EVENTS = "https://www.tapology.com/fightcenter"

def get(url):
    for i in range(3):
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            if r.status_code == 200:
                return r
            print("HTTP %d: %s" % (r.status_code, url[:60]), file=sys.stderr)
        except Exception as e:
            print("GET fail %d: %s" % (i+1, e), file=sys.stderr)
            if i < 2: time.sleep(2)
    return None

def asc(t):
    if not t: return ""
    return "".join(c for c in str(t) if ord(c) < 128).strip()

def last_name(n):
    return n.strip().split()[-1].lower() if n.strip() else ""

def names_match(a, b):
    a2 = re.sub(r"[^a-z]", "", a.lower())
    b2 = re.sub(r"[^a-z]", "", b.lower())
    return last_name(a) == last_name(b) or a2 in b2 or b2 in a2

def wiki_slug(ev_name):
    # "UFC 328: Chimaev vs. Strickland" -> "UFC_328"
    m = re.search(r"UFC (\d+)", ev_name)
    if m:
        return "UFC_" + m.group(1)
    # "UFC Fight Night: Allen vs. Costa" -> "UFC_Fight_Night:_Allen_vs._Costa"
    clean = re.sub(r"[^a-zA-Z0-9 :._-]", "", ev_name)
    return clean.replace(" ", "_")

def fetch_wiki_results(ev_name):
    slug = wiki_slug(ev_name)
    url = WIKI + slug
    print("Wikipedia:", url, file=sys.stderr)
    r = get(url)
    if not r:
        return []
    soup = BeautifulSoup(r.text, "html.parser")
    results = []
    # Wikipedia UFC pages have a wikitable with fight results
    # Columns: Weight class | Winner | Loser | Method | Round | Time | Notes
    for table in soup.find_all("table", class_=re.compile("wikitable", re.I)):
        rows = table.find_all("tr")
        if len(rows) < 3:
            continue
        # Get header to understand column layout
        headers = [asc(th.get_text(" ", strip=True)).lower()
                   for th in rows[0].find_all(["th", "td"])]
        # Must look like a fight results table
        header_text = " ".join(headers)
        if "method" not in header_text and "round" not in header_text:
            continue
        # Find column indices
        def col(name):
            for i, h in enumerate(headers):
                if name in h: return i
            return -1
        print("Headers:", headers, file=sys.stderr)
        # Parse each data row
        for row in rows[1:]:
            cells = row.find_all(["td", "th"])
            if len(cells) < 3:
                continue
            # Handle colspan - expand cells
            vals = []
            for cell in cells:
                span = int(cell.get("colspan", 1))
                text = asc(cell.get_text(" ", strip=True))
                for _ in range(span):
                    vals.append(text)
            if len(vals) < 3:
                continue
            # Extract winner, loser, method, round
            # Typical layout: [weight, winner, loser, method, round, time, notes]
            winner = ""
            loser = ""
            method = ""
            rnd = None
            # Try to get by column index first
            if len(headers) >= 4:
                wi = col("winner") if col("winner") >= 0 else 1
                li = col("loser") if col("loser") >= 0 else 2
                mi = col("method") if col("method") >= 0 else 3
                ri = col("round") if col("round") >= 0 else 4
            else:
                wi, li, mi, ri = 1, 2, 3, 4
            if wi < len(vals): winner = vals[wi]
            if li < len(vals): loser = vals[li]
            if mi < len(vals): method = vals[mi]
            if ri < len(vals):
                try: rnd = int(re.search(r"\d+", vals[ri]).group())
                except: pass
            # Skip rows with no method (bout not yet completed)
            if not method or not winner:
                continue
            # Normalize method
            m2 = method.lower()
            if "ko" in m2 or "tko" in m2: method = "KO/TKO"
            elif "submission" in m2 or "sub" in m2: method = "Submission"
            elif "unanimous" in m2: method = "Decision (Unanimous)"
            elif "split" in m2: method = "Decision (Split)"
            elif "majority" in m2: method = "Decision (Majority)"
            elif "decision" in m2: method = "Decision"
            elif "dq" in m2 or "disqual" in m2: method = "DQ"
            results.append({
                "winner": winner,
                "loser": loser,
                "method": method,
                "round": rnd,
            })
    print("Wiki results:", len(results), file=sys.stderr)
    for res in results:
        print("  %s def %s by %s R%s" % (res["winner"], res["loser"], res["method"], res["round"]), file=sys.stderr)
    return results

def inject_wiki_results(js_content, ev_name, results):
    if not results:
        return js_content, 0
    count = 0
    for res in results:
        w = res["winner"]
        l = res["loser"]
        method = res["method"]
        rnd = res["round"]
        # Find matching fight in EVENTS JS and update winner/method/round/state
        # Match by fighter last names
        # Pattern: f1:{n:"FirstName LastName",...},f2:{n:"FirstName LastName"
        pattern = r'f1:\{n:"([^"]+)"[^}]+\},f2:\{n:"([^"]+)"'
        for m in re.finditer(pattern, js_content):
            f1n = m.group(1)
            f2n = m.group(2)
            # Check if winner/loser match this fight
            f1_wins = names_match(f1n, w) and (not l or names_match(f2n, l))
            f2_wins = names_match(f2n, w) and (not l or names_match(f1n, l))
            if not f1_wins and not f2_wins:
                continue
            winner_name = f1n if f1_wins else f2n
            # Find the fight object start (walk back to find lbl:)
            pos = m.start()
            fight_start = js_content.rfind("{lbl:", 0, pos)
            if fight_start < 0:
                continue
            fight_end = js_content.find("}", pos + m.end() - m.start() + 50)
            if fight_end < 0:
                continue
            fight_end = fight_end + 1
            fight_str = js_content[fight_start:fight_end]
            # Update fields
            rnd_str = str(rnd) if rnd else "null"
            fight_str = re.sub(r'winner:"[^"]*"', 'winner:"' + winner_name + '"', fight_str)
            fight_str = re.sub(r'method:"[^"]*"', 'method:"' + method + '"', fight_str)
            fight_str = re.sub(r'round:(?:null|\d+)', 'round:' + rnd_str, fight_str)
            fight_str = re.sub(r'state:"[^"]*"', 'state:"post"', fight_str)
            js_content = js_content[:fight_start] + fight_str + js_content[fight_end:]
            print("  Injected: %s beats %s by %s" % (winner_name, f2n if f1_wins else f1n, method), file=sys.stderr)
            count += 1
            break
    return js_content, count

def asc_only(text):
    if not text: return ""
    return "".join(c for c in str(text) if ord(c) < 128).strip()

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

def scrape_tapology():
    r = get(TAPOLOGY_EVENTS)
    if not r: return []
    soup = BeautifulSoup(r.text, "html.parser")
    seen, urls = set(), []
    for a in soup.select("a[href*='/fightcenter/events/']"):
        href = a.get("href", "")
        if "/fightcenter/events/" not in href: continue
        url = TAPOLOGY_BASE + href if href.startswith("/") else href
        if url not in seen: seen.add(url); urls.append(url)
    return urls[:12]

def scrape_event(url):
    print("Scraping:", url[:70], file=sys.stderr)
    r = get(url)
    if not r: return None
    soup = BeautifulSoup(r.text, "html.parser")
    h1 = soup.select_one("h1.border-b") or soup.select_one("h1")
    name = asc_only(h1.get_text(strip=True)) if h1 else ""
    if not name or "ufc" not in name.lower(): return None
    date_str = ""
    de = soup.find(attrs={"data-date": True}) or soup.find("span", string=re.compile(r"\d{4}"))
    if de:
        raw = de.get("data-date") or de.get_text(strip=True)
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            date_str = dt.strftime("%Y-%m-%d")
        except Exception:
            for fmt in ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y"):
                try: date_str = datetime.strptime(raw.strip(), fmt).strftime("%Y-%m-%d"); break
                except: pass
    if not date_str: return None
    try:
        ed = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if ed < now - timedelta(days=2) or ed > now + timedelta(days=65): return None
    except: pass
    ve = soup.select_one(".eventVenue")
    venue = asc_only(ve.get_text(strip=True)) if ve else ""
    fights = []
    rows = soup.select(".fightCard li") or soup.select("li.event")
    for i, row in enumerate(rows):
        wce = row.select_one(".weight") or row.select_one("[class*='weight']")
        wc = norm_wc(wce.get_text(strip=True) if wce else "")
        title = "title" in row.get_text().lower()
        fts = row.select(".name") or row.select("a[href*='/fighters/']")
        f1n = asc_only(fts[0].get_text(strip=True)) if len(fts) > 0 else "TBD"
        f2n = asc_only(fts[1].get_text(strip=True)) if len(fts) > 1 else "TBD"
        recs = row.select(".record") or row.select("[class*='record']")
        f1r = parse_record(recs[0].get_text()) if len(recs) > 0 else ""
        f2r = parse_record(recs[1].get_text()) if len(recs) > 1 else ""
        rnks = row.select(".rank") or row.select("[class*='rank']")
        f1k = asc_only(rnks[0].get_text(strip=True)) if len(rnks) > 0 else ""
        f2k = asc_only(rnks[1].get_text(strip=True)) if len(rnks) > 1 else ""
        if f1n == "TBD" and f2n == "TBD": continue
        if i == 0: lbl = "Main Event"
        elif i == 1: lbl = "Co-Main"
        elif i < 5: lbl = "Main Card"
        else: lbl = "Prelim"
        fights.append({
            "label": lbl, "wc": wc, "title": title,
            "winner": "", "method": "", "round": None, "state": "pre",
            "f1": {"name": f1n, "record": f1r, "ranking": f1k},
            "f2": {"name": f2n, "record": f2r, "ranking": f2k}
        })
    if len(fights) < 2: return None
    return {"name": name, "date": date_str, "venue": venue,
            "location": "", "broadcast": "Paramount+", "time": "TBD",
            "fights": fights}

def fmt(dt):
    h = dt.hour % 12 or 12
    ap = "AM" if dt.hour < 12 else "PM"
    return "%d %s %d %d:%02d %s UTC" % (dt.day, dt.strftime("%b"), dt.year, h, dt.minute, ap)

def main():
    index = Path("index.html")
    if not index.exists():
        print("No index.html found", file=sys.stderr)
        sys.exit(1)

    html = index.read_text(encoding="utf-8")
    now = datetime.now(timezone.utc)

    # Find all events currently in index.html
    ex_names = re.findall(r'name:"([^"]+)"', html)
    ex_dates = re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', html)
    print("Existing events:", list(zip(ex_dates, ex_names)), file=sys.stderr)

    # Step 1: Fetch Wikipedia results for each existing event
    # Focus on events within the last 2 days (could still be live or just finished)
    results_injected = 0
    js_start = html.find("<script>") + 8
    js_end = html.rfind("</script>")
    js_content = html[js_start:js_end]

    for ev_name, ev_date in zip(ex_names, ex_dates):
        try:
            ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except Exception:
            continue
        # Only fetch results for events in last 2 days or today
        if ed < now - timedelta(days=2) or ed > now + timedelta(hours=6):
            continue
        print("Fetching wiki results for:", ev_name, file=sys.stderr)
        wiki_results = fetch_wiki_results(ev_name)
        if wiki_results:
            js_content, n = inject_wiki_results(js_content, ev_name, wiki_results)
            results_injected += n
        time.sleep(1)

    if results_injected > 0:
        print("Injected", results_injected, "results from Wikipedia", file=sys.stderr)
        # Update timestamp
        label = fmt(now)
        html_new = html[:js_start] + js_content + html[js_end:]
        html_new = re.sub('Updated <span id="updateDate">[^<]*</span>',
                         'Updated <span id="updateDate">' + label + '</span>',
                         html_new)
        index.write_text(html_new, encoding="utf-8")
        print("index.html updated with results", file=sys.stderr)
        sys.exit(0)
    else:
        print("No new results from Wikipedia - checking Tapology for card updates", file=sys.stderr)

    # Step 2: Only on non-fight days, update card structure from Tapology
    # Check if any recent event exists - if so, skip Tapology to avoid overwriting
    has_recent = any(
        datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc) >= now - timedelta(days=2)
        for d in ex_dates
    )
    if has_recent:
        print("Recent event in file - skipping Tapology scrape to preserve data", file=sys.stderr)
        sys.exit(0)

    print("Scraping Tapology for card updates...", file=sys.stderr)
    urls = scrape_tapology()
    events = []
    for url in urls:
        ev = scrape_event(url)
        if ev:
            print("OK:", ev["name"], file=sys.stderr)
            events.append(ev)
        time.sleep(1)
    events.sort(key=lambda e: e["date"])
    if not events:
        print("No events from Tapology - keeping existing", file=sys.stderr)
        sys.exit(0)

    # Safety: abort if recent event would be lost
    scraped_dates = set(e["date"] for e in events)
    for d in ex_dates:
        try:
            ed = datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            if ed >= now - timedelta(days=2) and d not in scraped_dates:
                print("Recent event missing from Tapology - aborting", file=sys.stderr)
                sys.exit(0)
        except: pass

    # Rebuild EVENTS js and update file
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
            json.dumps(f["label"]), json.dumps(f["wc"]),
            "true" if f["title"] else "false", odds_s,
            json.dumps(f.get("winner", "")), json.dumps(f.get("method", "")),
            rnd, json.dumps(f.get("state", "pre")),
            json.dumps(f1["name"]), json.dumps(f1.get("record", "")),
            json.dumps(f1.get("ranking", "")), f1s,
            json.dumps(f2["name"]), json.dumps(f2.get("record", "")),
            json.dumps(f2.get("ranking", "")), f2s, comma)

    def events_js(evs):
        out = ["var EVENTS=["]
        for ei, ev in enumerate(evs):
            c = "," if ei < len(evs)-1 else ""
            out.append("  {")
            out.append("    name:" + json.dumps(ev["name"]) + ",")
            out.append("    date:" + json.dumps(ev["date"]) + ",")
            out.append("    venue:" + json.dumps(ev.get("venue", "")) + ",")
            out.append("    loc:" + json.dumps(ev.get("location", "")) + ",")
            out.append("    tv:" + json.dumps(ev.get("broadcast", "Paramount+")) + ",")
            out.append("    time:" + json.dumps(ev.get("time", "TBD")) + ",")
            out.append("    fights:[")
            fs = ev.get("fights", [])
            for fi, f in enumerate(fs):
                out.append(fight_js(f, "," if fi < len(fs)-1 else ""))
            out.append("    ]")
            out.append("  }" + c)
        out.append("];") 
        return "\n".join(out)

    new_js = events_js(events)
    html_new = re.sub(r"var EVENTS\s*=\s*\[.*?\];", new_js, html, flags=re.DOTALL)
    label = fmt(now)
    html_new = re.sub('Updated <span id="updateDate">[^<]*</span>',
                     'Updated <span id="updateDate">' + label + '</span>', html_new)
    if len(html_new) < 30000:
        print("Output too small - aborting", file=sys.stderr)
        sys.exit(0)
    index.write_text(html_new, encoding="utf-8")
    print("Updated card structure:", len(events), "events", file=sys.stderr)

if __name__ == "__main__":
    main()