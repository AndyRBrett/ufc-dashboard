#!/usr/bin/env python3
# UFC scraper - Wikipedia wikitext results parser
import json, re, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests
from bs4 import BeautifulSoup

HEADERS = {"User-Agent": "UFC-Dashboard/1.0 (https://github.com/AndyRBrett/ufc-dashboard)"}
WIKI_API = "https://en.wikipedia.org/w/api.php"
TAPOLOGY_BASE = "https://www.tapology.com"
TAPOLOGY_EVENTS = "https://www.tapology.com/fightcenter"

def get(url, params=None):
    for i in range(3):
        try:
            r = requests.get(url, headers=HEADERS, params=params, timeout=15)
            if r.status_code == 200: return r
            print("HTTP %d: %s" % (r.status_code, url[:60]), file=sys.stderr)
        except Exception as e:
            print("GET fail %d: %s" % (i+1, e), file=sys.stderr)
            if i < 2: time.sleep(2)
    return None

def asc(t):
    if not t: return ""
    return "".join(c for c in str(t) if ord(c) < 128).strip()

def strip_wiki(text):
    text = re.sub(r"\[\[([^\]|]+\|)?([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\{\{[^}]+\}\}", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    return asc(text).strip(",")

def last_name(n):
    return n.strip().split()[-1].lower() if n.strip() else ""

def names_match(a, b):
    a2 = re.sub(r"[^a-z]", "", a.lower())
    b2 = re.sub(r"[^a-z]", "", b.lower())
    return last_name(a) == last_name(b) or (len(a2) > 3 and a2 in b2) or (len(b2) > 3 and b2 in a2)

def norm_method(method, detail=""):
    m = (method + " " + detail).lower()
    if "ko" in m or "tko" in m: return "KO/TKO"
    if "submission" in m or "sub" in m: return "Submission"
    if "unanimous" in m: return "Decision (Unanimous)"
    if "split" in m: return "Decision (Split)"
    if "majority" in m: return "Decision (Majority)"
    if "decision" in m: return "Decision"
    if "dq" in m or "disqualif" in m: return "DQ"
    return asc(method).strip()

def wiki_slug(ev_name):
    m = re.search(r"UFC (\d+)", ev_name)
    if m: return "UFC_" + m.group(1)
    clean = re.sub(r"[^a-zA-Z0-9 :._-]", "", ev_name)
    return clean.replace(" ", "_")

def fetch_wiki_wikitext(ev_name):
    slug = wiki_slug(ev_name)
    print("Wiki:", slug, file=sys.stderr)
    r = get(WIKI_API, params={"action":"parse","page":slug,"prop":"wikitext","format":"json"})
    if not r: return ""
    try: return r.json().get("parse",{}).get("wikitext",{}).get("*","")
    except Exception as e: print("Wiki JSON error:", e, file=sys.stderr); return ""

def parse_template_results(wikitext):
    results = []
    for block in re.finditer(r"\{\{fight results(.*?)\}\}", wikitext, re.DOTALL | re.IGNORECASE):
        c = block.group(1)
        def field(name):
            m = re.search(r"\|" + name + r"\s*=\s*([^\|\}\n]+)", c)
            return strip_wiki(m.group(1)) if m else ""
        f1 = field("fighter1"); f2 = field("fighter2")
        ws = field("winner"); method = field("method"); detail = field("detail")
        rnd_s = field("round")
        if not f1 or not f2 or not method or not ws: continue
        winner = f1 if ws == "1" else f2 if ws == "2" else ""
        loser  = f2 if ws == "1" else f1 if ws == "2" else ""
        if not winner: continue
        try: rnd = int(rnd_s)
        except: rnd = None
        results.append({"winner":winner,"loser":loser,"method":norm_method(method,detail),"round":rnd})
    return results

def parse_table_results(wikitext):
    results = []
    in_table = False
    for line in wikitext.split("\n"):
        line = line.strip()
        if "{|" in line and "wikitable" in line: in_table = True; continue
        if "|}" in line: in_table = False; continue
        if not in_table or not line.startswith("|"): continue
        if line.startswith("|-") or line.startswith("|!"): continue
        cells = [strip_wiki(c.strip()) for c in line.lstrip("|").split("||")]
        if len(cells) < 4: continue
        winner = cells[1] if len(cells) > 1 else ""
        loser  = cells[2] if len(cells) > 2 else ""
        method = cells[3] if len(cells) > 3 else ""
        rnd_s  = cells[4] if len(cells) > 4 else ""
        if not winner or not method: continue
        if winner.lower() in ("winner","fighter","weight class"): continue
        try: rnd = int(re.search(r"\d+", rnd_s).group())
        except: rnd = None
        results.append({"winner":winner,"loser":loser,"method":norm_method(method),"round":rnd})
    return results

def fetch_wiki_results(ev_name):
    wikitext = fetch_wiki_wikitext(ev_name)
    if not wikitext: return []
    results = parse_template_results(wikitext) or parse_table_results(wikitext)
    print("Wiki results for %s: %d" % (ev_name, len(results)), file=sys.stderr)
    for res in results:
        print("  %s def %s by %s R%s" % (res["winner"],res["loser"],res["method"],res["round"]), file=sys.stderr)
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
            depth = 0; fe = fs
            for i in range(fs, min(fs+2000, len(js))):
                ch = js[i]
                if ch == "{": depth += 1
                elif ch == "}": depth -= 1
                if depth == 0: fe = i+1; break
            fstr = js[fs:fe]
            fstr = re.sub(r'winner:"[^"]*"', 'winner:"'+winner_name+'"', fstr)
            fstr = re.sub(r'method:"[^"]*"', 'method:"'+method+'"', fstr)
            fstr = re.sub(r"round:(?:null|\d+)", "round:"+(str(rnd) if rnd else "null"), fstr)
            fstr = re.sub(r'state:"[^"]*"', 'state:"post"', fstr)
            js = js[:fs] + fstr + js[fe:]
            print("  -> %s def %s by %s R%s" % (winner_name, f2n if f1w else f1n, method, rnd), file=sys.stderr)
            count += 1; break
    return js, count

def asc_only(t):
    if not t: return ""
    return "".join(c for c in str(t) if ord(c) < 128).strip()

def parse_record(text):
    m = re.search(r"(\d+)-(\d+)(?:-(\d+))?", text or "")
    if not m: return ""
    w,l,d = m.group(1),m.group(2),m.group(3)
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
    seen,urls = set(),[]
    for a in soup.select("a[href*='/fightcenter/events/']"):
        href = a.get("href","")
        if "/fightcenter/events/" not in href: continue
        url = TAPOLOGY_BASE+href if href.startswith("/") else href
        if url not in seen: seen.add(url); urls.append(url)
    return urls[:12]

def scrape_event(url):
    print("Scraping:", url[:70], file=sys.stderr)
    r = get(url)
    if not r: return None
    soup = BeautifulSoup(r.text,"html.parser")
    h1 = soup.select_one("h1.border-b") or soup.select_one("h1")
    name = asc_only(h1.get_text(strip=True)) if h1 else ""
    if not name or "ufc" not in name.lower(): return None
    date_str = ""
    de = soup.find(attrs={"data-date":True}) or soup.find("span",string=re.compile(r"\d{4}"))
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
        ed=datetime.strptime(date_str,"%Y-%m-%d").replace(tzinfo=timezone.utc)
        now=datetime.now(timezone.utc)
        if ed < now-timedelta(days=2) or ed > now+timedelta(days=65): return None
    except: pass
    ve = soup.select_one(".eventVenue")
    venue = asc_only(ve.get_text(strip=True)) if ve else ""
    fights = []
    rows = soup.select(".fightCard li") or soup.select("li.event")
    for i,row in enumerate(rows):
        wce = row.select_one(".weight") or row.select_one("[class*='weight']")
        wc = norm_wc(wce.get_text(strip=True) if wce else "")
        title = "title" in row.get_text().lower()
        fts = row.select(".name") or row.select("a[href*='/fighters/']")
        f1n = asc_only(fts[0].get_text(strip=True)) if len(fts)>0 else "TBD"
        f2n = asc_only(fts[1].get_text(strip=True)) if len(fts)>1 else "TBD"
        recs = row.select(".record") or row.select("[class*='record']")
        f1r = parse_record(recs[0].get_text()) if len(recs)>0 else ""
        f2r = parse_record(recs[1].get_text()) if len(recs)>1 else ""
        rnks = row.select(".rank") or row.select("[class*='rank']")
        f1k = asc_only(rnks[0].get_text(strip=True)) if len(rnks)>0 else ""
        f2k = asc_only(rnks[1].get_text(strip=True)) if len(rnks)>1 else ""
        if f1n=="TBD" and f2n=="TBD": continue
        lbl = "Main Event" if i==0 else "Co-Main" if i==1 else "Main Card" if i<5 else "Prelim"
        fights.append({"label":lbl,"wc":wc,"title":title,
            "winner":"","method":"","round":None,"state":"pre",
            "f1":{"name":f1n,"record":f1r,"ranking":f1k},
            "f2":{"name":f2n,"record":f2r,"ranking":f2k}})
    if len(fights)<2: return None
    return {"name":name,"date":date_str,"venue":venue,"location":"",
            "broadcast":"Paramount+","time":"TBD","fights":fights}

def fmt(dt):
    h = dt.hour%12 or 12
    ap = "AM" if dt.hour<12 else "PM"
    return "%d %s %d %d:%02d %s UTC" % (dt.day,dt.strftime("%b"),dt.year,h,dt.minute,ap)

def main():
    index = Path("index.html")
    if not index.exists(): print("No index.html",file=sys.stderr); sys.exit(1)
    html = index.read_text(encoding="utf-8")
    now = datetime.now(timezone.utc)
    ex_names = re.findall(r'name:"([^"]+)"', html)
    ex_dates = re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', html)
    print("Events:", list(zip(ex_dates[:4], ex_names[:4])), file=sys.stderr)
    js_start = html.find("<script>")+8
    js_end = html.rfind("</script>")
    js = html[js_start:js_end]
    total = 0
    # Step 1: Wikipedia results for recent/active events
    for ev_name, ev_date in zip(ex_names, ex_dates):
        try: ed = datetime.strptime(ev_date,"%Y-%m-%d").replace(tzinfo=timezone.utc)
        except: continue
        if ed < now-timedelta(days=2) or ed > now+timedelta(hours=6): continue
        results = fetch_wiki_results(ev_name)
        if results: js, n = inject_results(js, results); total += n
        time.sleep(1)
    if total > 0:
        label = fmt(now)
        html_new = html[:js_start] + js + html[js_end:]
        html_new = re.sub('Updated <span id="updateDate">[^<]*</span>',
                         'Updated <span id="updateDate">'+label+'</span>', html_new)
        index.write_text(html_new, encoding="utf-8")
        print("Done: %d results injected" % total, file=sys.stderr)
        sys.exit(0)
    print("No wiki results - checking Tapology", file=sys.stderr)
    # Step 2: Skip Tapology if recent event present
    has_recent = any(
        datetime.strptime(d,"%Y-%m-%d").replace(tzinfo=timezone.utc) >= now-timedelta(days=2)
        for d in ex_dates)
    if has_recent:
        print("Recent event - skipping Tapology", file=sys.stderr); sys.exit(0)
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
            ed=datetime.strptime(d,"%Y-%m-%d").replace(tzinfo=timezone.utc)
            if ed>=now-timedelta(days=2) and d not in scraped_dates:
                print("Recent event missing - aborting",file=sys.stderr); sys.exit(0)
        except: pass
    def fight_js(f,comma=""):
        f1=f["f1"]; f2=f["f2"]
        odds=f.get("odds")
        odds_s="{f1:%d,f2:%d}"%(odds["f1"],odds["f2"]) if odds else "null"
        f1s=json.dumps(f1.get("stats")) if f1.get("stats") else "null"
        f2s=json.dumps(f2.get("stats")) if f2.get("stats") else "null"
        rnd=str(f.get("round") or "null")
        return ("      {lbl:%s,wc:%s,title:%s,odds:%s,winner:%s,method:%s,"
                "round:%s,state:%s,f1:{n:%s,r:%s,rk:%s,s:%s},"
                "f2:{n:%s,r:%s,rk:%s,s:%s}}%s")%(
            json.dumps(f["label"]),json.dumps(f["wc"]),
            "true" if f["title"] else "false",odds_s,
            json.dumps(f.get("winner","")),json.dumps(f.get("method","")),
            rnd,json.dumps(f.get("state","pre")),
            json.dumps(f1["name"]),json.dumps(f1.get("record","")),
            json.dumps(f1.get("ranking","")),f1s,
            json.dumps(f2["name"]),json.dumps(f2.get("record","")),
            json.dumps(f2.get("ranking","")),f2s,comma)
    def events_js(evs):
        out=["var EVENTS=["]
        for ei,ev in enumerate(evs):
            c="," if ei<len(evs)-1 else ""
            out+=["  {","    name:"+json.dumps(ev["name"])+",",
                "    date:"+json.dumps(ev["date"])+",",
                "    venue:"+json.dumps(ev.get("venue",""))+",",
                "    loc:"+json.dumps(ev.get("location",""))+",",
                "    tv:"+json.dumps(ev.get("broadcast","Paramount+"))+",",
                "    time:"+json.dumps(ev.get("time","TBD"))+",",
                "    fights:["]
            fs=ev.get("fights",[])
            for fi,f in enumerate(fs):
                out.append(fight_js(f,"," if fi<len(fs)-1 else ""))
            out+=["    ]","  }"+c]
        out.append("];"); return "\n".join(out)
    new_js=events_js(events)
    html_new=re.sub(r"var EVENTS\s*=\s*\[.*?\];",new_js,html,flags=re.DOTALL)
    label=fmt(now)
    html_new=re.sub('Updated <span id="updateDate">[^<]*</span>',
                   'Updated <span id="updateDate">'+label+'</span>',html_new)
    if len(html_new)<30000: print("Too small",file=sys.stderr); sys.exit(0)
    index.write_text(html_new,encoding="utf-8")
    print("Structure updated:",len(events),"events",file=sys.stderr)

if __name__ == "__main__":
    main()