#!/usr/bin/env python3
# UFC scraper - Wikipedia wikitext results injector
import json, re, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests
from bs4 import BeautifulSoup

# Wikipedia requires a proper User-Agent per bot policy
# Format: Tool/version (url; contact)
WIKI_UA = "UFC-Dashboard/1.0 (https://github.com/AndyRBrett/ufc-dashboard; UFC fight tracker)"
WIKI_HEADERS = {"User-Agent": WIKI_UA}
BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
TAPOLOGY_BASE = "https://www.tapology.com"
TAPOLOGY_EVENTS = "https://www.tapology.com/fightcenter"


def get(url, params=None, ua=None):
    headers = {"User-Agent": ua or WIKI_UA}
    for i in range(3):
        try:
            r = requests.get(url, headers=headers, params=params, timeout=15, allow_redirects=True)
            print("  GET %d %s" % (r.status_code, url[:70]), file=sys.stderr)
            if r.status_code == 200:
                return r
        except Exception as e:
            print("  GET error %d: %s" % (i+1, e), file=sys.stderr)
            if i < 2: time.sleep(2)
    return None


def asc(t):
    if not t: return ""
    return "".join(c for c in str(t) if ord(c) < 128).strip()


def clean_wiki(text):
    if not text: return ""
    text = re.sub(r"\[\[([^\]|]+\|)?([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\{\{[^}]+\}\}", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\[\d+\]", "", text)
    return asc(text).strip().strip(",").strip()


def last_name(n):
    return n.strip().split()[-1].lower() if n.strip() else ""


def names_match(a, b):
    a2 = re.sub(r"[^a-z]", "", a.lower())
    b2 = re.sub(r"[^a-z]", "", b.lower())
    return last_name(a) == last_name(b) or (len(a2) > 3 and a2 in b2) or (len(b2) > 3 and b2 in a2)


def norm_method(m):
    ml = m.lower()
    if "ko" in ml or "tko" in ml: return "KO/TKO"
    if "submission" in ml or "sub" in ml: return "Submission"
    if "unanimous" in ml: return "Decision (Unanimous)"
    if "split" in ml: return "Decision (Split)"
    if "majority" in ml: return "Decision (Majority)"
    if "decision" in ml: return "Decision"
    if "dq" in ml or "disqualif" in ml: return "DQ"
    return asc(m).strip()


def wiki_slug(ev_name):
    m = re.search(r"UFC (\d+)", ev_name)
    if m: return "UFC_" + m.group(1)
    clean = re.sub(r"[^a-zA-Z0-9 :._-]", "", ev_name)
    return clean.replace(" ", "_")


def fetch_wikitext(page_title):
    """Try 4 methods to get Wikipedia content. Returns (content, is_html)."""
    print("Fetching Wikipedia:", page_title, file=sys.stderr)

    # Method 1: Wikipedia REST API (action=parse, returns wikitext JSON)
    r = get("https://en.wikipedia.org/w/api.php", params={
        "action": "parse", "page": page_title, "prop": "wikitext", "format": "json"
    })
    if r:
        try:
            wt = r.json().get("parse", {}).get("wikitext", {}).get("*", "")
            if wt:
                print("  Method 1 (API) succeeded: %d chars" % len(wt), file=sys.stderr)
                return wt, False
        except Exception as e:
            print("  Method 1 JSON error:", e, file=sys.stderr)

    time.sleep(1)

    # Method 2: action=raw (raw wikitext, bypasses API layer)
    r = get("https://en.wikipedia.org/w/index.php", params={
        "title": page_title, "action": "raw"
    })
    if r and len(r.text) > 500:
        print("  Method 2 (raw) succeeded: %d chars" % len(r.text), file=sys.stderr)
        return r.text, False

    time.sleep(1)

    # Method 3: Regular HTML page with browser UA
    r = get("https://en.wikipedia.org/wiki/" + page_title, ua=BROWSER_UA)
    if r and len(r.text) > 500:
        print("  Method 3 (HTML browser) succeeded: %d chars" % len(r.text), file=sys.stderr)
        return r.text, True

    time.sleep(1)

    # Method 4: Wikipedia mobile (different server stack)
    r = get("https://en.m.wikipedia.org/wiki/" + page_title, ua=BROWSER_UA)
    if r and len(r.text) > 500:
        print("  Method 4 (mobile HTML) succeeded: %d chars" % len(r.text), file=sys.stderr)
        return r.text, True

    print("  All 4 methods failed for:", page_title, file=sys.stderr)
    return "", False


def parse_wikitext(wikitext):
    """Parse wikitext format - handles both template and table formats."""
    results = []

    # Format A: {{fight results}} templates
    for block in re.finditer(r"\{\{fight results(.*?)\}\}", wikitext, re.DOTALL | re.IGNORECASE):
        c = block.group(1)
        def field(name):
            m = re.search(r"\|" + name + r"\s*=\s*([^\|\}\n]+)", c)
            return clean_wiki(m.group(1)) if m else ""
        f1 = field("fighter1"); f2 = field("fighter2")
        ws = field("winner"); method = field("method"); detail = field("detail")
        rnd_s = field("round")
        if not f1 or not f2 or not method or not ws: continue
        winner = f1 if ws == "1" else f2 if ws == "2" else ""
        loser  = f2 if ws == "1" else f1 if ws == "2" else ""
        if not winner: continue
        try: rnd = int(rnd_s)
        except: rnd = None
        results.append({"winner": winner, "loser": loser,
            "method": norm_method(method + " " + detail), "round": rnd})

    if results:
        print("  Parsed %d results via template format" % len(results), file=sys.stderr)
        return results

    # Format B: wikitable rows (newline per cell with def. marker)
    in_table = False
    current_row = []

    def process_row(row):
        row = [clean_wiki(c) for c in row if c and clean_wiki(c)]
        if len(row) < 3: return None
        skip_words = ["weight class", "winner", "method", "round", "main card", "preliminary", "early prelim"]
        if any(h in " ".join(row).lower() for h in skip_words): return None
        winner = ""; loser = ""; method = ""; rnd = None
        def_idx = next((i for i, c in enumerate(row) if c.strip().lower() in ("def.", "def", "d.")), -1)
        if def_idx > 0:
            winner = row[def_idx - 1]
            loser  = row[def_idx + 1] if def_idx + 1 < len(row) else ""
            rest   = row[def_idx + 2:]
        else:
            if len(row) < 4: return None
            winner = row[1]; loser = row[2]; rest = row[3:]
        if not winner or len(winner) < 2: return None
        # Strip (c) championship indicator from names
        winner = re.sub(r"\s*\(c\)\s*", "", winner).strip()
        loser  = re.sub(r"\s*\(c\)\s*", "", loser).strip()
        for cell in rest:
            cl = cell.lower()
            if any(k in cl for k in ["ko", "tko", "decision", "submission", "sub", "dq", "draw", "nc"]):
                if not method: method = cell
            elif re.match(r"^\d$", cell.strip()):
                try: rnd = int(cell.strip())
                except: pass
        # If no method found but we have winner/loser/round, default to Decision
        if not method and winner and loser and rnd:
            method = "Decision"
        if not method: return None
        return {"winner": winner, "loser": loser, "method": norm_method(method), "round": rnd}

    for line in wikitext.split("\n"):
        s = line.strip()
        if "{|" in s and "wikitable" in s.lower():
            in_table = True; current_row = []; continue
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
                parts = [clean_wiki(p.strip()) for p in content.split("||")]
                current_row.extend(parts)
            else:
                current_row.append(clean_wiki(content))

    if results:
        print("  Parsed %d results via table format" % len(results), file=sys.stderr)
    return results


def parse_html(html):
    """Parse fight results from Wikipedia HTML page."""
    results = []
    soup = BeautifulSoup(html, "html.parser")

    for table in soup.find_all("table", class_=re.compile("wikitable", re.I)):
        rows = table.find_all("tr")
        current_row = []
        for row in rows[1:]:
            cells = row.find_all(["td", "th"])
            if not cells: continue
            vals = []
            for cell in cells:
                span = int(cell.get("colspan", 1))
                text = clean_wiki(cell.get_text(" ", strip=True))
                for _ in range(span): vals.append(text)
            if not vals: continue
            # Check for def. marker
            def_idx = next((i for i, c in enumerate(vals) if c.strip().lower() in ("def.", "def", "d.")), -1)
            if def_idx > 0:
                winner = vals[def_idx - 1]
                loser  = vals[def_idx + 1] if def_idx + 1 < len(vals) else ""
                rest   = vals[def_idx + 2:]
            else:
                if len(vals) < 4: continue
                winner = vals[1]; loser = vals[2]; rest = vals[3:]
            if not winner or len(winner) < 2: continue
            if winner.lower() in ("winner", "fighter", "weight class"): continue
            method = ""; rnd = None
            for cell in rest:
                cl = cell.lower()
                if any(k in cl for k in ["ko", "tko", "decision", "submission", "sub", "dq"]):
                    if not method: method = cell
                elif re.match(r"^\d$", cell.strip()):
                    try: rnd = int(cell.strip())
                    except: pass
            if method:
                results.append({"winner": winner, "loser": loser,
                    "method": norm_method(method), "round": rnd})

    print("  Parsed %d results via HTML" % len(results), file=sys.stderr)
    return results


def fetch_wiki_results(ev_name):
    slug = wiki_slug(ev_name)
    content, is_html = fetch_wikitext(slug)
    if not content:
        return []
    results = parse_html(content) if is_html else parse_wikitext(content)
    print("Results for %s: %d" % (ev_name, len(results)), file=sys.stderr)
    for res in results:
        print("  %s def %s by %s R%s" % (res["winner"], res["loser"], res["method"], res["round"]), file=sys.stderr)
    return results


def inject_results(js, results):
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
            # Check not already set
            snip = js[fs:fs+300]
            if 'state:"post"' in snip:
                print("  Already set: %s" % winner_name, file=sys.stderr)
                count += 1; break
            # Find end of fight object
            depth = 0; fe = fs
            for i in range(fs, min(fs + 2000, len(js))):
                ch = js[i]
                if ch == "{": depth += 1
                elif ch == "}": depth -= 1
                if depth == 0: fe = i + 1; break
            fstr = js[fs:fe]
            fstr = re.sub(r'winner:"[^"]*"', 'winner:"' + winner_name + '"', fstr)
            fstr = re.sub(r'method:"[^"]*"', 'method:"' + method + '"', fstr)
            fstr = re.sub(r"round:(?:null|\d+)", "round:" + (str(rnd) if rnd else "null"), fstr)
            fstr = re.sub(r'state:"[^"]*"', 'state:"post"', fstr)
            js = js[:fs] + fstr + js[fe:]
            print("  Injected: %s def %s by %s R%s" % (winner_name, f2n if f1w else f1n, method, rnd), file=sys.stderr)
            count += 1; break
    return js, count


def asc_only(t):
    if not t: return ""
    return "".join(c for c in str(t) if ord(c) < 128).strip()


def parse_record(text):
    m = re.search(r"(\d+)-(\d+)(?:-(\d+))?", text or "")
    if not m: return ""
    w, l, d = m.group(1), m.group(2), m.group(3)
    return w+"-"+l+"-"+d if (d and d != "0") else w+"-"+l


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
    return r.title() if r else "Catchweight"


def scrape_tapology():
    r = get(TAPOLOGY_EVENTS, ua=BROWSER_UA)
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
    r = get(url, ua=BROWSER_UA)
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
        lbl = "Main Event" if i == 0 else "Co-Main" if i == 1 else "Main Card" if i < 5 else "Prelim"
        fights.append({"label": lbl, "wc": wc, "title": title,
            "winner": "", "method": "", "round": None, "state": "pre",
            "f1": {"name": f1n, "record": f1r, "ranking": f1k},
            "f2": {"name": f2n, "record": f2r, "ranking": f2k}})
    if len(fights) < 2: return None
    return {"name": name, "date": date_str, "venue": venue,
            "location": "", "broadcast": "Paramount+", "time": "TBD", "fights": fights}


def fmt(dt):
    h = dt.hour % 12 or 12
    ap = "AM" if dt.hour < 12 else "PM"
    return "%d %s %d %d:%02d %s UTC" % (dt.day, dt.strftime("%b"), dt.year, h, dt.minute, ap)


def main():
    index = Path("index.html")
    if not index.exists():
        print("No index.html", file=sys.stderr); sys.exit(1)
    html = index.read_text(encoding="utf-8")
    now = datetime.now(timezone.utc)
    ex_names = re.findall(r'name:"([^"]+)"', html)
    ex_dates = re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', html)
    print("Events in file:", list(zip(ex_dates[:4], ex_names[:4])), file=sys.stderr)

    js_start = html.find("<script>") + 8
    js_end = html.rfind("</script>")
    js = html[js_start:js_end]
    total = 0

    # Step 1: Fetch Wikipedia results for recent/today events
    for ev_name, ev_date in zip(ex_names, ex_dates):
        try: ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except: continue
        if ed < now - timedelta(days=2) or ed > now + timedelta(hours=6): continue
        print("Checking results for:", ev_name, file=sys.stderr)
        results = fetch_wiki_results(ev_name)
        if results:
            js, n = inject_results(js, results)
            total += n
        time.sleep(1)

    if total > 0:
        label = fmt(now)
        html_new = html[:js_start] + js + html[js_end:]
        html_new = re.sub('Updated <span id="updateDate">[^<]*</span>',
                         'Updated <span id="updateDate">' + label + '</span>', html_new)
        index.write_text(html_new, encoding="utf-8")
        print("Done: %d results injected" % total, file=sys.stderr)
        sys.exit(0)

    print("No new results from Wikipedia", file=sys.stderr)

    # Step 2: Skip Tapology if recent event present
    has_recent = any(
        datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc) >= now - timedelta(days=2)
        for d in ex_dates)
    if has_recent:
        print("Recent event present - skipping Tapology", file=sys.stderr)
        sys.exit(0)

    # Step 3: Card structure from Tapology
    print("Scraping Tapology...", file=sys.stderr)
    urls = scrape_tapology(); events = []
    for url in urls:
        ev = scrape_event(url)
        if ev: events.append(ev); print("OK:", ev["name"], file=sys.stderr)
        time.sleep(1)
    events.sort(key=lambda e: e["date"])
    if not events: print("No events", file=sys.stderr); sys.exit(0)

    scraped_dates = set(e["date"] for e in events)
    for d in ex_dates:
        try:
            ed = datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            if ed >= now - timedelta(days=2) and d not in scraped_dates:
                print("Recent event missing from Tapology - aborting", file=sys.stderr)
                sys.exit(0)
        except: pass

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
            out += ["  {", "    name:" + json.dumps(ev["name"]) + ",",
                "    date:" + json.dumps(ev["date"]) + ",",
                "    venue:" + json.dumps(ev.get("venue", "")) + ",",
                "    loc:" + json.dumps(ev.get("location", "")) + ",",
                "    tv:" + json.dumps(ev.get("broadcast", "Paramount+")) + ",",
                "    time:" + json.dumps(ev.get("time", "TBD")) + ",",
                "    fights:["]
            fs = ev.get("fights", [])
            for fi, f in enumerate(fs):
                out.append(fight_js(f, "," if fi < len(fs)-1 else ""))
            out += ["    ]", "  }" + c]
        out.append("];")
        return "\n".join(out)

    new_js = events_js(events)
    html_new = re.sub(r"var EVENTS\s*=\s*\[.*?\];", new_js, html, flags=re.DOTALL)
    label = fmt(now)
    html_new = re.sub('Updated <span id="updateDate">[^<]*</span>',
                     'Updated <span id="updateDate">' + label + '</span>', html_new)
    if len(html_new) < 30000: print("Too small - aborting", file=sys.stderr); sys.exit(0)
    index.write_text(html_new, encoding="utf-8")
    print("Card structure updated:", len(events), "events", file=sys.stderr)


if __name__ == "__main__":
    main()