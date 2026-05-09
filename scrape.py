#!/usr/bin/env python3
“”“UFC Fight Card Scraper v3 - ASCII only, no unicode chars anywhere.”””

import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

HEADERS = {“User-Agent”: “Mozilla/5.0 (compatible; UFC-Dashboard-Bot/1.0)”}
TAPOLOGY_BASE = “https://www.tapology.com”
TAPOLOGY_EVENTS = “https://www.tapology.com/fightcenter”
ESPN_SCOREBOARD = “https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard”

def get_json(url, retries=3, delay=2):
for attempt in range(retries):
try:
r = requests.get(url, headers=HEADERS, timeout=15)
r.raise_for_status()
return r.json()
except Exception as e:
print(”  Attempt %d failed %s: %s” % (attempt + 1, url, e), file=sys.stderr)
if attempt < retries - 1:
time.sleep(delay)
return None

def get_soup(url, retries=3, delay=2):
for attempt in range(retries):
try:
r = requests.get(url, headers=HEADERS, timeout=15)
r.raise_for_status()
return BeautifulSoup(r.text, “html.parser”)
except Exception as e:
print(”  Attempt %d failed %s: %s” % (attempt + 1, url, e), file=sys.stderr)
if attempt < retries - 1:
time.sleep(delay)
return None

def sanitize(text):
if not text:
return “”
out = []
for c in text:
if ord(c) < 128:
out.append(c)
# drop anything non-ASCII
return “”.join(out).replace(”\”, “”).replace(”`”, “”).replace(”\r”, “”).replace(”\n”, “ “).strip()

def parse_record(text):
m = re.search(r”(\d+)-(\d+)(?:-(\d+))?”, text or “”)
if not m:
return “”
w, l, d = m.group(1), m.group(2), m.group(3)
return “%s-%s-%s” % (w, l, d) if (d and d != “0”) else “%s-%s” % (w, l)

def normalize_weight_class(raw):
raw = (raw or “”).lower().strip()
if “heavyweight” in raw and “light” not in raw:
return “Heavyweight”
if “light heavyweight” in raw:
return “Light Heavyweight”
if “middleweight” in raw:
return “Middleweight”
if “welterweight” in raw:
return “Welterweight”
if “lightweight” in raw:
return “Lightweight”
if “featherweight” in raw and “women” not in raw:
return “Featherweight”
if “bantamweight” in raw and “women” not in raw:
return “Bantamweight”
if “flyweight” in raw and “women” not in raw:
return “Flyweight”
if “strawweight” in raw:
return “Women’s Strawweight”
if “women” in raw and “flyweight” in raw:
return “Women’s Flyweight”
if “women” in raw and “bantamweight” in raw:
return “Women’s Bantamweight”
if “women” in raw and “featherweight” in raw:
return “Women’s Featherweight”
return raw.title() if raw else “Catchweight”

def name_match(a, b):
“”“Fuzzy last-name match for fighter name reconciliation.”””
def last(n):
return n.strip().split()[-1].lower() if n.strip() else “”
def norm(n):
return re.sub(r”[^a-z]”, “”, n.lower())
a_last, b_last = last(a), last(b)
return a_last == b_last or norm(a) in norm(b) or norm(b) in norm(a)

def fetch_espn_results():
“”“Pull completed and in-progress fights from ESPN MMA scoreboard.”””
print(”  Fetching ESPN live results…”, file=sys.stderr)
data = get_json(ESPN_SCOREBOARD)
if not data:
return []

```
results = []
for event in data.get("events", []):
    for comp in event.get("competitions", []):
        status = comp.get("status", {}).get("type", {})
        state = status.get("state", "")
        if state not in ("in", "post"):
            continue

        competitors = comp.get("competitors", [])
        if len(competitors) < 2:
            continue

        winner = None
        loser = None
        for c in competitors:
            if c.get("winner"):
                winner = c
            else:
                loser = c

        if not winner or not loser:
            results.append({
                "f1_name": competitors[0].get("athlete", {}).get("displayName", ""),
                "f2_name": competitors[1].get("athlete", {}).get("displayName", ""),
                "winner": None,
                "method": None,
                "round": None,
                "state": state,
            })
            continue

        status_detail = status.get("detail", "")
        method = None
        rnd = None

        method_match = re.search(
            r"(KO|TKO|KO/TKO|Submission|Decision|Split Decision|"
            r"Unanimous Decision|Majority Decision|Technical Submission|DQ)",
            status_detail, re.I
        )
        if method_match:
            method = method_match.group(1)

        round_match = re.search(r"Round\s*(\d+)", status_detail, re.I)
        if round_match:
            rnd = int(round_match.group(1))

        winner_name = winner.get("athlete", {}).get("displayName", "")
        loser_name = loser.get("athlete", {}).get("displayName", "")

        results.append({
            "f1_name": winner_name,
            "f2_name": loser_name,
            "winner": winner_name,
            "method": method or "Decision",
            "round": rnd,
            "state": state,
        })

print("  ESPN results: %d completed/live fights" % len(results), file=sys.stderr)
return results
```

def match_results_to_events(events, espn_results):
“”“Inject ESPN results into matching fights in events list.”””
if not espn_results:
return events

```
for ev in events:
    for fight in ev.get("fights", []):
        f1 = fight["fighter1"]["name"]
        f2 = fight["fighter2"]["name"]

        for result in espn_results:
            r1 = result.get("f1_name", "")
            r2 = result.get("f2_name", "")
            matched = (
                (name_match(f1, r1) and name_match(f2, r2)) or
                (name_match(f1, r2) and name_match(f2, r1))
            )
            if matched:
                fight["winner"] = result.get("winner")
                fight["method"] = result.get("method")
                fight["round"] = result.get("round")
                fight["state"] = result.get("state", "post")
                print("  Matched: %s vs %s -> Winner: %s by %s" % (
                    f1, f2, result.get("winner"), result.get("method")
                ), file=sys.stderr)
                break

return events
```

def scrape_upcoming_events(days_ahead=65):
soup = get_soup(TAPOLOGY_EVENTS)
if not soup:
return []

```
event_links = []
for link in soup.select("a[href*='/fightcenter/events/']"):
    href = link.get("href", "")
    if "/fightcenter/events/" not in href:
        continue
    full = TAPOLOGY_BASE + href if href.startswith("/") else href
    if full not in event_links:
        event_links.append(full)

seen = set()
unique = []
for url in event_links:
    if url not in seen:
        seen.add(url)
        unique.append(url)

return unique[:12]
```

def scrape_event(url):
print(”  Scraping: %s” % url, file=sys.stderr)
soup = get_soup(url)
if not soup:
return None

```
name_el = soup.select_one("h1.border-b") or soup.select_one("h1")
name = sanitize(name_el.get_text(strip=True)) if name_el else ""
if not name or "ufc" not in name.lower():
    return None

date_str = ""
date_el = (soup.find(attrs={"data-date": True}) or
           soup.find("span", string=re.compile(r"\d{4}")))
if date_el:
    raw_date = date_el.get("data-date") or date_el.get_text(strip=True)
    try:
        dt = datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
        date_str = dt.strftime("%Y-%m-%d")
    except Exception:
        for fmt in ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y"):
            try:
                dt = datetime.strptime(raw_date.strip(), fmt)
                date_str = dt.strftime("%Y-%m-%d")
                break
            except Exception:
                continue

if not date_str:
    return None

try:
    ev_date = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)
    if ev_date < now - timedelta(days=1) or ev_date > now + timedelta(days=65):
        return None
except Exception:
    pass

venue = ""
venue_el = soup.select_one(".eventVenue")
if venue_el:
    venue = sanitize(venue_el.get_text(strip=True))

fights = []
fight_rows = soup.select(".fightCard li") or soup.select("li.event")

for i, row in enumerate(fight_rows):
    wc_el = row.select_one(".weight") or row.select_one("[class*='weight']")
    wc_raw = wc_el.get_text(strip=True) if wc_el else ""
    weight_class = normalize_weight_class(wc_raw)

    title_text = row.get_text().lower()
    title_fight = "title" in title_text or "championship" in title_text

    fighters = row.select(".name") or row.select("a[href*='/fighters/']")
    f1_name, f2_name = "TBD", "TBD"
    f1_record, f2_record = "", ""
    f1_ranking, f2_ranking = "", ""

    if len(fighters) >= 2:
        f1_name = sanitize(fighters[0].get_text(strip=True))
        f2_name = sanitize(fighters[1].get_text(strip=True))

    records = row.select(".record") or row.select("[class*='record']")
    if len(records) >= 1:
        f1_record = parse_record(records[0].get_text())
    if len(records) >= 2:
        f2_record = parse_record(records[1].get_text())

    ranks = row.select(".rank") or row.select("[class*='rank']")
    if len(ranks) >= 1:
        f1_ranking = sanitize(ranks[0].get_text(strip=True))
    if len(ranks) >= 2:
        f2_ranking = sanitize(ranks[1].get_text(strip=True))

    if f1_name == "TBD" and f2_name == "TBD":
        continue

    if i == 0:
        label = "Main Event"
    elif i == 1:
        label = "Co-Main"
    else:
        label = "Main Card" if i < 5 else "Prelim"

    fights.append({
        "label": label,
        "weightClass": weight_class,
        "titleFight": title_fight,
        "winner": None,
        "method": None,
        "round": None,
        "state": "pre",
        "fighter1": {"name": f1_name, "record": f1_record, "ranking": f1_ranking},
        "fighter2": {"name": f2_name, "record": f2_record, "ranking": f2_ranking},
    })

if len(fights) < 2:
    print("  Too few fights for %s, skipping" % name, file=sys.stderr)
    return None

return {
    "name": name,
    "date": date_str,
    "venue": venue,
    "location": "",
    "broadcast": "Paramount+",
    "mainCardTime": "TBD",
    "fights": fights,
}
```

def fight_to_js(f, comma=””):
“”“Serialize one fight to a JS object literal line.”””
f1 = f[“fighter1”]
f2 = f[“fighter2”]
winner = json.dumps(f.get(“winner”) or “”)
method = json.dumps(f.get(“method”) or “”)
rnd = str(f.get(“round”) or “null”)
state = json.dumps(f.get(“state”) or “pre”)

```
f1_stats = f1.get("stats", None)
f2_stats = f2.get("stats", None)
f1s = json.dumps(f1_stats) if f1_stats else "null"
f2s = json.dumps(f2_stats) if f2_stats else "null"

odds = f.get("odds")
odds_str = "null"
if odds:
    odds_str = "{f1:%d,f2:%d}" % (odds["f1"], odds["f2"])

return (
    "      {"
    + "lbl:" + json.dumps(f["label"]) + ","
    + "wc:" + json.dumps(f["weightClass"]) + ","
    + "title:" + ("true" if f["titleFight"] else "false") + ","
    + "odds:" + odds_str + ","
    + "winner:" + winner + ","
    + "method:" + method + ","
    + "round:" + rnd + ","
    + "state:" + state + ","
    + "f1:{n:" + json.dumps(f1["name"])
    + ",r:" + json.dumps(f1.get("record", ""))
    + ",rk:" + json.dumps(f1.get("ranking", ""))
    + ",s:" + f1s + "},"
    + "f2:{n:" + json.dumps(f2["name"])
    + ",r:" + json.dumps(f2.get("record", ""))
    + ",rk:" + json.dumps(f2.get("ranking", ""))
    + ",s:" + f2s + "}}"
    + comma
)
```

def events_to_js(events):
lines = [“var EVENTS=[”]
for ei, ev in enumerate(events):
comma = “,” if ei < len(events) - 1 else “”
lines.append(”  {”)
lines.append(”    name:” + json.dumps(ev[“name”]) + “,”)
lines.append(”    date:” + json.dumps(ev[“date”]) + “,”)
lines.append(”    venue:” + json.dumps(ev.get(“venue”, “”)) + “,”)
lines.append(”    loc:” + json.dumps(ev.get(“location”, “”)) + “,”)
lines.append(”    tv:” + json.dumps(ev.get(“broadcast”, “Paramount+”)) + “,”)
lines.append(”    time:” + json.dumps(ev.get(“mainCardTime”, “TBD”)) + “,”)
lines.append(”    fights:[”)
fights = ev.get(“fights”, [])
for fi, f in enumerate(fights):
fc = “,” if fi < len(fights) - 1 else “”
lines.append(fight_to_js(f) + fc)
lines.append(”    ]”)
lines.append(”  }” + comma)
lines.append(”];”)
return “\n”.join(lines)

def build_html(events, updated_label):
“”“Replace EVENTS array and timestamp in existing index.html.”””
template_path = (
Path(“index.html”) if Path(“index.html”).exists()
else Path(“template.html”)
)
template = template_path.read_text(encoding=“utf-8”)
js_block = events_to_js(events)

```
output = re.sub(
    r"var EVENTS\s*=\s*\[.*?\];",
    js_block,
    template,
    flags=re.DOTALL,
)

output = re.sub(
    r'Updated <span id="updateDate">[^<]*</span>',
    'Updated <span id="updateDate">' + updated_label + '</span>',
    output
)
output = output.replace("{{UPDATED}}", updated_label)
return output
```

def validate_html(html):
if not re.search(r”var EVENTS\s*=\s*[”, html):
return False, “EVENTS array missing”
if len(html) < 10000:
return False, “Output too small”
return True, “ok”

def is_fight_night():
“”“Check if today matches any event date in index.html.”””
try:
existing = Path(“index.html”).read_text(encoding=“utf-8”)
dates = re.findall(r’date:”(\d{4}-\d{2}-\d{2})”’, existing)
today = datetime.now(timezone.utc).strftime(”%Y-%m-%d”)
return today in dates
except Exception:
return False

def format_date(dt):
“”“Cross-platform date formatting without %-d.”””
day = str(dt.day)
return day + dt.strftime(” %b %Y”)

def format_datetime(dt):
“”“Cross-platform datetime formatting.”””
day = str(dt.day)
hour = dt.hour % 12 or 12
ampm = “AM” if dt.hour < 12 else “PM”
return “%s %s %s %d:%02d %s UTC” % (
day, dt.strftime(”%b”), dt.strftime(”%Y”), hour, dt.minute, ampm
)

def main():
fight_night = is_fight_night()
print(“Fight night mode: %s” % fight_night, file=sys.stderr)

```
espn_results = fetch_espn_results()

print("Fetching upcoming UFC events from Tapology...", file=sys.stderr)
event_urls = scrape_upcoming_events(days_ahead=65)
print("Found %d candidate URLs" % len(event_urls), file=sys.stderr)

events = []
for url in event_urls:
    ev = scrape_event(url)
    if ev:
        print("  OK: %s (%s)" % (ev["name"], ev["date"]), file=sys.stderr)
        events.append(ev)
    time.sleep(1)

events.sort(key=lambda e: e["date"])

if not events:
    print("No events scraped -- keeping existing index.html", file=sys.stderr)
    sys.exit(0)

events = match_results_to_events(events, espn_results)

now_utc = datetime.now(timezone.utc)
if fight_night and espn_results:
    updated_label = format_datetime(now_utc)
else:
    updated_label = format_date(now_utc)

html = build_html(events, updated_label)

ok, reason = validate_html(html)
if not ok:
    print("Validation failed (%s) -- keeping existing index.html" % reason, file=sys.stderr)
    sys.exit(0)

Path("index.html").write_text(html, encoding="utf-8")
result_count = sum(
    1 for e in events for f in e["fights"] if f.get("winner")
)
print("Wrote index.html: %d events, %d results" % (len(events), result_count), file=sys.stderr)
```

if **name** == “**main**”:
main()