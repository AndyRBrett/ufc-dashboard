#!/usr/bin/env python3

# UFC Fight Card Scraper - pure ASCII source

import json, re, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests
from bs4 import BeautifulSoup

HEADERS = {“User-Agent”: “Mozilla/5.0 (compatible; UFC-Bot/1.0)”}
TAPOLOGY_BASE = “https://www.tapology.com”
TAPOLOGY_EVENTS = “https://www.tapology.com/fightcenter”
ESPN_URL = “https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard”

def get_json(url, retries=3):
for i in range(retries):
try:
r = requests.get(url, headers=HEADERS, timeout=15)
r.raise_for_status()
return r.json()
except Exception as e:
print(”  get_json fail %d: %s” % (i+1, e), file=sys.stderr)
if i < retries-1: time.sleep(2)
return None

def get_soup(url, retries=3):
for i in range(retries):
try:
r = requests.get(url, headers=HEADERS, timeout=15)
r.raise_for_status()
return **import**(“bs4”).BeautifulSoup(r.text, “html.parser”)
except Exception as e:
print(”  get_soup fail %d: %s” % (i+1, e), file=sys.stderr)
if i < retries-1: time.sleep(2)
return None

def ascii_only(text):
if not text: return “”
return “”.join(c for c in str(text) if ord(c) < 128).strip()

def parse_record(text):
m = re.search(r”(\d+)-(\d+)(?:-(\d+))?”, text or “”)
if not m: return “”
w, l, d = m.group(1), m.group(2), m.group(3)
return “%s-%s-%s” % (w, l, d) if (d and d != “0”) else “%s-%s” % (w, l)

def norm_wc(raw):
r = (raw or “”).lower().strip()
if “heavyweight” in r and “light” not in r: return “Heavyweight”
if “light heavyweight” in r: return “Light Heavyweight”
if “middleweight” in r: return “Middleweight”
if “welterweight” in r: return “Welterweight”
if “lightweight” in r: return “Lightweight”
if “featherweight” in r and “women” not in r: return “Featherweight”
if “bantamweight” in r and “women” not in r: return “Bantamweight”
if “flyweight” in r and “women” not in r: return “Flyweight”
if “strawweight” in r: return “Women’s Strawweight”
if “women” in r and “flyweight” in r: return “Women’s Flyweight”
if “women” in r and “bantamweight” in r: return “Women’s Bantamweight”
if “women” in r and “featherweight” in r: return “Women’s Featherweight”
return r.title() if r else “Catchweight”

def name_last(n):
return n.strip().split()[-1].lower() if n.strip() else “”

def name_match(a, b):
al, bl = name_last(a), name_last(b)
na = re.sub(r”[^a-z]”, “”, a.lower())
nb = re.sub(r”[^a-z]”, “”, b.lower())
return al == bl or na in nb or nb in na

def fetch_espn():
print(”  Fetching ESPN results…”, file=sys.stderr)
data = get_json(ESPN_URL)
if not data: return []
results = []
for event in data.get(“events”, []):
for comp in event.get(“competitions”, []):
stype = comp.get(“status”, {}).get(“type”, {})
state = stype.get(“state”, “”)
if state not in (“in”, “post”): continue
comps = comp.get(“competitors”, [])
if len(comps) < 2: continue
winner = next((c for c in comps if c.get(“winner”)), None)
loser  = next((c for c in comps if not c.get(“winner”)), None)
if not winner or not loser:
results.append({“f1”: comps[0].get(“athlete”,{}).get(“displayName”,””),
“f2”: comps[1].get(“athlete”,{}).get(“displayName”,””),
“winner”: None, “method”: None, “round”: None, “state”: state})
continue
detail = stype.get(“detail”, “”)
mm = re.search(r”(KO|TKO|KO/TKO|Submission|Decision|Split Decision|”
r”Unanimous Decision|Majority Decision|Technical Submission|DQ)”,
detail, re.I)
method = mm.group(1) if mm else “Decision”
rm = re.search(r”Round\s*(\d+)”, detail, re.I)
rnd = int(rm.group(1)) if rm else None
wname = winner.get(“athlete”,{}).get(“displayName”,””)
lname = loser.get(“athlete”,{}).get(“displayName”,””)
results.append({“f1”: wname, “f2”: lname, “winner”: wname,
“method”: method, “round”: rnd, “state”: state})
print(”  ESPN: %d results” % len(results), file=sys.stderr)
return results

def inject_results(events, results):
if not results: return events
for ev in events:
for fight in ev.get(“fights”, []):
f1 = fight[“fighter1”][“name”]
f2 = fight[“fighter2”][“name”]
for res in results:
r1, r2 = res.get(“f1”,””), res.get(“f2”,””)
if ((name_match(f1,r1) and name_match(f2,r2)) or
(name_match(f1,r2) and name_match(f2,r1))):
fight[“winner”] = res.get(“winner”)
fight[“method”] = res.get(“method”)
fight[“round”]  = res.get(“round”)
fight[“state”]  = res.get(“state”,“post”)
print(”  Matched: %s -> %s” % (f1, res.get(“winner”)), file=sys.stderr)
break
return events

def get_event_urls():
soup = get_soup(TAPOLOGY_EVENTS)
if not soup: return []
seen = set()
urls = []
for a in soup.select(“a[href*=’/fightcenter/events/’]”):
href = a.get(“href”,””)
if “/fightcenter/events/” not in href: continue
url = TAPOLOGY_BASE + href if href.startswith(”/”) else href
if url not in seen:
seen.add(url)
urls.append(url)
return urls[:12]

def scrape_event(url):
print(”  Scraping: %s” % url, file=sys.stderr)
soup = get_soup(url)
if not soup: return None
h1 = soup.select_one(“h1.border-b”) or soup.select_one(“h1”)
name = ascii_only(h1.get_text(strip=True)) if h1 else “”
if not name or “ufc” not in name.lower(): return None
date_str = “”
de = soup.find(attrs={“data-date”: True}) or soup.find(“span”, string=re.compile(r”\d{4}”))
if de:
raw = de.get(“data-date”) or de.get_text(strip=True)
try:
dt = datetime.fromisoformat(raw.replace(“Z”,”+00:00”))
date_str = dt.strftime(”%Y-%m-%d”)
except Exception:
for fmt in (”%B %d, %Y”, “%b %d, %Y”, “%m/%d/%Y”):
try:
date_str = datetime.strptime(raw.strip(), fmt).strftime(”%Y-%m-%d”)
break
except Exception: pass
if not date_str: return None
try:
ed = datetime.strptime(date_str, “%Y-%m-%d”).replace(tzinfo=timezone.utc)
now = datetime.now(timezone.utc)
if ed < now - timedelta(days=1) or ed > now + timedelta(days=65): return None
except Exception: pass
venue_el = soup.select_one(”.eventVenue”)
venue = ascii_only(venue_el.get_text(strip=True)) if venue_el else “”
fights = []
rows = soup.select(”.fightCard li”) or soup.select(“li.event”)
for i, row in enumerate(rows):
wce = row.select_one(”.weight”) or row.select_one(”[class*=‘weight’]”)
wc = norm_wc(wce.get_text(strip=True) if wce else “”)
title = “title” in row.get_text().lower() or “championship” in row.get_text().lower()
fts = row.select(”.name”) or row.select(“a[href*=’/fighters/’]”)
f1n = ascii_only(fts[0].get_text(strip=True)) if len(fts)>0 else “TBD”
f2n = ascii_only(fts[1].get_text(strip=True)) if len(fts)>1 else “TBD”
recs = row.select(”.record”) or row.select(”[class*=‘record’]”)
f1r = parse_record(recs[0].get_text()) if len(recs)>0 else “”
f2r = parse_record(recs[1].get_text()) if len(recs)>1 else “”
rnks = row.select(”.rank”) or row.select(”[class*=‘rank’]”)
f1k = ascii_only(rnks[0].get_text(strip=True)) if len(rnks)>0 else “”
f2k = ascii_only(rnks[1].get_text(strip=True)) if len(rnks)>1 else “”
if f1n == “TBD” and f2n == “TBD”: continue
lbl = “Main Event” if i==0 else “Co-Main” if i==1 else “Main Card” if i<5 else “Prelim”
fights.append({“label”:lbl,“weightClass”:wc,“titleFight”:title,
“winner”:None,“method”:None,“round”:None,“state”:“pre”,
“fighter1”:{“name”:f1n,“record”:f1r,“ranking”:f1k},
“fighter2”:{“name”:f2n,“record”:f2r,“ranking”:f2k}})
if len(fights) < 2:
print(”  Too few fights: %s” % name, file=sys.stderr)
return None
return {“name”:name,“date”:date_str,“venue”:venue,“location”:””,
“broadcast”:“Paramount+”,“mainCardTime”:“TBD”,“fights”:fights}

def fight_js(f, comma=””):
f1, f2 = f[“fighter1”], f[“fighter2”]
winner = json.dumps(f.get(“winner”) or “”)
method = json.dumps(f.get(“method”) or “”)
rnd    = str(f.get(“round”) or “null”)
state  = json.dumps(f.get(“state”) or “pre”)
f1s = json.dumps(f1.get(“stats”)) if f1.get(“stats”) else “null”
f2s = json.dumps(f2.get(“stats”)) if f2.get(“stats”) else “null”
odds = f.get(“odds”)
odds_s = “{f1:%d,f2:%d}” % (odds[“f1”],odds[“f2”]) if odds else “null”
return (”      {lbl:%(lbl)s,wc:%(wc)s,title:%(title)s,odds:%(odds)s,”
“winner:%(winner)s,method:%(method)s,round:%(round)s,state:%(state)s,”
“f1:{n:%(f1n)s,r:%(f1r)s,rk:%(f1k)s,s:%(f1s)s},”
“f2:{n:%(f2n)s,r:%(f2r)s,rk:%(f2k)s,s:%(f2s)s}}%(comma)s”) % {
“lbl”: json.dumps(f[“label”]),
“wc”: json.dumps(f[“weightClass”]),
“title”: “true” if f[“titleFight”] else “false”,
“odds”: odds_s,
“winner”: winner, “method”: method,
“round”: rnd, “state”: state,
“f1n”: json.dumps(f1[“name”]),
“f1r”: json.dumps(f1.get(“record”,””)),
“f1k”: json.dumps(f1.get(“ranking”,””)),
“f1s”: f1s,
“f2n”: json.dumps(f2[“name”]),
“f2r”: json.dumps(f2.get(“record”,””)),
“f2k”: json.dumps(f2.get(“ranking”,””)),
“f2s”: f2s,
“comma”: comma}

def events_js(events):
out = [“var EVENTS=[”]
for ei, ev in enumerate(events):
c = “,” if ei < len(events)-1 else “”
out.append(”  {”)
out.append(”    name:” + json.dumps(ev[“name”]) + “,”)
out.append(”    date:” + json.dumps(ev[“date”]) + “,”)
out.append(”    venue:” + json.dumps(ev.get(“venue”,””)) + “,”)
out.append(”    loc:” + json.dumps(ev.get(“location”,””)) + “,”)
out.append(”    tv:” + json.dumps(ev.get(“broadcast”,“Paramount+”)) + “,”)
out.append(”    time:” + json.dumps(ev.get(“mainCardTime”,“TBD”)) + “,”)
out.append(”    fights:[”)
fights = ev.get(“fights”,[])
for fi, f in enumerate(fights):
fc = “,” if fi < len(fights)-1 else “”
out.append(fight_js(f, fc))
out.append(”    ]”)
out.append(”  }” + c)
out.append(”];”)
return “\n”.join(out)

def build_html(events, label):
p = Path(“index.html”) if Path(“index.html”).exists() else Path(“template.html”)
tmpl = p.read_text(encoding=“utf-8”)
js = events_js(events)
out = re.sub(r”var EVENTS\s*=\s*[.*?];”, js, tmpl, flags=re.DOTALL)
out = re.sub(r’Updated <span id="updateDate">[^<]*</span>’,
‘Updated <span id="updateDate">’ + label + ‘</span>’, out)
out = out.replace(”{{UPDATED}}”, label)
return out

def validate(html):
if not re.search(r”var EVENTS\s*=\s*[”, html): return False, “no EVENTS”
if len(html) < 10000: return False, “too small”
return True, “ok”

def is_fight_night():
try:
html = Path(“index.html”).read_text(encoding=“utf-8”)
dates = re.findall(r’date:”(\d{4}-\d{2}-\d{2})”’, html)
return datetime.now(timezone.utc).strftime(”%Y-%m-%d”) in dates
except Exception: return False

def fmt_date(dt):
return str(dt.day) + dt.strftime(” %b %Y”)

def fmt_datetime(dt):
h = dt.hour % 12 or 12
ap = “AM” if dt.hour < 12 else “PM”
return “%d %s %s %d:%02d %s UTC” % (dt.day, dt.strftime(”%b”), dt.year, h, dt.minute, ap)

def main():
fight_night = is_fight_night()
print(“Fight night: %s” % fight_night, file=sys.stderr)
espn = fetch_espn()
print(“Scraping Tapology…”, file=sys.stderr)
urls = get_event_urls()
print(“Found %d URLs” % len(urls), file=sys.stderr)
events = []
for url in urls:
ev = scrape_event(url)
if ev:
print(”  OK: %s (%s)” % (ev[“name”], ev[“date”]), file=sys.stderr)
events.append(ev)
time.sleep(1)
events.sort(key=lambda e: e[“date”])
if not events:
print(“No events – keeping existing index.html”, file=sys.stderr)
sys.exit(0)
events = inject_results(events, espn)
now = datetime.now(timezone.utc)
label = fmt_datetime(now) if (fight_night and espn) else fmt_date(now)
html = build_html(events, label)
ok, reason = validate(html)
if not ok:
print(“Validation failed: %s” % reason, file=sys.stderr)
sys.exit(0)
Path(“index.html”).write_text(html, encoding=“utf-8”)
n_res = sum(1 for e in events for f in e[“fights”] if f.get(“winner”))
print(“Done: %d events, %d results” % (len(events), n_res), file=sys.stderr)

if **name** == “**main**”:
main()