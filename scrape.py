#!/usr/bin/env python3
# UFC scraper - strict ASCII only
import json, re, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import requests
from bs4 import BeautifulSoup

HEADERS = {“User-Agent”: “Mozilla/5.0 (compatible; UFC-Bot/1.0)”}
TAPOLOGY = “https://www.tapology.com”
TAP_EVENTS = “https://www.tapology.com/fightcenter”
ESPN = “https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard”

def get_json(url):
for i in range(3):
try:
r = requests.get(url, headers=HEADERS, timeout=15)
r.raise_for_status()
return r.json()
except Exception as e:
print(“get_json fail:”, e, file=sys.stderr)
if i < 2: time.sleep(2)
return None

def get_soup(url):
for i in range(3):
try:
r = requests.get(url, headers=HEADERS, timeout=15)
r.raise_for_status()
return BeautifulSoup(r.text, “html.parser”)
except Exception as e:
print(“get_soup fail:”, e, file=sys.stderr)
if i < 2: time.sleep(2)
return None

def asc(text):
if not text: return “”
return “”.join(c for c in str(text) if ord(c) < 128).strip()

def parse_rec(text):
m = re.search(r”(\d+)-(\d+)(?:-(\d+))?”, text or “”)
if not m: return “”
w, l, d = m.group(1), m.group(2), m.group(3)
return w+”-”+l+”-”+d if (d and d!=“0”) else w+”-”+l

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
if ‘strawweight’ in r: return “Women’s Strawweight”
if ‘women’ in r and ‘flyweight’ in r: return “Women’s Flyweight”
if ‘women’ in r and ‘bantamweight’ in r: return “Women’s Bantamweight”
return r.title() if r else “Catchweight”

def match(a, b):
def last(n): return n.strip().split()[-1].lower() if n.strip() else “”
def norm(n): return re.sub(r”[^a-z]”, “”, n.lower())
return last(a)==last(b) or norm(a) in norm(b) or norm(b) in norm(a)

def fetch_espn():
print(“Fetching ESPN…”, file=sys.stderr)
data = get_json(ESPN)
if not data: return []
out = []
for ev in data.get(“events”, []):
for comp in ev.get(“competitions”, []):
st = comp.get(“status”, {}).get(“type”, {})
state = st.get(“state”, “”)
if state not in (“in”, “post”): continue
cs = comp.get(“competitors”, [])
if len(cs) < 2: continue
w = next((c for c in cs if c.get(“winner”)), None)
l = next((c for c in cs if not c.get(“winner”)), None)
if not w or not l:
out.append({“f1”: cs[0].get(“athlete”,{}).get(“displayName”,””),
“f2”: cs[1].get(“athlete”,{}).get(“displayName”,””),
“winner”: None, “method”: None, “round”: None, “state”: state})
continue
detail = st.get(“detail”, “”)
mm = re.search(
r”(KO|TKO|KO/TKO|Submission|Decision|Split Decision|Unanimous Decision)”,
detail, re.I)
method = mm.group(1) if mm else “Decision”
rm = re.search(r”Round\s*(\d+)”, detail, re.I)
rnd = int(rm.group(1)) if rm else None
wn = w.get(“athlete”,{}).get(“displayName”,””)
out.append({“f1”: wn, “f2”: l.get(“athlete”,{}).get(“displayName”,””),
“winner”: wn, “method”: method, “round”: rnd, “state”: state})
print(“ESPN results:”, len(out), file=sys.stderr)
return out

def inject(events, results):
if not results: return events
for ev in events:
for fight in ev.get(“fights”, []):
f1 = fight[“f1”][“name”]
f2 = fight[“f2”][“name”]
for res in results:
r1, r2 = res.get(“f1”,””), res.get(“f2”,””)
if (match(f1,r1) and match(f2,r2)) or (match(f1,r2) and match(f2,r1)):
fight[“winner”] = res.get(“winner”)
fight[“method”] = res.get(“method”)
fight[“round”] = res.get(“round”)
fight[“state”] = res.get(“state”,“post”)
print(“Matched:”, f1, “->”, res.get(“winner”), file=sys.stderr)
break
return events

def get_urls():
soup = get_soup(TAP_EVENTS)
if not soup: return []
seen, urls = set(), []
for a in soup.select(“a[href*=’/fightcenter/events/’]”):
href = a.get(“href”,””)
if “/fightcenter/events/” not in href: continue
url = TAPOLOGY + href if href.startswith(”/”) else href
if url not in seen: seen.add(url); urls.append(url)
return urls[:12]

def scrape_event(url):
print(“Scraping:”, url, file=sys.stderr)
soup = get_soup(url)
if not soup: return None
h1 = soup.select_one(“h1.border-b”) or soup.select_one(“h1”)
name = asc(h1.get_text(strip=True)) if h1 else “”
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
try: date_str = datetime.strptime(raw.strip(), fmt).strftime(”%Y-%m-%d”); break
except Exception: pass
if not date_str: return None
try:
ed = datetime.strptime(date_str,”%Y-%m-%d”).replace(tzinfo=timezone.utc)
now = datetime.now(timezone.utc)
if ed < now-timedelta(days=1) or ed > now+timedelta(days=65): return None
except Exception: pass
ve = soup.select_one(”.eventVenue”)
venue = asc(ve.get_text(strip=True)) if ve else “”
fights = []
rows = soup.select(”.fightCard li”) or soup.select(“li.event”)
for i, row in enumerate(rows):
wce = row.select_one(”.weight”) or row.select_one(”[class*=‘weight’]”)
wc = norm_wc(wce.get_text(strip=True) if wce else “”)
title = “title” in row.get_text().lower()
fts = row.select(”.name”) or row.select(“a[href*=’/fighters/’]”)
f1n = asc(fts[0].get_text(strip=True)) if len(fts)>0 else “TBD”
f2n = asc(fts[1].get_text(strip=True)) if len(fts)>1 else “TBD”
recs = row.select(”.record”) or row.select(”[class*=‘record’]”)
f1r = parse_rec(recs[0].get_text()) if len(recs)>0 else “”
f2r = parse_rec(recs[1].get_text()) if len(recs)>1 else “”
rnks = row.select(”.rank”) or row.select(”[class*=‘rank’]”)
f1k = asc(rnks[0].get_text(strip=True)) if len(rnks)>0 else “”
f2k = asc(rnks[1].get_text(strip=True)) if len(rnks)>1 else “”
if f1n==“TBD” and f2n==“TBD”: continue
if i==0: lbl=“Main Event”
elif i==1: lbl=“Co-Main”
elif i<5: lbl=“Main Card”
else: lbl=“Prelim”
fights.append({“label”:lbl,“wc”:wc,“title”:title,
“winner”:None,“method”:None,“round”:None,“state”:“pre”,
“f1”:{“name”:f1n,“record”:f1r,“ranking”:f1k},
“f2”:{“name”:f2n,“record”:f2r,“ranking”:f2k}})
if len(fights)<2: return None
return {“name”:name,“date”:date_str,“venue”:venue,“location”:””,
“broadcast”:“Paramount+”,“time”:“TBD”,“fights”:fights}

def fight_js(f, comma=””):
f1, f2 = f[“f1”], f[“f2”]
odds = f.get(“odds”)
odds_s = “{f1:%d,f2:%d}” % (odds[“f1”],odds[“f2”]) if odds else “null”
f1s = json.dumps(f1.get(“stats”)) if f1.get(“stats”) else “null”
f2s = json.dumps(f2.get(“stats”)) if f2.get(“stats”) else “null”
return (”      {lbl:%s,wc:%s,title:%s,odds:%s,winner:%s,method:%s,round:%s,state:%s,”
“f1:{n:%s,r:%s,rk:%s,s:%s},f2:{n:%s,r:%s,rk:%s,s:%s}}%s”) % (
json.dumps(f[“label”]), json.dumps(f[“wc”]),
“true” if f[“title”] else “false”, odds_s,
json.dumps(f.get(“winner”) or “”), json.dumps(f.get(“method”) or “”),
str(f.get(“round”) or “null”), json.dumps(f.get(“state”) or “pre”),
json.dumps(f1[“name”]), json.dumps(f1.get(“record”,””)),
json.dumps(f1.get(“ranking”,””)), f1s,
json.dumps(f2[“name”]), json.dumps(f2.get(“record”,””)),
json.dumps(f2.get(“ranking”,””)), f2s, comma)

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
out.append(”    time:” + json.dumps(ev.get(“time”,“TBD”)) + “,”)
out.append(”    fights:[”)
fs = ev.get(“fights”,[])
for fi, f in enumerate(fs):
out.append(fight_js(f, “,” if fi<len(fs)-1 else “”))
out.append(”    ]”)
out.append(”  }” + c)
out.append(”];”)
return “\n”.join(out)

def build(events, label):
p = Path(“index.html”) if Path(“index.html”).exists() else Path(“template.html”)
tmpl = p.read_text(encoding=“utf-8”)
js = events_js(events)
out = re.sub(r”var EVENTS\s*=\s*[.*?];”, js, tmpl, flags=re.DOTALL)
out = re.sub(’Updated <span id="updateDate">[^<]*</span>’,
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

def fmt(dt):
return str(dt.day) + dt.strftime(” %b %Y”)

def main():
fight_night = is_fight_night()
print(“Fight night:”, fight_night, file=sys.stderr)
espn = fetch_espn()
print(“Scraping Tapology…”, file=sys.stderr)
urls = get_urls()
print(“URLs found:”, len(urls), file=sys.stderr)
events = []
for url in urls:
ev = scrape_event(url)
if ev:
print(“OK:”, ev[“name”], file=sys.stderr)
events.append(ev)
time.sleep(1)
events.sort(key=lambda e: e[“date”])
if not events:
print(“No events found”, file=sys.stderr)
sys.exit(0)
events = inject(events, espn)
label = fmt(datetime.now(timezone.utc))
html = build(events, label)
ok, reason = validate(html)
if not ok:
print(“Validation failed:”, reason, file=sys.stderr)
sys.exit(0)
Path(“index.html”).write_text(html, encoding=“utf-8”)
print(“Done:”, len(events), “events”, file=sys.stderr)

if **name** == “**main**”:
main()