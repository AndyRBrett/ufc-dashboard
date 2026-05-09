#!/usr/bin/env python3
“””
UFC Fight Card Scraper - v2 with Live Results

Two-phase approach:

1. Card structure: Tapology (upcoming fights, fighters, weight classes)
1. Live results: ESPN MMA scoreboard API (fight outcomes during/after events)

The ESPN API returns completed fight results keyed by fighter name.
We match them to our EVENTS data by fuzzy name matching, then inject
winner/method into each fight object so the dashboard can show results.

Schedule (via GitHub Actions):

- Daily 9am UTC: standard card structure update
- Saturday noon-midnight ET: every 10 min (live fight night)
- Saturday midnight-2am ET: every 30 min (post-card cleanup)
  “””

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

# ─── HELPERS ────────────────────────────────────────────────────────────────

def get_json(url, retries=3, delay=2):
for attempt in range(retries):
try:
r = requests.get(url, headers=HEADERS, timeout=15)
r.raise_for_status()
return r.json()
except Exception as e:
print(f”  Attempt {attempt+1} failed {url}: {e}”, file=sys.stderr)
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
print(f”  Attempt {attempt+1} failed {url}: {e}”, file=sys.stderr)
if attempt < retries - 1:
time.sleep(delay)
return None

def sanitize(text):
if not text:
return “”
return text.replace(”\”, “”).replace(”`”, “”).replace(”\r”, “”).replace(”\n”, “ “).strip()

def parse_record(text):
m = re.search(r”(\d+)-(\d+)(?:-(\d+))?”, text or “”)
if not m:
return “”
w, l, d = m.group(1), m.group(2), m.group(3)
return f”{w}-{l}-{d}” if (d and d != “0”) else f”{w}-{l}”

def normalize_weight_class(raw):
raw = (raw or “”).lower().strip()
if “heavyweight” in raw and “light” not in raw: return “Heavyweight”
if “light heavyweight” in raw: return “Light Heavyweight”
if “middleweight” in raw: return “Middleweight”
if “welterweight” in raw: return “Welterweight”
if “lightweight” in raw: return “Lightweight”
if “featherweight” in raw and “women” not in raw: return “Featherweight”
if “bantamweight” in raw and “women” not in raw: return “Bantamweight”
if “flyweight” in raw and “women” not in raw: return “Flyweight”
if “strawweight” in raw: return “Women’s Strawweight”
if “women” in raw and “flyweight” in raw: return “Women’s Flyweight”
if “women” in raw and “bantamweight” in raw: return “Women’s Bantamweight”
if “women” in raw and “featherweight” in raw: return “Women’s Featherweight”
return raw.title() if raw else “Catchweight”

def name_match(a, b):
“”“Fuzzy last-name match for fighter name reconciliation.”””
def last(n): return n.strip().split()[-1].lower() if n.strip() else “”
def norm(n): return re.sub(r”[^a-z]”, “”, n.lower())
a_last, b_last = last(a), last(b)
return a_last == b_last or norm(a) in norm(b) or norm(b) in norm(a)

# ─── ESPN LIVE RESULTS ───────────────────────────────────────────────────────

def fetch_espn_results():
“””
Pull completed and in-progress fights from ESPN’s MMA scoreboard.
Returns a dict keyed by (winner_last_name, loser_last_name) -> result dict.
Also returns a flat list of all result dicts for name-matching.
“””
print(”  Fetching ESPN live results…”, file=sys.stderr)
data = get_json(ESPN_SCOREBOARD)
if not data:
return []

```
results = []
for event in data.get("events", []):
    for comp in event.get("competitions", []):
        status = comp.get("status", {}).get("type", {})
        state = status.get("state", "")  # "pre", "in", "post"
        if state not in ("in", "post"):
            continue

        competitors = comp.get("competitors", [])
        if len(competitors) < 2:
            continue

        # Find winner and loser
        winner = None
        loser = None
        for c in competitors:
            if c.get("winner"):
                winner = c
            else:
                loser = c

        if not winner or not loser:
            # Fight in progress or draw - still capture as "live"
            results.append({
                "f1_name": competitors[0].get("athlete", {}).get("displayName", ""),
                "f2_name": competitors[1].get("athlete", {}).get("displayName", ""),
                "winner": None,
                "method": None,
                "round": None,
                "state": state,
            })
            continue

        # Extract result details from status text
        status_detail = status.get("detail", "")
        method = None
        rnd = None

        # Parse "KO/TKO - Round 1" style strings
        method_match = re.search(
            r"(KO|TKO|KO/TKO|Submission|Decision|Split Decision|Unanimous Decision|"
            r"Majority Decision|Technical Submission|DQ|No Contest)",
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

print(f"  ESPN results: {len(results)} completed/live fights", file=sys.stderr)
return results
```

def match_results_to_events(events, espn_results):
“””
For each fight in each event, check if ESPN has a result for it.
Injects winner/method/round/state into the fight dict.
“””
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

            # Match if either fighter name pairs up
            matched = (
                (name_match(f1, r1) and name_match(f2, r2)) or
                (name_match(f1, r2) and name_match(f2, r1))
            )
            if matched:
                fight["winner"] = result.get("winner")
                fight["method"] = result.get("method")
                fight["round"] = result.get("round")
                fight["state"] = result.get("state", "post")
                print(
                    f"  Matched: {f1} vs {f2} -> "
                    f"Winner: {result.get('winner')} by {result.get('method')}",
                    file=sys.stderr
                )
                break

return events
```

# ─── TAPOLOGY CARD STRUCTURE ─────────────────────────────────────────────────

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
print(f”  Scraping: {url}”, file=sys.stderr)
soup = get_soup(url)
if not soup:
return None

```
name_el = soup.select_one("h1.border-b") or soup.select_one("h1")
name = sanitize(name_el.get_text(strip=True)) if name_el else ""
if not name or "ufc" not in name.lower():
    return None

date_str = ""
date_el = soup.find(attrs={"data-date": True}) or soup.find("span", string=re.compile(r"\d{4}"))
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

if date_str:
    try:
        ev_date = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        if ev_date < now - timedelta(days=1) or ev_date > now + timedelta(days=65):
            return None
    except Exception:
        pass
else:
    return None

venue = ""
venue_el = soup.select_one(".eventVenue")
if venue_el:
    venue = sanitize(venue_el.get_text(strip=True))

broadcast = "Paramount+"
main_card_time = ""

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
    print(f"  Too few fights for {name}, skipping", file=sys.stderr)
    return None

return {
    "name": name,
    "date": date_str,
    "venue": venue,
    "location": "",
    "broadcast": broadcast,
    "mainCardTime": main_card_time or "TBD",
    "fights": fights,
}
```

# ─── JS SERIALIZATION ────────────────────────────────────────────────────────

def fight_to_js(f, indent=”      “):
“”“Serialize a fight dict to a safe JS object literal string.”””
f1 = f[“fighter1”]
f2 = f[“fighter2”]
winner = json.dumps(f.get(“winner”) or “”)
method = json.dumps(f.get(“method”) or “”)
rnd = str(f.get(“round”) or “null”)
state = json.dumps(f.get(“state”) or “pre”)

```
# Stats (preserved from template if present, else null)
f1_stats = f1.get("stats", None)
f2_stats = f2.get("stats", None)
f1s = json.dumps(f1_stats) if f1_stats else "null"
f2s = json.dumps(f2_stats) if f2_stats else "null"

# Odds
odds = f.get("odds")
if odds:
    odds_str = "{f1:" + str(odds["f1"]) + ",f2:" + str(odds["f2"]) + "}"
else:
    odds_str = "null"

return (
    indent + "{"
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
)
```

def events_to_js(events):
lines = [“var EVENTS=[”]
for ei, ev in enumerate(events):
comma = “,” if ei < len(events) - 1 else “”
lines.append(”  {”)
lines.append(f’    name:{json.dumps(ev[“name”])},’)
lines.append(f’    date:{json.dumps(ev[“date”])},’)
lines.append(f’    venue:{json.dumps(ev.get(“venue”,””))},’)
lines.append(f’    loc:{json.dumps(ev.get(“location”,””))},’)
lines.append(f’    tv:{json.dumps(ev.get(“broadcast”,“Paramount+”))},’)
lines.append(f’    time:{json.dumps(ev.get(“mainCardTime”,“TBD”))},’)
lines.append(”    fights:[”)
fights = ev.get(“fights”, [])
for fi, f in enumerate(fights):
fc = “,” if fi < len(fights) - 1 else “”
lines.append(fight_to_js(f) + fc)
lines.append(”    ]”)
lines.append(f”  }}{comma}”)
lines.append(”];”)
return “\n”.join(lines)

def build_html(events, updated_label):
“”“Inject fresh EVENTS data and timestamp into the existing index.html.”””
template = Path(“template.html”).read_text(encoding=“utf-8”)
js_block = events_to_js(events)

```
# Replace the EVENTS array
output = re.sub(
    r"var EVENTS=\[.*?\];",
    js_block,
    template,
    flags=re.DOTALL,
)
output = output.replace("{{UPDATED}}", updated_label)
return output
```

def validate_html(html):
if “var EVENTS=[” not in html:
return False, “EVENTS array missing”
return True, “ok”

# ─── MAIN ────────────────────────────────────────────────────────────────────

def is_fight_night():
“”“True if today is a UFC event day (check against scraped dates).”””
try:
existing = Path(“index.html”).read_text(encoding=“utf-8”)
dates = re.findall(r’date:”(\d{4}-\d{2}-\d{2})”’, existing)
today = datetime.now(timezone.utc).strftime(”%Y-%m-%d”)
return today in dates
except Exception:
return False

def main():
fight_night = is_fight_night()
print(f”Fight night mode: {fight_night}”, file=sys.stderr)

```
# Always fetch live results — lightweight ESPN call
espn_results = fetch_espn_results()

# On fight night with results available, we can update quickly
# without re-scraping Tapology (saves time, avoids rate limits)
if fight_night and espn_results:
    print("Fight night: injecting ESPN results into existing card...", file=sys.stderr)
    try:
        existing_html = Path("index.html").read_text(encoding="utf-8")
        # Extract current EVENTS array from index.html
        events_match = re.search(r"var EVENTS=\[(.*?)\];", existing_html, re.DOTALL)
        if events_match:
            # Parse existing events - use a safe approach
            # We'll re-scrape Tapology but also apply ESPN results on top
            pass
    except Exception as e:
        print(f"Could not parse existing events: {e}", file=sys.stderr)

# Fetch card structure from Tapology
print("Fetching upcoming UFC events from Tapology...", file=sys.stderr)
event_urls = scrape_upcoming_events(days_ahead=65)
print(f"Found {len(event_urls)} candidate URLs", file=sys.stderr)

events = []
for url in event_urls:
    ev = scrape_event(url)
    if ev:
        print(f"  OK: {ev['name']} ({ev['date']})", file=sys.stderr)
        events.append(ev)
    time.sleep(1)

events.sort(key=lambda e: e["date"])

if not events:
    # On fight night with no Tapology data, still try to inject ESPN results
    # into the existing index.html by reading and patching it
    if espn_results:
        print("No Tapology data but have ESPN results — attempting patch...", file=sys.stderr)
    print("No events scraped — keeping existing index.html", file=sys.stderr)
    sys.exit(0)

# Inject ESPN results into scraped events
events = match_results_to_events(events, espn_results)

# Build timestamp
now_utc = datetime.now(timezone.utc)
if fight_night and espn_results:
    # Show time on fight night for real-time feel
    updated_label = now_utc.strftime("%-d %b %Y %-I:%M %p UTC")
else:
    updated_label = now_utc.strftime("%-d %b %Y")

html = build_html(events, updated_label)

ok, reason = validate_html(html)
if not ok:
    print(f"Validation failed ({reason}) — keeping existing index.html", file=sys.stderr)
    sys.exit(0)

Path("index.html").write_text(html, encoding="utf-8")
print(
    f"Wrote index.html with {len(events)} events, "
    f"{sum(1 for e in events for f in e['fights'] if f.get('winner'))} results",
    file=sys.stderr
)
```

if **name** == “**main**”:
main()