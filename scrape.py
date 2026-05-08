#!/usr/bin/env python3
"""
UFC Fight Card Scraper
Fetches upcoming event data from Tapology (most reliable free source)
and writes a fresh index.html using the dashboard template.
"""

import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; UFC-Dashboard-Bot/1.0)"
}

TAPOLOGY_BASE = "https://www.tapology.com"
TAPOLOGY_EVENTS = "https://www.tapology.com/fightcenter"

LABEL_MAP = {
    0: "Main Event",
    1: "Co-Main Event",
}

WEIGHT_CLASSES = {
    "265": "Heavyweight",
    "205": "Light Heavyweight",
    "185": "Middleweight",
    "170": "Welterweight",
    "155": "Lightweight",
    "145": "Featherweight",
    "135": "Bantamweight",
    "125": "Flyweight",
    "115": "Women's Strawweight",
    "125w": "Women's Flyweight",
    "135w": "Women's Bantamweight",
    "145w": "Women's Featherweight",
}


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
    """Extract W-L or W-L-D from strings like '15-0-0' or '(15-0-0)'"""
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
    # Fallback: title-case the raw string
    return raw.title() if raw else "Catchweight"


def scrape_upcoming_events(days_ahead=65):
    """Return list of upcoming UFC event URLs from Tapology within days_ahead."""
    soup = get_soup(TAPOLOGY_EVENTS)
    if not soup:
        return []

    cutoff = datetime.now(timezone.utc) + timedelta(days=days_ahead)
    event_links = []

    for link in soup.select("a[href*='/fightcenter/events/']"):
        href = link.get("href", "")
        if "/fightcenter/events/" not in href:
            continue
        full = TAPOLOGY_BASE + href if href.startswith("/") else href
        if full not in event_links:
            event_links.append(full)

    # Deduplicate while preserving order
    seen = set()
    unique = []
    for url in event_links:
        if url not in seen:
            seen.add(url)
            unique.append(url)

    return unique[:12]  # Scrape up to 12 candidate events


def scrape_event(url):
    """Scrape a single Tapology event page and return structured data or None."""
    print(f"  Scraping: {url}", file=sys.stderr)
    soup = get_soup(url)
    if not soup:
        return None

    # Event name
    name_el = soup.select_one("h1.border-b") or soup.select_one("h1")
    name = name_el.get_text(strip=True) if name_el else ""
    if not name or "ufc" not in name.lower():
        return None

    # Date
    date_str = ""
    date_el = soup.find("span", string=re.compile(r"\d{4}")) or \
              soup.find(attrs={"data-date": True})
    if date_el:
        raw_date = date_el.get("data-date") or date_el.get_text(strip=True)
        try:
            # Try ISO format first
            dt = datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
            date_str = dt.strftime("%Y-%m-%d")
        except Exception:
            # Try common formats
            for fmt in ("%B %d, %Y", "%b %d, %Y", "%m/%d/%Y"):
                try:
                    dt = datetime.strptime(raw_date.strip(), fmt)
                    date_str = dt.strftime("%Y-%m-%d")
                    break
                except Exception:
                    continue

    # Check date is within range
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

    # Venue / location
    venue, location = "", ""
    venue_el = soup.select_one(".eventVenue") or soup.find(string=re.compile(r"Arena|Center|Apex|Prudential|Galaxy|White House", re.I))
    if venue_el:
        venue = venue_el.get_text(strip=True) if hasattr(venue_el, "get_text") else str(venue_el)

    # Broadcast
    broadcast = "Paramount+"
    for el in soup.find_all(string=re.compile(r"Paramount|ESPN|Pay-Per-View|PPV|CBS", re.I)):
        text = el.strip()
        if "paramount" in text.lower():
            broadcast = "Paramount+"
            break
        if "espn" in text.lower():
            broadcast = "ESPN+"
            break

    # Main card time — look for "Main Card" time patterns
    main_card_time = ""
    for el in soup.find_all(string=re.compile(r"Main Card", re.I)):
        parent = el.parent if hasattr(el, "parent") else None
        if parent:
            sibling_text = parent.get_text()
            time_match = re.search(r"(\d{1,2}:\d{2}\s*(?:AM|PM)\s*(?:ET|EDT|EST|PT|PDT)?)", sibling_text, re.I)
            if time_match:
                main_card_time = time_match.group(1).strip()
                break

    # Fights — find fight rows
    fights = []
    fight_rows = soup.select(".fightCard li") or soup.select("li.event")

    for i, row in enumerate(fight_rows):
        # Weight class
        wc_el = row.select_one(".weight") or row.select_one("[class*='weight']")
        wc_raw = wc_el.get_text(strip=True) if wc_el else ""
        weight_class = normalize_weight_class(wc_raw)

        # Title fight detection
        title_text = row.get_text().lower()
        title_fight = "title" in title_text or "championship" in title_text

        # Fighter names and records
        fighters = row.select(".name") or row.select("[class*='fighter']") or row.select("a[href*='/fighters/']")
        f1_name, f2_name = "TBD", "TBD"
        f1_record, f2_record = "", ""
        f1_ranking, f2_ranking = "", ""

        if len(fighters) >= 2:
            f1_name = fighters[0].get_text(strip=True)
            f2_name = fighters[1].get_text(strip=True)

        # Records
        records = row.select(".record") or row.select("[class*='record']")
        if len(records) >= 1:
            f1_record = parse_record(records[0].get_text())
        if len(records) >= 2:
            f2_record = parse_record(records[1].get_text())

        # Rankings
        ranks = row.select(".rank") or row.select("[class*='rank']")
        if len(ranks) >= 1:
            f1_ranking = ranks[0].get_text(strip=True)
        if len(ranks) >= 2:
            f2_ranking = ranks[1].get_text(strip=True)

        if f1_name == "TBD" and f2_name == "TBD":
            continue  # Skip empty rows

        # Label
        if i == 0:
            label = "Main Event"
        elif i == 1:
            label = "Co-Main Event"
        else:
            # Rough heuristic: first 5 fights = Main Card, rest = Prelim
            label = "Main Card" if i < 5 else "Prelim"

        fights.append({
            "label": label,
            "weightClass": weight_class,
            "titleFight": title_fight,
            "fighter1": {"name": f1_name, "record": f1_record, "ranking": f1_ranking},
            "fighter2": {"name": f2_name, "record": f2_record, "ranking": f2_ranking},
        })

    if not fights:
        print(f"  No fights found for {name}, skipping", file=sys.stderr)
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


def events_to_js(events, updated):
    """Serialize events list to the JS var EVENTS = [...] block."""
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
                f'      {{ label:{json.dumps(f["label"])}, weightClass:{json.dumps(f["weightClass"])}, '
                f'titleFight:{"true" if f["titleFight"] else "false"}, '
                f'fighter1:{{name:{json.dumps(f1["name"])}, record:{json.dumps(f1.get("record",""))}, ranking:{json.dumps(f1.get("ranking",""))}}}, '
                f'fighter2:{{name:{json.dumps(f2["name"])}, record:{json.dumps(f2.get("record",""))}, ranking:{json.dumps(f2.get("ranking",""))}}}'
                f'}}{comma_f}'
            )
        lines.append("    ]")
        lines.append(f"  }}{comma_ev}")
    lines.append("];")
    return "\n".join(lines)


def build_html(events, updated_label):
    template = Path("template.html").read_text()
    js_block = events_to_js(events, updated_label)

    # Inject events data
    output = re.sub(
        r"var EVENTS = \[.*?\];",
        js_block,
        template,
        flags=re.DOTALL,
    )

    # Inject updated date label (two places in the template)
    output = output.replace("{{UPDATED}}", updated_label)

    return output


def main():
    print("Fetching upcoming UFC events...", file=sys.stderr)
    event_urls = scrape_upcoming_events(days_ahead=65)
    print(f"Found {len(event_urls)} candidate event URLs", file=sys.stderr)

    events = []
    for url in event_urls:
        ev = scrape_event(url)
        if ev:
            print(f"  OK: {ev['name']} ({ev['date']})", file=sys.stderr)
            events.append(ev)
        time.sleep(1)  # polite delay between requests

    # Sort by date
    events.sort(key=lambda e: e["date"])

    if not events:
        print("No events scraped — keeping existing index.html unchanged", file=sys.stderr)
        sys.exit(0)

    updated_label = datetime.now(timezone.utc).strftime("%-d %b %Y")
    html = build_html(events, updated_label)

    Path("index.html").write_text(html)
    print(f"Wrote index.html with {len(events)} events", file=sys.stderr)


if __name__ == "__main__":
    main()
