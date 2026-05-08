#!/usr/bin/env python3
"""
UFC Fight Card Scraper
Fetches upcoming event data from Tapology and updates index.html via template.
Falls back to keeping the existing index.html if scraping fails or returns bad data.
"""

import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; UFC-Dashboard-Bot/1.0)"}
TAPOLOGY_BASE = "https://www.tapology.com"
TAPOLOGY_EVENTS = "https://www.tapology.com/fightcenter"


def get_soup(url, retries=3, delay=2):
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            r.raise_for_status()
            return BeautifulSoup(r.text, "html.parser")
        except Exception as e:
            print(f"  Attempt {attempt+1} failed for {url}: {e}", file=sys.stderr)
            if attempt < retries - 1:
                time.sleep(delay)
    return None


def parse_record(text):
    m = re.search(r"(\d+)-(\d+)(?:-(\d+))?", text or "")
    if not m:
        return ""
    w, l, d = m.group(1), m.group(2), m.group(3)
    if d and d != "0":
        return f"{w}-{l}-{d}"
    return f"{w}-{l}"


def normalize_weight_class(raw):
    raw = (raw or "").lower().strip()
    if "heavyweight" in raw and "light" not in raw:
        return "Heavyweight"
    if "light heavyweight" in raw:
        return "Light Heavyweight"
    if "middleweight" in raw:
        return "Middleweight"
    if "welterweight" in raw:
        return "Welterweight"
    if "lightweight" in raw:
        return "Lightweight"
    if "featherweight" in raw and "women" not in raw:
        return "Featherweight"
    if "bantamweight" in raw and "women" not in raw:
        return "Bantamweight"
    if "flyweight" in raw and "women" not in raw:
        return "Flyweight"
    if "strawweight" in raw:
        return "Women's Strawweight"
    if "women" in raw and "flyweight" in raw:
        return "Women's Flyweight"
    if "women" in raw and "bantamweight" in raw:
        return "Women's Bantamweight"
    if "women" in raw and "featherweight" in raw:
        return "Women's Featherweight"
    return raw.title() if raw else "Catchweight"


def sanitize(text):
    """Remove characters that could break JS string literals."""
    if not text:
        return ""
    # Remove backslashes, backticks, and control characters
    text = text.replace("\\", "").replace("`", "").replace("\r", "").replace("\n", " ")
    return text.strip()


def scrape_upcoming_events(days_ahead=65):
    soup = get_soup(TAPOLOGY_EVENTS)
    if not soup:
        return []

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


def scrape_event(url):
    print(f"  Scraping: {url}", file=sys.stderr)
    soup = get_soup(url)
    if not soup:
        return None

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

    location = ""
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
            label = "Co-Main Event"
        else:
            label = "Main Card" if i < 5 else "Prelim"

        fights.append({
            "label": label,
            "weightClass": weight_class,
            "titleFight": title_fight,
            "fighter1": {"name": f1_name, "record": f1_record, "ranking": f1_ranking},
            "fighter2": {"name": f2_name, "record": f2_record, "ranking": f2_ranking},
        })

    # Must have at least a main event and co-main to be usable
    if len(fights) < 2:
        print(f"  Too few fights found for {name}, skipping", file=sys.stderr)
        return None

    return {
        "name": name,
        "date": date_str,
        "venue": venue,
        "location": location,
        "broadcast": broadcast,
        "mainCardTime": main_card_time or "TBD",
        "fights": fights,
    }


def events_to_js(events):
    """Serialize events to a JS var EVENTS = [...] block using json.dumps for safe escaping."""
    lines = ["var EVENTS = ["]
    for ei, ev in enumerate(events):
        comma_ev = "," if ei < len(events) - 1 else ""
        lines.append("  {")
        lines.append(f'    name: {json.dumps(ev["name"])},')
        lines.append(f'    date: {json.dumps(ev["date"])},')
        lines.append(f'    venue: {json.dumps(ev.get("venue", ""))},')
        lines.append(f'    location: {json.dumps(ev.get("location", ""))},')
        lines.append(f'    broadcast: {json.dumps(ev.get("broadcast", "Paramount+"))},')
        lines.append(f'    mainCardTime: {json.dumps(ev.get("mainCardTime", "TBD"))},')
        lines.append("    fights: [")
        fights = ev.get("fights", [])
        for fi, f in enumerate(fights):
            comma_f = "," if fi < len(fights) - 1 else ""
            f1 = f["fighter1"]
            f2 = f["fighter2"]
            lines.append(
                f'      {{label:{json.dumps(f["label"])},weightClass:{json.dumps(f["weightClass"])},'
                f'titleFight:{"true" if f["titleFight"] else "false"},'
                f'fighter1:{{name:{json.dumps(f1["name"])},record:{json.dumps(f1.get("record",""))},ranking:{json.dumps(f1.get("ranking",""))}}},'
                f'fighter2:{{name:{json.dumps(f2["name"])},record:{json.dumps(f2.get("record",""))},ranking:{json.dumps(f2.get("ranking",""))}}}'
                f'}}{comma_f}'
            )
        lines.append("    ]")
        lines.append(f"  }}{comma_ev}")
    lines.append("];")
    return "\n".join(lines)


def build_html(events, updated_label):
    template = Path("template.html").read_text(encoding="utf-8")
    js_block = events_to_js(events)

    output = re.sub(
        r"var EVENTS = \[.*?\];",
        js_block,
        template,
        flags=re.DOTALL,
    )
    output = output.replace("{{UPDATED}}", updated_label)
    return output


def validate_html(html):
    """Basic sanity check — make sure the JS block looks intact."""
    if "var EVENTS = [" not in html:
        return False, "EVENTS array missing"
    if "function tp(" not in html:
        return False, "tp() function missing"
    if 'onclick="tp(' not in html and "onclick='tp(" not in html:
        # onclick is built dynamically in JS — not a hard failure
        pass
    return True, "ok"


def main():
    print("Fetching upcoming UFC events...", file=sys.stderr)
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
        print("No events scraped — keeping existing index.html unchanged", file=sys.stderr)
        sys.exit(0)

    updated_label = datetime.now(timezone.utc).strftime("%-d %b %Y")
    html = build_html(events, updated_label)

    # Validate before writing — don't overwrite with broken output
    ok, reason = validate_html(html)
    if not ok:
        print(f"Validation failed ({reason}) — keeping existing index.html", file=sys.stderr)
        sys.exit(0)

    Path("index.html").write_text(html, encoding="utf-8")
    print(f"Wrote index.html with {len(events)} events", file=sys.stderr)


if __name__ == "__main__":
    main()
