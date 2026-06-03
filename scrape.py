#!/usr/bin/env python3
"""
UFC scraper — rebuilds index.html with live fight cards, odds, and results.

Data sources:
  Wikipedia  — event cards, fight results, fighter rankings
  Odds API   — live moneylines
  UFCStats   — fighter career statistics
  Supabase   — pick data for push notifications
"""

import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ODDS_API_KEY = os.environ.get("ODDS_API_KEY", "")
ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds"
WIKI_API     = "https://en.wikipedia.org/w/api.php"
WIKI_HDR     = {
    "User-Agent": (
        "UFC-Dashboard/1.0 "
        "(https://github.com/AndyRBrett/ufc-dashboard; andyrbrett@gmail.com)"
    )
}
SUPABASE_URL  = os.environ.get("SUPABASE_URL", "https://gkccophrdqtqcowmblre.supabase.co")
SUPABASE_ANON = os.environ.get(
    "SUPABASE_ANON",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrY2"
    "NvcGhyZHF0cWNvd21ibHJlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NzAyMTAsImV4cCI6"
    "MjA5NTA0NjIxMH0.zSi-PcQL_ti5KXRq3YRQX4RbsP6HhQ5bAqh5x5kKkbE",
)
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_CLAIMS      = {"sub": "mailto:andyrbrett@gmail.com"}

MONTH_MAP = {
    m.lower(): i + 1
    for i, m in enumerate([
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ])
}
# Add 3-letter abbreviations (Jan, Feb, … Dec) used by {{dts|YYYY|Mon|DD}}
MONTH_MAP.update({
    m[:3].lower(): i + 1
    for i, m in enumerate([
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ])
})


# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------

def asc(text):
    """Transliterate accented characters to ASCII (e.g. É→E, í→i)."""
    if not text:
        return ""
    return "".join(
        c for c in unicodedata.normalize("NFKD", str(text)) if ord(c) < 128
    ).strip()


def clean(name):
    """Strip accented characters and trailing parentheticals from a name."""
    s = re.sub(r"\s*\([^)]+\)\s*$", "", str(name or "")).strip()
    return "".join(
        c for c in unicodedata.normalize("NFKD", s) if ord(c) < 128
    ).strip()


def clean_wiki(text):
    """Remove wikitext markup and return plain ASCII text."""
    if not text:
        return ""
    text = re.sub(r"\[\[([^\]|]+\|)?([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\{\{[^}]+\}\}", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\[\d+\]", "", text)
    return asc(text).strip().strip(",").strip()


def last_name(name):
    parts = clean(name).strip().split()
    return parts[-1].lower() if parts else ""


def names_match(a, b):
    """Fuzzy fighter name matching by last name or substring."""
    a2 = re.sub(r"[^a-z]", "", a.lower())
    b2 = re.sub(r"[^a-z]", "", b.lower())
    return (
        last_name(a) == last_name(b)
        or (len(a2) > 3 and a2 in b2)
        or (len(b2) > 3 and b2 in a2)
    )


def norm_method(m):
    """Normalise a fight finish description to a canonical form."""
    ml = (m or "").lower()
    if "ko" in ml or "tko" in ml:
        return "KO/TKO"
    if "submission" in ml or "sub" in ml:
        return "Submission"
    if "unanimous" in ml:
        return "Decision (Unanimous)"
    if "split" in ml:
        return "Decision (Split)"
    if "majority" in ml:
        return "Decision (Majority)"
    if "decision" in ml:
        return "Decision"
    if "dq" in ml:
        return "DQ"
    return asc(m).strip()


def norm_wc(raw):
    """Normalise a raw weight-class string to its canonical display name."""
    r = (raw or "").lower().strip()
    if "heavyweight" in r and "light" not in r:
        return "Heavyweight"
    if "light heavyweight" in r:
        return "Light Heavyweight"
    if "middleweight" in r:
        return "Middleweight"
    if "welterweight" in r:
        return "Welterweight"
    if "lightweight" in r:
        return "Lightweight"
    if "featherweight" in r and "women" not in r:
        return "Featherweight"
    if "bantamweight" in r and "women" not in r:
        return "Bantamweight"
    if "flyweight" in r and "women" not in r:
        return "Flyweight"
    if "women" in r and "featherweight" in r:
        return "Women's Featherweight"
    if "women" in r and "bantamweight" in r:
        return "Women's Bantamweight"
    if "women" in r and "flyweight" in r:
        return "Women's Flyweight"
    if "strawweight" in r:
        return "Women's Strawweight"
    if "atomweight" in r:
        return "Women's Atomweight"
    return r.title() if r else "TBD"


def fmt_update(dt):
    """Format a UTC datetime as the GENERATED_AT timestamp string."""
    h  = dt.hour % 12 or 12
    ap = "AM" if dt.hour < 12 else "PM"
    return f"{dt.day} {dt.strftime('%b')} {dt.year} {h}:{dt.minute:02d} {ap} UTC"


def parse_date_wiki(s):
    """Extract a YYYY-MM-DD date from a snippet of wikitext."""
    # Numeric month: {{dts|2026|8|15}}
    m = re.search(r"\{\{dts\|(\d{4})\|(\d{1,2})\|(\d{1,2})", s)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    # Abbreviated month: {{dts|2026|Aug|15}}
    m = re.search(
        r"\{\{dts\|(\d{4})\|([A-Za-z]{3,9})\|(\d{1,2})",
        s,
    )
    if m:
        month_num = MONTH_MAP.get(m.group(2).lower(), 0)
        if month_num:
            return f"{int(m.group(1)):04d}-{month_num:02d}-{int(m.group(3)):02d}"
    m = re.search(r"\{\{[Ss]tart date(?:\s+and\s+age)?\|(\d{4})\|(\d{1,2})\|(\d{1,2})", s)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.search(
        r"(January|February|March|April|May|June|July|August"
        r"|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})",
        s,
        re.IGNORECASE,
    )
    if m:
        return (
            f"{int(m.group(3)):04d}"
            f"-{MONTH_MAP[m.group(1).lower()]:02d}"
            f"-{int(m.group(2)):02d}"
        )
    return ""

# ---------------------------------------------------------------------------
# HTML patching
# ---------------------------------------------------------------------------

def patch_js_var(html, name, value):
    """Replace var NAME=<old>; with var NAME=<value>; in the HTML template."""
    replacement = f"var {name}={value};"
    updated = re.sub(
        rf"var {re.escape(name)}\s*=\s*.*?;",
        lambda _: replacement,
        html,
        flags=re.DOTALL,
    )
    if updated == html:
        print(f"Warning: could not patch JS var '{name}'", file=sys.stderr)
    return updated

# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def sb_get(path):
    """GET a Supabase REST API endpoint. Returns a list, or [] on error."""
    headers = {
        "apikey": SUPABASE_ANON,
        "Authorization": f"Bearer {SUPABASE_ANON}",
    }
    try:
        r = requests.get(SUPABASE_URL + path, headers=headers, timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"Supabase GET error: {e}", file=sys.stderr)
        return []

# ---------------------------------------------------------------------------
# Wikipedia
# ---------------------------------------------------------------------------

def fetch_wikitext(slug):
    """Fetch raw wikitext for a Wikipedia page, trying the API then a raw fallback."""
    sources = [
        ("API", WIKI_API, {"action": "parse", "page": slug, "prop": "wikitext", "format": "json"}),
        ("raw", "https://en.wikipedia.org/w/index.php", {"title": slug, "action": "raw"}),
    ]
    for method, url, params in sources:
        try:
            r = requests.get(url, headers=WIKI_HDR, params=params, timeout=15)
            print(f"  Wiki {method} [{slug[:40]}]: {r.status_code}", file=sys.stderr)
            if r.status_code == 200:
                wt = (
                    r.json().get("parse", {}).get("wikitext", {}).get("*", "")
                    if method == "API"
                    else r.text
                )
                if wt and len(wt) > 200:
                    print(f"  Got {len(wt)} chars", file=sys.stderr)
                    return wt
        except Exception as e:
            print(f"  Wiki error: {e}", file=sys.stderr)
        time.sleep(1)
    return ""


_US_REGIONS = re.compile(
    r"\b(Nevada|Texas|Florida|New York|New Jersey|Arizona|California|"
    r"Las Vegas|Houston|Newark|Inglewood|Sacramento|"
    r"Washington,?\s*D\.?C\.?|Canada|Vancouver|Toronto)\b",
    re.IGNORECASE,
)


def _default_main_time(loc):
    return "20:00" if _US_REGIONS.search(loc or "") else "TBD"


def _default_prelim_time(loc):
    return "17:00" if _US_REGIONS.search(loc or "") else "TBD"


def _infer_venue_loc_from_row(row, after_pos):
    """
    Extract venue and location from the row text after the event link position.
    Strips wikitext markup and tries to find a 'Venue, City' pattern.
    """
    tail = clean_wiki(row[after_pos:])
    # Remove date-like strings, standalone numbers, and TBD
    tail = re.sub(r"\b(TBD|N/A|\d{4,})\b", "", tail)
    tail = re.sub(r"\s+", " ", tail).strip().strip("|").strip()
    if not tail:
        return "TBD", "TBD"
    # Split on pipe chars (cell boundaries that survived clean_wiki) or commas
    parts = [p.strip() for p in re.split(r"[|,]", tail) if p.strip()]
    venue = parts[0] if parts else "TBD"
    loc   = parts[1] if len(parts) > 1 else "TBD"
    return venue or "TBD", loc or "TBD"


def _parse_event_table_rows(wt, now, seen):
    """
    Parse UFC events from wikitext table rows.

    Splits on row separators (|-) and searches each entire row for a date
    and a UFC event link. Scanning the full row avoids cell-splitting
    edge cases from inline styles, sort templates, and mixed formats.
    Returns list of (date, slug, name, venue, location) tuples.
    """
    results = []
    all_rows = re.split(r"^\s*\|-", wt, flags=re.MULTILINE)
    for row in all_rows:
        # Search the whole row for a date and a UFC link — no cell splitting needed
        ev_date = parse_date_wiki(row)
        if not ev_date:
            continue

        # Prefer a wikilinked event name; fall back to plain-text cell value
        lm = re.search(r"\[\[(UFC[^\]\|#]+?)(?:\|([^\]]+))?\]\]", row)
        if lm:
            slug_raw  = lm.group(1).strip()
            display   = (lm.group(2) or slug_raw).strip()
            after_pos = lm.end()
        else:
            # Match a plain (unlinked) UFC event name at the start of a cell
            pm = re.search(
                r"(?:^|\|)\s*(UFC\s+(?:Fight\s+Night|[A-Z][a-z]*(?:\s+[A-Z][a-z]*)*\s*)?\d+[^\n|]*)",
                row, re.MULTILINE
            )
            if not pm:
                continue
            slug_raw  = pm.group(1).strip()
            display   = slug_raw
            after_pos = pm.end()

        if ":" not in slug_raw and not re.search(r"\d", slug_raw):
            continue

        slug    = slug_raw.replace(" ", "_")
        ev_name = clean_wiki(display)
        if not ev_name.startswith("UFC"):
            ev_name = slug_raw.replace("_", " ")

        if slug in seen:
            continue
        try:
            ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if ed < now - timedelta(days=2) or ed > now + timedelta(days=120):
            continue

        # Best-effort venue/location: strip wikitext from the row and split on commas
        venue, loc = _infer_venue_loc_from_row(row, after_pos)

        seen.add(slug)
        results.append((ev_date, slug, asc(ev_name), venue, loc))
        print(f"  Discovered: {ev_name} ({ev_date})", file=sys.stderr)
    return results


def discover_upcoming_events(now):
    """
    Discover upcoming UFC events from Wikipedia.

    Primary source: List_of_UFC_events (has a dedicated Upcoming section).
    Fallback: YYYY_in_UFC pages for the current year and next year (handles
    year-boundary when the 90-day window crosses into January).

    Returns list of (date, slug, name, venue, location) tuples sorted by date.
    """
    seen   = set()
    events = []

    # Primary: canonical events list — isolate the Upcoming section
    wt = fetch_wikitext("List_of_UFC_events")
    if wt:
        m = re.search(r"==+\s*(?:Upcoming|Scheduled)\s+events?\s*==+", wt, re.IGNORECASE)
        if m:
            tail    = wt[m.end():]
            end_m   = re.search(r"==+[^=]", tail)
            section = tail[:end_m.start()] if end_m else tail
        else:
            section = wt
        events.extend(_parse_event_table_rows(section, now, seen))

    # Fallback: year pages only if primary source found nothing.
    # Note: YYYY_in_UFC pages use {{Year in UFC}} template-based layout which
    # stores event data as named parameters, not as parseable table rows.
    # Only attempt if the primary source failed entirely.
    if not events:
        years = {now.year}
        if (now + timedelta(days=90)).year != now.year:
            years.add(now.year + 1)
        for year in sorted(years):
            wt = fetch_wikitext(f"{year}_in_UFC")
            if wt:
                events.extend(_parse_event_table_rows(wt, now, seen))
            time.sleep(1)

    if not events:
        print("Auto-discovery: no events found from Wikipedia", file=sys.stderr)

    events.sort(key=lambda x: x[0])
    return events


def fetch_rankings():
    """Fetch current UFC rankings from Wikipedia. Returns {fighter_name: rank_int}."""
    wt = fetch_wikitext("UFC_rankings")
    if not wt:
        print("Rankings: could not fetch", file=sys.stderr)
        return {}
    rankings = {}
    for m in re.finditer(
        r"^!\s*(\d{1,2})(?:\s*\([^)]*\))?\s*\n\|[^\n]*flagicon[^\n]*\n\|\s*\[\[(?:[^\]|]+\|)?([^\]]+)\]\]",
        wt,
        re.MULTILINE,
    ):
        rank = int(m.group(1))
        name = re.sub(r"\s*\([^)]*\)\s*", "", clean_wiki(m.group(2).strip())).strip()
        key  = asc(name)
        if key and 1 <= rank <= 15 and key not in rankings:
            rankings[key] = rank
    print(f"Rankings: {len(rankings)} fighters indexed", file=sys.stderr)
    return rankings


def parse_upcoming_card(wikitext):
    """Parse {{MMAevent bout}} templates from Wikipedia wikitext into fight dicts."""
    fights = []
    for block in re.finditer(
        r"\{\{MMAevent bout\s*\n(.*?)\}\}", wikitext, re.DOTALL | re.IGNORECASE
    ):
        lines = [
            line.strip().lstrip("|").strip()
            for line in block.group(1).split("\n")
            if line.strip().lstrip("|").strip()
        ]
        if len(lines) < 3:
            continue
        vs_idx  = next((i for i, l in enumerate(lines) if l.lower().strip() in ("vs.", "vs", "v.")),  -1)
        def_idx = next((i for i, l in enumerate(lines) if l.lower().strip() in ("def.", "def", "d.")), -1)
        if vs_idx > 0:
            wc_raw = lines[0]
            f1 = clean_wiki(lines[vs_idx - 1])
            f2 = clean_wiki(lines[vs_idx + 1]) if vs_idx + 1 < len(lines) else "TBD"
        elif def_idx > 0:
            wc_raw = lines[0]
            f1 = clean_wiki(lines[def_idx - 1])
            f2 = clean_wiki(lines[def_idx + 1]) if def_idx + 1 < len(lines) else ""
        else:
            continue
        def _extract_rank(name):
            if re.search(r"\(ic\)", name, re.IGNORECASE):
                return "IC"
            if re.search(r"\(c\)", name, re.IGNORECASE):
                return "C"
            return ""
        f1_rk = _extract_rank(f1)
        f2_rk = _extract_rank(f2)
        f1 = re.sub(r"\s*\((ic|c)\)\s*", "", f1, flags=re.IGNORECASE).strip()
        f2 = re.sub(r"\s*\((ic|c)\)\s*", "", f2, flags=re.IGNORECASE).strip()
        if not f1 or len(f1) < 2:
            continue
        fights.append({
            "f1":      f1,
            "f1_rk":   f1_rk,
            "f2":      f2 or "TBD",
            "f2_rk":   f2_rk,
            "wc":      norm_wc(clean_wiki(wc_raw)),
            "title":   "(c)" in block.group(1).lower(),
            "rematch": bool(re.search(r"\brematch\b", block.group(1), re.I)),
        })
    return fights


def parse_results(wikitext):
    """Parse fight results from Wikipedia wikitext. Tries MMAevent bout first, then wikitable."""
    results = _parse_results_mma_template(wikitext)
    return results or _parse_results_wikitable(wikitext)


def _parse_results_mma_template(wikitext):
    results = []
    for block in re.finditer(
        r"\{\{MMAevent bout\s*\n(.*?)\}\}", wikitext, re.DOTALL | re.IGNORECASE
    ):
        lines = [
            line.strip().lstrip("|").strip()
            for line in block.group(1).split("\n")
            if line.strip().lstrip("|").strip()
        ]
        if len(lines) < 5:
            continue
        di = next((i for i, l in enumerate(lines) if l.lower().strip() in ("def.", "def", "d.")), -1)
        if di < 1:
            continue
        winner = re.sub(r"\s*\(c\)\s*", "", clean_wiki(lines[di - 1])).strip()
        loser  = (
            re.sub(r"\s*\(c\)\s*", "", clean_wiki(lines[di + 1])).strip()
            if di + 1 < len(lines)
            else ""
        )
        method = lines[di + 2] if di + 2 < len(lines) else ""
        rnd_s  = lines[di + 3] if di + 3 < len(lines) else ""
        if not winner or not method:
            continue
        try:
            rnd = int(rnd_s.strip())
        except ValueError:
            rnd = None
        results.append({
            "winner": winner,
            "loser":  loser,
            "method": norm_method(method),
            "round":  rnd,
        })
    return results


def _parse_results_wikitable(wikitext):
    results  = []
    in_table = False
    row      = []
    for line in wikitext.split("\n"):
        s = line.strip()
        if "{|" in s and "wikitable" in s.lower():
            in_table = True
            row = []
            continue
        if s.startswith("|}"):
            if row:
                res = _flush_wikitable_row(row)
                if res:
                    results.append(res)
            in_table = False
            row = []
            continue
        if not in_table:
            continue
        if s.startswith("|-"):
            if row:
                res = _flush_wikitable_row(row)
                if res:
                    results.append(res)
            row = []
            continue
        if s.startswith("!"):
            row = []
            continue
        if s.startswith("|"):
            content = s.lstrip("|")
            if "||" in content:
                row.extend(clean_wiki(p.strip()) for p in content.split("||"))
            else:
                row.append(clean_wiki(content))
    return results


def _flush_wikitable_row(row):
    """Convert a raw wikitable row into a result dict, or None if invalid."""
    row = [clean_wiki(c) for c in row if clean_wiki(c)]
    if len(row) < 3:
        return None
    skip_headers = [
        "weight class", "winner", "method", "round",
        "main card", "preliminary", "early prelim",
    ]
    if any(h in " ".join(row).lower() for h in skip_headers):
        return None
    winner = loser = method = ""
    rnd = None
    di = next((i for i, c in enumerate(row) if c.strip().lower() in ("def.", "def", "d.")), -1)
    if di > 0:
        winner = re.sub(r"\s*\(c\)\s*", "", row[di - 1]).strip()
        loser  = re.sub(r"\s*\(c\)\s*", "", row[di + 1]).strip() if di + 1 < len(row) else ""
        rest   = row[di + 2:]
    else:
        if len(row) < 4:
            return None
        winner, loser, rest = row[1], row[2], row[3:]
    if not winner or len(winner) < 2:
        return None
    for cell in rest:
        cl = cell.lower()
        if any(k in cl for k in ["ko", "tko", "decision", "submission", "sub", "dq"]):
            if not method:
                method = cell
        elif re.match(r"^\d$", cell.strip()):
            try:
                rnd = int(cell.strip())
            except ValueError:
                pass
    if not method and winner and loser and rnd:
        method = "Decision"
    if not method:
        return None
    return {
        "winner": winner,
        "loser":  loser,
        "method": norm_method(method),
        "round":  rnd,
    }

# ---------------------------------------------------------------------------
# Odds API
# ---------------------------------------------------------------------------

def fetch_odds():
    """Fetch current MMA moneylines from The Odds API. Returns a fighter-pair index."""
    if not ODDS_API_KEY:
        print("No ODDS_API_KEY", file=sys.stderr)
        return {}
    try:
        r = requests.get(
            ODDS_API_URL,
            params={
                "apiKey": ODDS_API_KEY,
                "regions": "us",
                "markets": "h2h",
                "oddsFormat": "american",
            },
            timeout=15,
        )
        print(
            f"Odds API: {r.status_code} | remaining: {r.headers.get('x-requests-remaining', '?')}",
            file=sys.stderr,
        )
        if r.status_code != 200:
            return {}
        data = r.json()
    except Exception as e:
        print(f"Odds API error: {e}", file=sys.stderr)
        return {}

    preferred  = ["fanduel", "draftkings", "betrivers", "bovada", "betonlineag", "betus"]
    odds_index = {}
    for fight in data:
        h = clean(fight.get("home_team", ""))
        a = clean(fight.get("away_team", ""))
        if not h or not a:
            continue
        books = sorted(
            fight.get("bookmakers", []),
            key=lambda b: preferred.index(b["key"]) if b["key"] in preferred else 99,
        )
        p1, p2 = [], []
        for bm in books[:3]:
            for mkt in bm.get("markets", []):
                if mkt["key"] != "h2h":
                    continue
                for o in mkt["outcomes"]:
                    nl = o["name"].lower()
                    if h.lower() in nl or nl in h.lower():
                        p1.append(o["price"])
                    elif a.lower() in nl or nl in a.lower():
                        p2.append(o["price"])
        if p1 and p2:
            pair = tuple(sorted([h.lower(), a.lower()]))
            odds_index[pair] = {
                "f1_name": h,
                "f2_name": a,
                "f1_odds": round(sum(p1) / len(p1)),
                "f2_odds": round(sum(p2) / len(p2)),
            }
    print(f"Odds indexed: {len(odds_index)} fights", file=sys.stderr)
    return odds_index


def get_odds(odds_index, f1_name, f2_name):
    """Look up odds for a fight by fuzzy name matching. Returns {f1, f2} or None."""
    f1l    = f1_name.lower()
    f2l    = f2_name.lower()
    f1last = last_name(f1_name)
    f2last = last_name(f2_name)
    for pair, o in odds_index.items():
        n1, n2 = pair
        match_f1    = f1last in n1 or n1 in f1l or f1l in n1
        match_f2    = f2last in n2 or n2 in f2l or f2l in n2
        match_swap1 = f1last in n2 or n2 in f1l or f1l in n2
        match_swap2 = f2last in n1 or n1 in f2l or f2l in n1
        if match_f1 and match_f2:
            return {"f1": o["f1_odds"], "f2": o["f2_odds"]}
        if match_swap1 and match_swap2:
            return {"f1": o["f2_odds"], "f2": o["f1_odds"]}
    return None


def extract_existing_odds(html):
    """Read odds already embedded in the HTML to preserve them when the API has no data."""
    existing = {}
    pat = re.compile(
        r'odds:\{f1:(-?\d+),f2:(-?\d+)\}[^f]*?f1:\{n:"([^"]+)"[^}]*\},f2:\{n:"([^"]+)"'
    )
    for m in pat.finditer(html):
        f1o, f2o, f1n, f2n = int(m.group(1)), int(m.group(2)), m.group(3), m.group(4)
        key = frozenset([last_name(f1n), last_name(f2n)])
        existing[key] = {"f1_name": f1n, "f2_name": f2n, "f1_odds": f1o, "f2_odds": f2o}
    print(f"Existing odds preserved: {len(existing)} fights", file=sys.stderr)
    return existing


def extract_recent_past_events(html, now, seen):
    """
    Read events already embedded in the HTML that fall within the last 30 days
    but are NOT yet in `seen` (already discovered from Wikipedia).

    Returns a list of 5-tuples (date, slug, name, venue, location) so that
    step_build_events can re-scrape them and preserve their results.
    """
    results = []
    cutoff  = now - timedelta(days=30)
    # Match event-level fields as written by events_js (name before date)
    pat = re.compile(
        r'name:"([^"]+)",\s*\n\s*'
        r'date:"(\d{4}-\d{2}-\d{2})",\s*\n\s*'
        r'venue:"([^"]*)",\s*\n\s*'
        r'loc:"([^"]*)"'
    )
    for m in pat.finditer(html):
        ev_name, ev_date, venue, loc = m.groups()
        # Derive the Wikipedia slug from the event name
        slug = ev_name.replace(" ", "_")
        if slug in seen:
            continue
        try:
            ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if ed < cutoff or ed >= now - timedelta(days=2):
            continue
        seen.add(slug)
        results.append((ev_date, slug, ev_name, venue, loc))
        print(f"  Preserving past event: {ev_name} ({ev_date})", file=sys.stderr)
    return results


def get_odds_with_fallback(odds_index, existing_odds, f1_name, f2_name):
    """Return live odds, falling back to the odds already embedded in the HTML."""
    result = get_odds(odds_index, f1_name, f2_name)
    if result:
        return result
    key = frozenset([last_name(f1_name), last_name(f2_name)])
    o   = existing_odds.get(key)
    if not o:
        return None
    if last_name(f1_name) == last_name(o["f1_name"]):
        return {"f1": o["f1_odds"], "f2": o["f2_odds"]}
    return {"f1": o["f2_odds"], "f2": o["f1_odds"]}

# ---------------------------------------------------------------------------
# Fighter stats  (UFCStats)
# ---------------------------------------------------------------------------

_ufcstats_letter_cache = {}


def _load_ufcstats_letter(letter):
    """Fetch all fighters whose last name starts with *letter* from UFCStats. Cached."""
    letter = letter.lower()
    if letter in _ufcstats_letter_cache:
        return _ufcstats_letter_cache[letter]
    try:
        r = requests.get(
            "http://www.ufcstats.com/statistics/fighters",
            params={"char": letter, "page": "all"},
            timeout=20,
            headers={"User-Agent": "UFC-Dashboard/1.0 (github.com/AndyRBrett/ufc-dashboard)"},
        )
        if r.status_code != 200:
            print(f"  UFCStats letter page ({letter}): HTTP {r.status_code}", file=sys.stderr)
            _ufcstats_letter_cache[letter] = []
            return []
        entries = []
        for row in BeautifulSoup(r.text, "html.parser").select(
            "table.b-statistics__table tbody tr"
        ):
            cells = row.select("td")
            if len(cells) < 10:
                continue
            fl = cells[0].find("a")
            ll = cells[1].find("a")
            if not fl and not ll:
                continue
            first = fl.get_text(strip=True) if fl else ""
            last  = ll.get_text(strip=True) if ll else ""
            href  = (fl or ll).get("href", "")
            try:
                w = int(cells[7].get_text(strip=True) or 0)
                l = int(cells[8].get_text(strip=True) or 0)
                d = int(cells[9].get_text(strip=True) or 0)
            except ValueError:
                w = l = d = 0
            entries.append((first, last, href, w, l, d))
        if not entries:
            print(f"  UFCStats letter page ({letter}): 0 rows parsed — possible structure change", file=sys.stderr)
        _ufcstats_letter_cache[letter] = entries
        time.sleep(0.5)
        return entries
    except Exception as e:
        print(f"  UFCStats letter fetch error ({letter}): {e}", file=sys.stderr)
        # Don't cache the failure — allow a retry next call for this letter
        return []


def _name_tokens_match(row_first, row_last, target_name):
    """Require last-name equality and at least one first-name token match."""
    target_parts  = clean(target_name).lower().split()
    if not target_parts:
        return False
    row_f         = clean(row_first).lower()
    row_l         = clean(row_last).lower()
    target_last   = target_parts[-1]
    target_firsts = set(target_parts[:-1])
    for tl, tf in ((row_l, row_f), (row_f, row_l)):   # also handles Asian name order
        if tl == target_last:
            if not target_firsts:
                return True
            return any(t == tf or tf.startswith(t[:2]) for t in target_firsts if len(t) >= 2)
    return False


def _search_ufcstats(name):
    """Search UFCStats for *name* by last-name initial. Returns (url, record) or None."""
    parts = clean(name).split()
    if not parts:
        return None
    last = parts[-1]
    letters = [last[0].lower()]
    if len(parts) >= 2 and parts[0][0].lower() != last[0].lower():
        letters.append(parts[0][0].lower())   # fallback for Asian name ordering
    for attempt in range(2):  # one retry on empty result
        for letter in letters:
            rows = _load_ufcstats_letter(letter)
            for row_first, row_last, href, w, l, d in rows:
                if _name_tokens_match(row_first, row_last, name):
                    return (href, f"{w}-{l}-{d}" if (w or l) else "")
            if not rows and attempt == 0:
                # Letter page returned empty — clear cache and retry after a pause
                _ufcstats_letter_cache.pop(letter, None)
                time.sleep(2)
    return None


def _norm_name(n):
    """Last name, lowercased, accents stripped — for rematch cross-reference."""
    n = unicodedata.normalize("NFD", n)
    n = "".join(c for c in n if unicodedata.category(c) != "Mn")
    parts = n.strip().split()
    return parts[-1].lower() if parts else ""


def _wiki_rematch(wikitext, f1_name, f2_name):
    """Return True if the wikitext mentions a rematch between both fighters."""
    if not wikitext:
        return False
    # Search original text case-insensitively; use lowercased text for name matching
    wl = wikitext.lower()
    f1l = _norm_name(f1_name)
    f2l = _norm_name(f2_name)
    pattern = r'\b(rematch|re\-match|trilogy|rubber\s+match|II)\b'
    for m in re.finditer(pattern, wikitext, re.IGNORECASE):
        window = wl[max(0, m.start() - 1000): m.end() + 1000]
        if f1l in window and f2l in window:
            return True
    return False


def _fighter_wiki_past_fight(wikitext, opp_name):
    """Return True if the fighter's Wikipedia fight record section shows a past result against opp_name."""
    if not wikitext:
        return False
    # Normalize name parts (accent-strip + lowercase)
    _n = unicodedata.normalize("NFD", opp_name)
    _n = "".join(c for c in _n if unicodedata.category(c) != "Mn").lower()
    parts = _n.strip().split()
    last_l = parts[-1] if parts else ""
    first_l = parts[0] if len(parts) > 1 else ""
    if not last_l:
        return False
    # Locate the professional/MMA record section
    m = re.search(
        r'==\s*(?:Professional record|Mixed martial arts record|MMA record|Career statistics)\s*==',
        wikitext, re.IGNORECASE,
    )
    if not m:
        return False
    # Extract just that section (up to the next == heading)
    nxt = re.search(r'\n==\s*\w', wikitext[m.end():])
    section = wikitext[m.start(): m.end() + nxt.start() if nxt else len(wikitext)]

    if last_l not in section.lower():
        return False

    # Split into individual table rows (separated by |-) and require BOTH
    # a result keyword AND the opponent name to appear in the SAME row.
    result_pat = re.compile(r'\b(win|loss|draw|no contest|nc)\b', re.IGNORECASE)
    for row in re.split(r'\|\-', section):
        row_l = row.lower()
        if last_l not in row_l:
            continue
        if not result_pat.search(row):
            continue
        # Disambiguate common last names (e.g. "Pereira", "Silva", "Santos") by
        # requiring the full first name to also appear near the last name in the row.
        if first_l:
            idx = row_l.find(last_l)
            context = row_l[max(0, idx - 80): idx + len(last_l) + 80]
            if first_l not in context:
                continue
        return True
    return False


def fetch_fighter_stats(name, cached_url=None):
    """Fetch career stats for one fighter from UFCStats. Returns a dict or None."""
    if cached_url:
        detail_url = cached_url
        rec = ""
        print(f"  UFCStats direct [{name}]", file=sys.stderr)
    else:
        print(f"  UFCStats search [{name}]", file=sys.stderr)
        hit = _search_ufcstats(name)
        if not hit:
            print(f"  UFCStats: no match for {name}", file=sys.stderr)
            return None
        detail_url, rec = hit
        if not detail_url:
            return None

    slpm = acc = td = tdd = 0.0
    ko = sub = 0
    ht = rch = stn = dob = ""
    form = []
    opponents = []
    time.sleep(0.5)
    try:
        dr = requests.get(detail_url, timeout=15, headers={"User-Agent": "UFC-Dashboard/1.0"})
        if dr.status_code == 200:
            dsoup = BeautifulSoup(dr.text, "html.parser")
            for li in dsoup.select("li.b-list__box-list-item"):
                txt = li.get_text(strip=True)
                if ":" not in txt:
                    continue
                key, _, val = txt.partition(":")
                key     = key.strip().lower()
                raw_val = val.strip()
                val     = raw_val.replace("%", "").replace("---", "0") or "0"
                try:
                    if "slpm" in key:
                        slpm = round(float(val), 2)
                    elif "str. acc" in key or "str.acc" in key:
                        acc = int(round(float(val)))
                    elif "td avg" in key:
                        td = round(float(val), 2)
                    elif "td def" in key:
                        tdd = int(round(float(val)))
                    elif "height" in key and raw_val not in ("---", "--", ""):
                        ht = raw_val
                    elif "reach" in key and raw_val not in ("---", "--", ""):
                        rch = raw_val
                    elif "stance" in key and raw_val not in ("---", "--", ""):
                        stn = raw_val
                    elif "dob" in key and raw_val not in ("---", "--", ""):
                        dob = raw_val
                except (ValueError, TypeError):
                    pass
            for frow in dsoup.select("tbody.b-fight-details__table-body tr"):
                cells_d = frow.select("td")
                if len(cells_d) < 8:
                    continue
                result_txt = cells_d[0].get_text(strip=True).lower()
                method_txt = cells_d[7].get_text(strip=True) if len(cells_d) > 7 else ""
                ml = method_txt.lower()
                if result_txt == "win":
                    if "ko" in ml or "tko" in ml:
                        ko += 1
                    elif "sub" in ml:
                        sub += 1
                if result_txt in ("win", "loss", "draw") and len(form) < 5:
                    r_char = "W" if result_txt == "win" else ("L" if result_txt == "loss" else "D")
                    if "tko" in ml:    ms_str = "TKO"
                    elif "ko" in ml:   ms_str = "KO"
                    elif "sub" in ml:  ms_str = "Sub"
                    elif "dec" in ml:  ms_str = "Dec"
                    elif "dq" in ml:   ms_str = "DQ"
                    else:              ms_str = method_txt.strip()[:3]
                    form.append({"r": r_char, "m": ms_str})
                # Opponent name: cells_d[1] has two <a> tags — self then opponent
                opp_links = cells_d[1].select("a")
                if len(opp_links) >= 2:
                    opp_name = opp_links[1].get_text(strip=True)
                    if opp_name:
                        opponents.append(opp_name)
    except Exception as e:
        print(f"  UFCStats detail error: {e}", file=sys.stderr)

    print(
        f"  Stats {name}: slpm={slpm} acc={acc} td={td} tdd={tdd} "
        f"ko={ko} sub={sub} rec={rec} ht={ht!r} form={len(form)}",
        file=sys.stderr,
    )
    return {
        "slpm": slpm, "acc": acc, "td": td, "tdd": tdd,
        "ko": ko, "sub": sub, "rec": rec,
        "ht": ht, "rch": rch, "stn": stn, "dob": dob,
        "form": form,
        "opp": opponents,
        "url": detail_url,
    }


def extract_stats_cache(html):
    """Read the FIGHTER_STATS JSON object from the current HTML."""
    m = re.search(r"var FIGHTER_STATS=(\{.*?\});", html, re.DOTALL)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}

# ---------------------------------------------------------------------------
# Push notifications
# ---------------------------------------------------------------------------

def send_push_notifications(new_results):
    """Send win/loss push notifications for newly resolved fights."""
    if not VAPID_PRIVATE_KEY or not new_results:
        return
    try:
        from pywebpush import webpush
    except ImportError:
        print("pywebpush not installed, skipping push", file=sys.stderr)
        return
    subs  = sb_get("/rest/v1/push_subs?select=*")
    picks = sb_get("/rest/v1/picks?select=*")
    if not subs or not picks:
        return
    sub_map = {s["user_id"]: s for s in subs}
    for res in new_results:
        winner, loser = res["winner"], res["loser"]
        for pick in picks:
            f1, f2, chosen = pick["f1"], pick["f2"], pick["pick"]
            is_this_fight = (
                (names_match(f1, winner) and names_match(f2, loser))
                or (names_match(f2, winner) and names_match(f1, loser))
            )
            if not is_this_fight:
                continue
            sub = sub_map.get(pick["user_id"])
            if not sub:
                continue
            picked_winner = names_match(chosen, winner)
            title = "Your pick WON! 🔥" if picked_winner else "Tough luck ❌"
            body  = f"{winner} def. {loser}" + (" — you called it!" if picked_winner else "")
            try:
                webpush(
                    subscription_info={
                        "endpoint": sub["endpoint"],
                        "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
                    },
                    data=json.dumps({"title": title, "body": body}),
                    vapid_private_key=VAPID_PRIVATE_KEY,
                    vapid_claims=VAPID_CLAIMS,
                )
                print(f"  Push sent to {pick['nickname']}: {title}", file=sys.stderr)
            except Exception as e:
                print(f"  Push failed for {pick['nickname']}: {e}", file=sys.stderr)

# ---------------------------------------------------------------------------
# Results injection
# ---------------------------------------------------------------------------

def inject_results(js, results):
    """Inject fight results (winner, method, round, state) into the JS events block."""
    count   = 0
    pattern = r'f1:\{n:"([^"]+)"[^}]+\},f2:\{n:"([^"]+)"'
    for res in results:
        winner, loser, method, rnd = res["winner"], res["loser"], res["method"], res["round"]
        for m in re.finditer(pattern, js):
            f1n, f2n = m.group(1), m.group(2)
            f1w = names_match(f1n, winner) and (not loser or names_match(f2n, loser))
            f2w = names_match(f2n, winner) and (not loser or names_match(f1n, loser))
            if not f1w and not f2w:
                continue
            wn = f1n if f1w else f2n
            fs = js.rfind("{lbl:", 0, m.start())
            if fs < 0:
                continue
            if 'state:"post"' in js[fs:fs + 300]:
                print(f"  Already set: {wn}", file=sys.stderr)
                break
            depth = 0
            fe    = fs
            for i in range(fs, min(fs + 2000, len(js))):
                if js[i] == "{":
                    depth += 1
                elif js[i] == "}":
                    depth -= 1
                if depth == 0:
                    fe = i + 1
                    break
            fstr = js[fs:fe]
            fstr = re.sub(r'winner:"[^"]*"',     lambda _: f'winner:"{wn}"',     fstr)
            fstr = re.sub(r'method:"[^"]*"',     lambda _: f'method:"{method}"', fstr)
            fstr = re.sub(r"round:(?:null|\d+)", f"round:{rnd if rnd else 'null'}", fstr)
            fstr = re.sub(r'state:"[^"]*"',      lambda _: 'state:"post"',       fstr)
            js   = js[:fs] + fstr + js[fe:]
            print(f"  Injected: {wn} def {f2n if f1w else f1n} R{rnd}", file=sys.stderr)
            count += 1
            break
    return js, count

# ---------------------------------------------------------------------------
# JS serialisation
# ---------------------------------------------------------------------------

def fight_js(f, comma=""):
    """Serialise a single fight dict to a JS object literal string."""
    f1   = f["f1"]
    f2   = f["f2"]
    odds = f.get("odds")
    odds_s = f"{{f1:{odds['f1']},f2:{odds['f2']}}}" if odds else "null"
    rnd    = str(f.get("round") or "null")
    return (
        f"      {{lbl:{json.dumps(f.get('label', ''))},wc:{json.dumps(f.get('wc', 'TBD'))},"
        f"title:{'true' if f.get('title') else 'false'},"
        f"rematch:{'true' if f.get('rematch') else 'false'},odds:{odds_s},"
        f"winner:{json.dumps(f.get('winner', ''))},method:{json.dumps(f.get('method', ''))},"
        f"round:{rnd},state:{json.dumps(f.get('state', 'pre'))},"
        f"f1:{{n:{json.dumps(f1.get('name', 'TBD'))},r:{json.dumps(f1.get('record', ''))},"
        f"rk:{json.dumps(f1.get('ranking', ''))},s:null}},"
        f"f2:{{n:{json.dumps(f2.get('name', 'TBD'))},r:{json.dumps(f2.get('record', ''))},"
        f"rk:{json.dumps(f2.get('ranking', ''))},s:null}}}}{comma}"
    )


def events_js(evs):
    """Serialise the events list to a JS array literal (value only, no var declaration)."""
    lines = ["["]
    for ei, ev in enumerate(evs):
        c = "," if ei < len(evs) - 1 else ""
        lines += [
            "  {",
            f"    name:{json.dumps(ev['name'])},",
            f"    date:{json.dumps(ev['date'])},",
            f"    venue:{json.dumps(ev.get('venue', ''))},",
            f"    loc:{json.dumps(ev.get('loc', ''))},",
            f"    tv:{json.dumps(ev.get('tv', 'Paramount+'))},",
            f"    time:{json.dumps(ev.get('time', 'TBD'))},",
        ]
        if ev.get("prelimTime"):
            lines.append(f"    prelimTime:{json.dumps(ev['prelimTime'])},")
        lines.append("    fights:[")
        fights = ev.get("fights", [])
        for fi, fight in enumerate(fights):
            lines.append(fight_js(fight, "," if fi < len(fights) - 1 else ""))
        lines += ["    ]", f"  }}{c}"]
    lines.append("]")
    return "\n".join(lines)

# ---------------------------------------------------------------------------
# Pipeline steps
# ---------------------------------------------------------------------------

def step_inject_results(html, now):
    """
    Check Wikipedia for results from events in the past 2 days and inject them
    into the HTML. Returns (updated_html, new_results) on success, (None, [])
    if nothing changed.
    """
    ex_names = re.findall(r'name:"([^"]+)"', html)
    ex_dates = re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', html)

    js_start = html.find("<script>") + len("<script>")
    js_end   = html.rfind("</script>")
    js       = html[js_start:js_end]

    total_injected = 0
    new_results    = []

    for ev_name, ev_date in zip(ex_names, ex_dates):
        try:
            ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if ed < now - timedelta(days=4) or ed > now + timedelta(hours=6):
            continue
        print(f"Checking results: {ev_name}", file=sys.stderr)
        slug = re.sub(r"[^a-zA-Z0-9 :._-]", "", ev_name).replace(" ", "_")
        wt   = fetch_wikitext(slug)
        if not wt:
            continue
        results = parse_results(wt)
        if results:
            js, n = inject_results(js, results)
            total_injected += n
            new_results.extend(results)
        time.sleep(1)

    if not total_injected:
        return None, []

    updated = html[:js_start] + js + html[js_end:]
    updated = patch_js_var(updated, "GENERATED_AT", f'"{fmt_update(now)}"')
    return updated, new_results


def step_build_events(html, now):
    """
    Rebuild the EVENTS block from Wikipedia and The Odds API, refresh fighter
    stats, and update rankings. Returns the updated HTML string.
    """
    print("Fetching odds...", file=sys.stderr)
    existing_odds = extract_existing_odds(html)
    odds_index    = fetch_odds()

    print("Building events from Wikipedia...", file=sys.stderr)
    discovered = discover_upcoming_events(now)
    seen_slugs = {slug for _, slug, *_ in discovered}

    # Include recent past events from the current HTML that Wikipedia's "Scheduled"
    # section no longer lists — ensures results for events in the last 30 days are
    # preserved when the EVENTS array is rebuilt.
    past = extract_recent_past_events(html, now, seen_slugs)

    merged = [
        (ev_date, slug, ev_name, venue, loc,
         _default_main_time(loc), _default_prelim_time(loc))
        for ev_date, slug, ev_name, venue, loc in (discovered + past)
    ]
    merged.sort(key=lambda x: x[0])

    new_events = []
    for ev_date, slug, ev_name, venue, loc, main_time, prelim_time in merged:
        try:
            ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if ed < now - timedelta(days=30) or ed > now + timedelta(days=90):
            continue
        print(f"Fetching: {ev_name}", file=sys.stderr)
        wt          = fetch_wikitext(slug)
        wiki_fights = parse_upcoming_card(wt) if wt else []
        print(f"  Wiki fights found: {len(wiki_fights)}", file=sys.stderr)

        if not wiki_fights:
            m = re.search(r":\s*(\w+)\s+vs\.?\s+(\w+)", ev_name, re.IGNORECASE)
            if m:
                wiki_fights = [{"f1": m.group(1), "f2": m.group(2), "wc": "TBD", "title": False}]

        card = []
        for i, wf in enumerate(wiki_fights):
            if i == 0:    lbl = "Main Event"
            elif i == 1:  lbl = "Co-Main"
            elif i < 5:   lbl = "Main Card"
            else:         lbl = "Prelim"
            f1, f2 = wf["f1"], wf["f2"]
            wiki_rematch = wf.get("rematch", False) or _wiki_rematch(wt, f1, f2)
            if wiki_rematch:
                print(f"  Rematch (wiki): {f1} vs {f2}", file=sys.stderr)
            # Layer 4: BOTH fighters' Wikipedia fight records must confirm the past bout.
            # Requiring cross-confirmation eliminates false positives from common surnames
            # or upcoming fights inadvertently appearing in one fighter's record.
            if not wiki_rematch and i < 2:
                fw1 = fetch_wikitext(f1.replace(" ", "_"))
                if _fighter_wiki_past_fight(fw1, f2):
                    time.sleep(0.5)
                    fw2 = fetch_wikitext(f2.replace(" ", "_"))
                    if _fighter_wiki_past_fight(fw2, f1):
                        wiki_rematch = True
                        print(f"  Rematch (fighter wiki): {f1} vs {f2}", file=sys.stderr)
            card.append({
                "label":   lbl,
                "wc":      wf.get("wc", "TBD"),
                "title":   wf.get("title", False),
                "rematch": wiki_rematch,
                "odds":   get_odds_with_fallback(odds_index, existing_odds, f1, f2),
                "winner": "", "method": "", "round": None, "state": "pre",
                "f1":     {"name": f1, "record": "", "ranking": wf.get("f1_rk", "")},
                "f2":     {"name": f2, "record": "", "ranking": wf.get("f2_rk", "")},
            })
        if not card:
            continue
        new_events.append({
            "name":        ev_name,
            "date":        ev_date,
            "venue":       venue,
            "loc":         loc,
            "tv":          "Paramount+",
            "time":        main_time,
            "prelimTime":  prelim_time,
            "fights":      card,
        })
        print(f"  Built: {ev_name} ({len(card)} fights)", file=sys.stderr)
        time.sleep(1)

    if not new_events:
        print("No events built — keeping existing HTML", file=sys.stderr)
        return html

    # Preserve results already injected into the existing HTML so a full rebuild
    # never wipes winners for fights that finished more than 2 days ago.
    _post_pat = re.compile(
        r'winner:"([^"]+)",method:"([^"]*)",round:(\d+|null),state:"post"[^{]*'
        r'f1:\{n:"([^"]+)"[^}]+\},f2:\{n:"([^"]+)"'
    )
    existing_results = {}
    for m in _post_pat.finditer(html):
        winner, method, rnd, f1n, f2n = m.groups()
        if winner:
            key = frozenset([f1n.lower(), f2n.lower()])
            existing_results[key] = {
                "winner": winner, "method": method,
                "round": int(rnd) if rnd != "null" else None, "state": "post",
            }
    if existing_results:
        print(f"  Preserving {len(existing_results)} post-fight results", file=sys.stderr)
        for ev in new_events:
            for fight in ev["fights"]:
                key = frozenset([fight["f1"]["name"].lower(), fight["f2"]["name"].lower()])
                if key in existing_results:
                    r = existing_results[key]
                    fight.update({"winner": r["winner"], "method": r["method"],
                                  "round": r["round"], "state": r["state"]})

    # Fighter stats — fetch new, backfill missing form, refresh changed records
    stats_cache  = extract_stats_cache(html)
    all_fighters = {
        side["name"]
        for ev in new_events
        for fight in ev["fights"]
        for side in (fight["f1"], fight["f2"])
        if side.get("name") and side["name"] != "TBD"
    }
    card_records = {
        side["name"]: side["record"]
        for ev in new_events
        for fight in ev["fights"]
        for side in (fight["f1"], fight["f2"])
        if side.get("name") and side.get("record")
    }
    to_fetch = sorted(
        n for n in all_fighters
        if (
            n not in stats_cache
            or "form" not in stats_cache[n]
            or "opp" not in stats_cache[n]
            or (card_records.get(n) and card_records[n] != stats_cache[n].get("rec", ""))
        )
    )
    print(
        f"Fetching stats for {len(to_fetch)} fighters "
        f"({sum(1 for n in to_fetch if n not in stats_cache)} new)...",
        file=sys.stderr,
    )
    for fname in to_fetch:
        cached_url = stats_cache.get(fname, {}).get("url")
        s = fetch_fighter_stats(fname, cached_url=cached_url)
        if s:
            stats_cache[fname] = s
        else:
            # Stamp opp:[] on any failure so this fighter isn't retried every run.
            # Works whether the fighter is already cached or brand-new.
            if fname not in stats_cache:
                stats_cache[fname] = {}
            stats_cache[fname].setdefault("opp", [])
        time.sleep(1)
    print(f"Stats cache: {len(stats_cache)} fighters", file=sys.stderr)

    # Back-fill fighter records from stats cache
    for ev in new_events:
        for fight in ev["fights"]:
            for side in (fight["f1"], fight["f2"]):
                if not side.get("record"):
                    cached = stats_cache.get(side["name"], {})
                    if cached.get("rec"):
                        side["record"] = cached["rec"]

    # Rematch detection via UFCStats opponent history
    for ev in new_events:
        for fight in ev["fights"]:
            if fight.get("rematch"):
                continue  # already flagged by Wikipedia
            f1n = fight["f1"]["name"]
            f2n = fight["f2"]["name"]
            f1_opps = stats_cache.get(f1n, {}).get("opp", [])
            f2_opps = stats_cache.get(f2n, {}).get("opp", [])
            f2_norm = _norm_name(f2n)
            f1_norm = _norm_name(f1n)
            if (any(_norm_name(o) == f2_norm for o in f1_opps) or
                    any(_norm_name(o) == f1_norm for o in f2_opps)):
                fight["rematch"] = True
                print(f"  Rematch detected: {f1n} vs {f2n}", file=sys.stderr)

    html = patch_js_var(html, "EVENTS", events_js(new_events))
    html = patch_js_var(
        html, "FIGHTER_STATS",
        json.dumps(stats_cache, separators=(",", ":"), ensure_ascii=False),
    )
    rankings = fetch_rankings()
    if rankings:
        html = patch_js_var(
            html, "RANKINGS",
            json.dumps(rankings, separators=(",", ":"), ensure_ascii=False),
        )
    html = patch_js_var(html, "GENERATED_AT", f'"{fmt_update(now)}"')

    if len(html) < 30000:
        print("Output suspiciously small — aborting write", file=sys.stderr)
        return html   # caller will detect no-write

    return html

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    index = Path("index.html")
    if not index.exists():
        print("No index.html", file=sys.stderr)
        sys.exit(1)

    html = index.read_text(encoding="utf-8")
    now  = datetime.now(timezone.utc)

    print(
        "Existing events:",
        list(zip(
            re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', html)[:6],
            re.findall(r'name:"([^"]+)"', html)[:6],
        )),
        file=sys.stderr,
    )

    # Step 1: inject results for recent/live events
    updated, new_results = step_inject_results(html, now)
    if updated:
        index.write_text(updated, encoding="utf-8")
        print(f"Results injected", file=sys.stderr)
        send_push_notifications(new_results)
        sys.exit(0)

    # Step 2: full rebuild — events, odds, stats, rankings
    updated = step_build_events(html, now)
    if len(updated) >= 30000:
        index.write_text(updated, encoding="utf-8")
        new_events = re.findall(r'name:"([^"]+)"', updated)
        new_fights = len(re.findall(r'"lbl":|lbl:', updated))
        print(f"Done: {len(new_events)} events", file=sys.stderr)


if __name__ == "__main__":
    main()
