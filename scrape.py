#!/usr/bin/env python3
"""
UFC scraper — rebuilds data.js (fight cards, odds, stats, results) consumed by
the static index.html. App code and data are deliberately separate files so a
bad data write can never corrupt the app itself.

Data sources:
  Wikipedia  — event cards, fight results, fighter rankings
  Odds API   — live moneylines
  UFCStats   — fighter career statistics
  Supabase   — pick data for push notifications
"""

import hashlib
import json
import os
import re
import sys
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ODDS_API_KEY = os.environ.get("ODDS_API_KEY", "")
ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds"
# Odds are pulled through an ordered chain of source adapters (see fetch_odds).
# The primary covers US books; the secondary covers a different set of books so
# that when the primary parses zero bouts for a freshly-announced card — the
# empty-payload failure behind #14/#18 — the chain still fills the lines and we
# gain cross-book coverage. Either region set can be overridden (or the secondary
# disabled with an empty string) via the environment.
ODDS_API_REGIONS_PRIMARY   = os.environ.get("ODDS_API_REGIONS_PRIMARY", "us")
ODDS_API_REGIONS_SECONDARY = os.environ.get("ODDS_API_REGIONS_SECONDARY", "us2,uk,eu,au")
# Both of the above spend the SAME monthly quota, so neither survives budget
# exhaustion (#94). ODDS_API_KEY_SECONDARY does: a second Odds API account's key
# is the same coverage on an independent monthly budget, so an exhausted primary
# falls through to it instead of leaving announced cards unpriced for days.
#
# An unmetered ESPN provider was tried here first and removed: the MMA scoreboard
# returns events and bouts but carries no odds block at all (a live run measured
# 16 events / 113 bouts / 0 with odds), so there was nothing to parse. Any future
# free source should be added the same way — as a provider in ODDS_PROVIDERS —
# and proven with one live run before it is trusted.
ODDS_API_KEY_SECONDARY = os.environ.get("ODDS_API_KEY_SECONDARY", "")
WIKI_API     = "https://en.wikipedia.org/w/api.php"
WIKI_HDR     = {
    "User-Agent": (
        "UFC-Dashboard/1.0 "
        "(https://github.com/AndyRBrett/ufc-dashboard; andyrbrett@gmail.com)"
    )
}
# UFCStats returns a 200 with an empty results table when it doesn't like the
# client (a plain library User-Agent is a common trigger), so identify as a real
# browser for those requests specifically.
UFCSTATS_HDR = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
SUPABASE_URL  = os.environ.get("SUPABASE_URL", "https://gkccophrdqtqcowmblre.supabase.co")
# Supplied via the SUPABASE_ANON env var (set as a GitHub Actions secret). The anon
# key is public by design — it ships in index.html for the browser — but we read it
# from the environment rather than hardcoding a fallback so there's a single source
# of truth to rotate. Reads/writes are governed by Supabase Row-Level Security.
SUPABASE_ANON = os.environ.get("SUPABASE_ANON", "")

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
# Compiled regex patterns (hoisted to module scope so they compile once)
# ---------------------------------------------------------------------------

# Wikipedia rankings table: "! <rank>\n|...flagicon...\n|[[Fighter Name]]"
RANKINGS_RE = re.compile(
    r"^!\s*(\d{1,2})(?:\s*\([^)]*\))?\s*\n\|[^\n]*flagicon[^\n]*\n\|\s*\[\[(?:[^\]|]+\|)?([^\]]+)\]\]",
    re.MULTILINE,
)
# Odds already embedded in a previously generated data.js.
EXISTING_ODDS_RE = re.compile(
    r'odds:\{f1:(-?\d+),f2:(-?\d+)\}[^f]*?f1:\{n:"([^"]+)"[^}]*\},f2:\{n:"([^"]+)"'
)


# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------

# Canonical ASCII form. NFKD splits an accent off its base letter ("é" → "e" +
# a combining mark) and everything still non-ASCII afterwards is dropped: that
# includes the combining marks AND the Latin letters NFKD does not decompose at
# all, because their diacritic is baked into the codepoint ("ł", "ø", "đ").
#
# The dropping is what makes "Syguła" come out as "Sygua". That spelling is
# load-bearing: it is what data.js ships and therefore what every stored pick is
# keyed on (`date|f1|f2`), so this is the canonical form the whole system agrees
# on — NOT something to "fix" to "Sygula" without migrating those keys.
#
# Keep this byte-identical to _fold() in index.html and in
# supabase/functions/check-results/index.ts. When the JS senders skipped the
# drop and kept the "ł", one bout produced two different `result:<fight_key>`
# dedup keys, so notif_log let both through and everyone who picked that fight
# was notified twice.
def _fold(s):
    return "".join(
        c for c in unicodedata.normalize("NFKD", s) if ord(c) < 128
    )


def asc(text):
    """Transliterate accented characters to ASCII (e.g. É→E, í→i)."""
    if not text:
        return ""
    return _fold(str(text)).strip()


def clean(name):
    """Strip accented characters and trailing parentheticals from a name."""
    s = re.sub(r"\s*\([^)]+\)\s*$", "", str(name or "")).strip()
    return _fold(s).strip()


def clean_wiki(text):
    """Remove wikitext markup and return plain ASCII text."""
    if not text:
        return ""
    text = re.sub(r"\[\[([^\]|]+\|)?([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\{\{[^}]+\}\}", "", text)
    # A template split across lines reaches us as an UNCLOSED "{{nowrap|Name"
    # (the closing braces sit on a later line, which the caller never passes in),
    # so the rule above cannot see it. Left alone, those braces travel all the way
    # into a fighter name in data.js and unbalance the brace scan that
    # inject_results uses to find a fight's extent — see #97. Drop the opener,
    # keep the argument after the last pipe, then clear any orphaned braces.
    text = re.sub(r"\{\{\s*(?:[^|{}]*\|)*", "", text)
    text = text.replace("}}", "").replace("{", "").replace("}", "")
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
# data.js patching
# ---------------------------------------------------------------------------

def patch_js_var(data, name, value):
    """Replace var NAME=<old>; with var NAME=<value>; in the data.js text."""
    replacement = f"var {name}={value};"
    updated, n = re.subn(
        rf"var {re.escape(name)}\s*=\s*.*?;",
        lambda _: replacement,
        data,
        flags=re.DOTALL,
    )
    if n == 0:
        print(f"Warning: could not patch JS var '{name}'", file=sys.stderr)
    return updated

# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------

def get_with_retry(url, *, label="", retries=3, backoff=2, **kwargs):
    """requests.get with exponential-backoff retry on transient failures.

    A single transient blip — a connection reset, a timeout, a 429/5xx from
    Wikipedia or the Odds API — is the documented cause of the "successfully
    fetched but empty" runs behind #14: the request appears to complete, the page
    parses to zero bouts, and the empty payload gets written as if it were real.
    Retrying these reads (sleeping backoff * 2**attempt seconds between attempts)
    turns most of those one-off blips into a successful fetch instead of a silent
    empty.

    Retries on any request exception and on retryable HTTP statuses (429 and 5xx).
    Returns the final Response — which may still be non-2xx, so callers keep their
    own status checks — or None when every attempt raised.
    """
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, **kwargs)
        except Exception as e:
            print(f"  request error [{label}] {attempt + 1}/{retries}: {e}", file=sys.stderr)
        else:
            if r.status_code != 429 and r.status_code < 500:
                return r
            last = r
            print(
                f"  retryable status [{label}] {r.status_code} "
                f"{attempt + 1}/{retries}",
                file=sys.stderr,
            )
        if attempt < retries - 1:
            time.sleep(backoff * (2 ** attempt))
    return last


def sb_get(path):
    """GET a Supabase REST API endpoint. Returns a list, or [] on error."""
    if not SUPABASE_ANON:
        print("Supabase GET skipped: SUPABASE_ANON not set", file=sys.stderr)
        return []
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
            r = get_with_retry(
                url, label=f"wiki {method}", headers=WIKI_HDR, params=params, timeout=15)
            if r is None:
                continue
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


_event_slug_cache = {}


def _fold_title(s):
    """Case/diacritic/punctuation-insensitive key for comparing article titles."""
    return re.sub(r"[^a-z0-9]", "", asc(s).lower())


def _pick_search_title(ev_name, titles):
    """Return the search-result title that is the same event as ev_name."""
    want = _fold_title(ev_name)
    for t in titles:
        if _fold_title(t) == want:
            return t
    return ""


def search_event_slug(ev_name):
    """Resolve an event's true article slug via the Wikipedia search API.

    Event names stored in data.js are ASCII-folded (Medić → Medic), so a slug
    rebuilt from a stored name can point at a title that doesn't exist even as
    a redirect. Wikipedia's search is diacritic-insensitive, so it finds the
    real title; _pick_search_title then guards against grabbing a different
    event. Cached per run (empty string = search already failed).
    """
    if ev_name in _event_slug_cache:
        return _event_slug_cache[ev_name]
    slug = ""
    attempts = [
        ("opensearch",
         {"action": "opensearch", "search": ev_name, "limit": "5",
          "namespace": "0", "format": "json"},
         lambda j: j[1]),
        # Full-text search as a backstop — opensearch is prefix-based and can
        # miss when the stored name and article title diverge mid-string.
        ("srsearch",
         {"action": "query", "list": "search", "srsearch": ev_name,
          "srlimit": "5", "format": "json"},
         lambda j: [h["title"] for h in j.get("query", {}).get("search", [])]),
    ]
    for label, params, extract in attempts:
        try:
            r = get_with_retry(WIKI_API, label=f"wiki {label}",
                               headers=WIKI_HDR, params=params, timeout=15)
            if r is None or r.status_code != 200:
                continue
            title = _pick_search_title(ev_name, extract(r.json()))
            if title:
                slug = title.replace(" ", "_")
                print(f"  Wiki {label} resolved [{ev_name[:40]}] -> {slug}",
                      file=sys.stderr)
                break
        except Exception as e:
            print(f"  Wiki {label} error [{ev_name[:40]}]: {e}", file=sys.stderr)
        time.sleep(1)
    _event_slug_cache[ev_name] = slug
    return slug


def _event_slug_map(data):
    """Map (event name, date) -> stored Wikipedia slug from the data.js text.

    Slugs are written by events_js as JSON string literals (non-ASCII escaped,
    e.g. Medi\\u0107), so decode each one before use. Events written before
    slug persistence existed simply won't appear in the map.
    """
    pat = re.compile(
        r'name:"([^"]+)",\s*\n\s*'
        r'date:"(\d{4}-\d{2}-\d{2})",\s*\n\s*'
        r'venue:"[^"]*",\s*\n\s*'
        r'loc:"[^"]*",\s*\n\s*'
        r'slug:"([^"]*)"'
    )
    out = {}
    for m in pat.finditer(data):
        name, date, raw = m.groups()
        try:
            slug = json.loads(f'"{raw}"')
        except ValueError:
            continue
        if slug:
            out[(name, date)] = slug
    return out


def fetch_event_wikitext(ev_name, slug):
    """Fetch an event page's wikitext, falling back to a title search.

    The direct slug works while it comes from a wiki link (discovery keeps
    diacritics intact), but slugs rebuilt from ASCII-folded stored names miss
    articles with accented titles — exactly when an event drops off the
    Scheduled list on fight day and live results need injecting.
    """
    wt = fetch_wikitext(slug)
    if wt:
        return wt
    alt = search_event_slug(ev_name)
    if alt and alt != slug:
        return fetch_wikitext(alt)
    return ""


_US_REGIONS = re.compile(
    r"\b(United States|USA|"
    # States that host UFC cards
    r"Nevada|Texas|Florida|New York|New Jersey|Arizona|California|Washington|"
    r"Oklahoma|Pennsylvania|Georgia|Colorado|Illinois|Tennessee|Utah|Ohio|"
    r"North Carolina|Massachusetts|Michigan|Minnesota|Louisiana|Missouri|"
    r"Kansas|Virginia|Connecticut|"
    # Notable host cities not implied by a state name above
    r"Las Vegas|Houston|Newark|Inglewood|Sacramento|Oklahoma City|Philadelphia|"
    r"Atlanta|Denver|Chicago|Nashville|Salt Lake City|Charlotte|Anaheim|"
    r"Kansas City|Boston|Detroit|Minneapolis|New Orleans|St\.? Louis|"
    r"Glendale|Phoenix|Tucson|Austin|San Antonio|Miami|Tampa|Orlando|"
    r"Jacksonville|Brooklyn|Buffalo|Baltimore|Pittsburgh|Columbus|Cincinnati|"
    r"Cleveland|Milwaukee|Des Moines|Louisville|Memphis|Albuquerque|Portland|"
    r"Seattle|San Diego|San Jose|San Francisco|Oakland|Fresno|Long Beach|"
    r"Rosemont|Elmont|Uniondale|Sioux Falls|Omaha|Boise|Honolulu|"
    # Added after UFC 331 (Crypto.com Arena) shipped 4h early: "Los Angeles"
    # was absent, and because data.js stores a BARE city ("Los Angeles", not
    # "Los Angeles, California") the "California" alternative above never
    # matched. The card fell through to ESPN unclamped. Any host city missing
    # from this list is silently unanchored, so health.py now WARNs on a venue
    # that matches no region at all rather than waiting for someone to notice.
    r"Los Angeles|Dallas|Fort Worth|Arlington|Atlantic City|Uncasville|"
    r"Lincoln|Raleigh|Greenville|Norfolk|Rochester|Wichita|Tulsa|Spokane|"
    r"Stockton|Sunrise|Bakersfield|Fairfax|Broomfield|Cedar Park|"
    # Canada uses the same fixed-ET broadcast slots
    r"Canada|Vancouver|Toronto|Montreal|Edmonton|Calgary|Ottawa|Winnipeg|"
    r"Quebec City|Halifax|Saskatoon|Ontario)\b",
    re.IGNORECASE,
)

# Numbered pay-per-view events ("UFC 329: ...") run later than Fight Nights:
# US PPV main cards start at 9pm ET with prelims at 7pm ET, versus 8pm/5pm ET
# for a standard Fight Night.
_PPV_RE = re.compile(r"^UFC\s+\d+\b")


def _is_ppv(ev_name):
    return bool(_PPV_RE.match(ev_name or ""))


def _default_main_time(loc, ev_name=""):
    if not _US_REGIONS.search(loc or ""):
        return "TBD"
    return "21:00" if _is_ppv(ev_name) else "20:00"


def _default_prelim_time(loc, ev_name=""):
    if not _US_REGIONS.search(loc or ""):
        return "TBD"
    return "19:00" if _is_ppv(ev_name) else "17:00"


# STRUCTURAL time overrides only — for cards where the broadcast format is
# unusual (e.g. no prelims, atypical slot). DO NOT add entries here just to
# "correct" a time: if ESPN has the wrong time, fix the ESPN fetch or wait for
# ESPN to update. Hardcoded ET values here bypass ESPN entirely and are the
# #1 source of wrong times on the dashboard.
#
# Format: event name -> (main_time, prelim_time) in 24h ET.
# Always include the UTC equivalent in the comment so it can be verified.
# An empty prelim_time means no preliminary bouts.
_TIME_OVERRIDES = {
    # White House: single seven-fight main card at 8pm ET (00:00 UTC next day), no prelims.
    "UFC Freedom 250": ("20:00", ""),
    # International cards where ESPN's scoreboard 'date' is not the main-card start
    # (its meaning is inconsistent across these events), so pin the published
    # Paramount+ times. UTC/local equivalents given for verification.
    # Baku (UTC+4): main 12:00 ET = 16:00 UTC = 20:00 local; prelims 09:00 ET.
    "UFC Fight Night: Fiziev vs. Torres": ("12:00", "09:00"),
    # Abu Dhabi (UTC+4): main 15:00 ET = 19:00 UTC = 23:00 local; prelims 12:00 ET.
    "UFC Fight Night: Ankalaev vs. Rountree Jr.": ("15:00", "12:00"),
    # Shanghai (UTC+8): main 06:00 ET = 10:00 UTC = 18:00 local; prelims 03:00 ET
    # = 07:00 UTC = 15:00 local. Same failure as the two above: the scraped time
    # landed on 03:00 ET, which is the STREAM start (i.e. the prelims), and the
    # prelim slot was then derived three hours earlier still, so both were wrong
    # by three hours in the same direction. Published Paramount+ times confirmed
    # by four independent previews.
    "UFC Fight Night: Nurmagomedov vs. Song": ("06:00", "03:00"),
    # Paris (UTC+2, CEST): main 15:00 ET = 19:00 UTC = 21:00 local; prelims
    # 12:00 ET = 16:00 UTC = 18:00 local. Same ESPN failure as the three above
    # — the scoreboard 'date' was the PRELIM start (12:00 ET), which got stored
    # as the main-card time and pushed the prelim slot three hours earlier
    # still, so both were three hours early. Published Paramount+ times.
    "UFC Fight Night: Hooker vs. Parnasse": ("15:00", "12:00"),
}

# Cards with no preliminary bouts -- every fight is treated as a main-card fight
# regardless of its position on the card.
_NO_PRELIM_CARDS = {
    "UFC Freedom 250",
}

# Regional fallback broadcast slots for international cards, used only when
# ESPN has no time for the event (so a card can never sit at "TBD" just
# because ESPN hasn't listed it yet). Values are 24h ET, picked so the local
# main-card start lands in the venue's typical UFC window: evening prime time
# for Europe / Middle East / Latin America, and the Sunday morning/noon local
# starts Asia-Pacific cards use so they air Saturday night in the US. These
# are estimates by design — ESPN (exact, DST-correct) always wins when it has
# the event, and true outliers still belong in _TIME_OVERRIDES.
_INTL_REGION_SLOTS = [
    # (label, location regex, (main_et, prelim_et))
    ("europe", re.compile(
        r"\b(England|London|Manchester|Scotland|Glasgow|Ireland|Dublin|"
        r"France|Paris|Germany|Berlin|Hamburg|Cologne|Spain|Madrid|Barcelona|"
        r"Italy|Rome|Milan|Poland|Warsaw|Gdansk|Krakow|Sweden|Stockholm|"
        r"Norway|Oslo|Denmark|Copenhagen|Netherlands|Amsterdam|Rotterdam|"
        r"Belgium|Brussels|Austria|Vienna|Czech|Prague|Serbia|Belgrade|"
        r"Croatia|Zagreb|Hungary|Budapest|Romania|Bucharest|Bulgaria|Sofia|"
        r"Greece|Athens|Portugal|Lisbon|Finland|Helsinki|Slovakia|Bratislava|"
        r"Tbilisi)\b", re.IGNORECASE),
     ("15:00", "12:00")),   # main 19:00 UTC (DST) → ~21:00 CEST
    ("mideast", re.compile(
        r"\b(Abu Dhabi|UAE|United Arab Emirates|Dubai|Qatar|Doha|"
        r"Saudi Arabia|Riyadh|Jeddah|Bahrain|Manama|Kuwait|Baku|Azerbaijan|"
        r"Istanbul|Turkey)\b", re.IGNORECASE),
     ("14:00", "11:00")),   # main 18:00 UTC → 22:00 GST
    ("asia", re.compile(
        r"\b(China|Shanghai|Beijing|Macau|Japan|Tokyo|Saitama|Osaka|"
        r"Singapore|South Korea|Seoul|India|Mumbai|Delhi|Thailand|Bangkok|"
        r"Philippines|Manila|Hong Kong|Indonesia|Jakarta|Malaysia|"
        r"Kuala Lumpur|Kazakhstan|Almaty|Astana|Uzbekistan|Tashkent)\b",
        re.IGNORECASE),
     ("06:00", "03:00")),   # main 10:00 UTC → 18:00 CST (Sunday-evening local)
    ("oceania", re.compile(
        r"\b(Australia|Perth|Sydney|Melbourne|Brisbane|Adelaide|"
        r"New Zealand|Auckland)\b", re.IGNORECASE),
     ("22:00", "19:00")),   # Sat 22:00 ET → Sun ~10:00 AWST / ~12:00 AEST
    ("latam", re.compile(
        r"\b(Mexico|Guadalajara|Monterrey|Brazil|Rio de Janeiro|Sao Paulo|"
        r"Curitiba|Fortaleza|Brasilia|Argentina|Buenos Aires|Chile|Santiago|"
        r"Peru|Lima|Colombia|Bogota)\b", re.IGNORECASE),
     ("20:00", "17:00")),   # same-hemisphere cards use the US-style evening slot
]


def classify_region(loc):
    """Which broadcast-slot family a location belongs to.

    Returns "us" for US/Canada (fixed ET slot), an _INTL_REGION_SLOTS label for
    a known international region, or "" when the venue is anchored to nothing.

    That last case is the dangerous one: with no slot to compare against there
    is no way to tell a good ESPN time from one describing the wrong segment,
    which is exactly how UFC 331 shipped four hours early. Callers are expected
    to treat "" as "this time is unverified".
    """
    if _US_REGIONS.search(loc or ""):
        return "us"
    for label, rx, _ in _INTL_REGION_SLOTS:
        if rx.search(loc or ""):
            return label
    return ""


def _regional_default_times(loc):
    """(region_label, main_et, prelim_et) for an international location, or
    ("", "TBD", "TBD") when the location matches no known region."""
    for label, rx, (main, prelim) in _INTL_REGION_SLOTS:
        if rx.search(loc or ""):
            return label, main, prelim
    return "", "TBD", "TBD"


def _event_times(ev_name, loc):
    """Published times for known outlier cards, else location-based defaults."""
    if ev_name in _TIME_OVERRIDES:
        return _TIME_OVERRIDES[ev_name]
    return _default_main_time(loc, ev_name), _default_prelim_time(loc, ev_name)


# ---------------------------------------------------------------------------
# ESPN start times
#
# The location-based defaults above only know US/Canada cards (anchored to a
# fixed ET broadcast slot); everything else fell back to "TBD". ESPN's MMA
# scoreboard publishes each event's broadcast start as an absolute UTC instant,
# so the ET wall-clock is an exact, DST-correct conversion — no venue-timezone
# guesswork — and it covers international cards (Baku, Abu Dhabi, Perth, ...)
# that have no clean ET rule. ESPN is preferred when it returns a confident
# match; any miss or parse failure falls back to the location default, so a
# bad/empty ESPN response can never regress the cards that already work.
# ---------------------------------------------------------------------------

ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard"
_ET = ZoneInfo("America/New_York")
_espn_cache = {}


def _prelim_offset_hours(ev_name):
    """Prelims precede the main card by 2h for a numbered PPV, else 3h —
    matching the spread between the location-based main/prelim defaults."""
    return 2 if _is_ppv(ev_name) else 3


def _event_surnames(ev_name):
    """Lowercase surnames of the two headliners parsed from 'X vs. Y', or None."""
    tail = ev_name.split(":", 1)[-1]
    m = re.search(r"(.+?)\s+vs\.?\s+(.+)", tail, re.IGNORECASE)
    if not m:
        return None
    a, b = last_name(m.group(1)), last_name(m.group(2))
    return (a, b) if a and b else None


def _utc_iso_to_et(iso):
    """Parse an ISO-8601 UTC timestamp into a timezone-aware ET datetime, or None."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_ET)


def parse_espn_times(payload, ev_name, ev_date):
    """
    Pure: resolve (main_time, prelim_time) in 24h ET for the event matching
    *ev_name* on *ev_date* from an ESPN scoreboard payload, or (None, None).

    Matches on the event's ET calendar date plus both headliner surnames — a
    late US card crosses midnight UTC but is still "tonight" in ET, which is why
    the date check is done after converting to ET. The prelim start is derived
    from the published main-card start by the standard offset.
    """
    want = _event_surnames(ev_name)
    if not want:
        return None, None
    for ev in payload.get("events", []):
        et = _utc_iso_to_et(ev.get("date"))
        if et is None or et.strftime("%Y-%m-%d") != ev_date:
            continue
        names = (ev.get("name", "") + " " + ev.get("shortName", "")).lower()
        if not (want[0] in names and want[1] in names):
            continue
        prelim = et - timedelta(hours=_prelim_offset_hours(ev_name))
        return et.strftime("%H:%M"), prelim.strftime("%H:%M")
    return None, None


def fetch_espn_times(ev_name, ev_date):
    """Network: fetch the ESPN scoreboard for *ev_date* (cached) and resolve ET
    times. Returns (None, None) on any network/parse failure."""
    key = ev_date.replace("-", "")
    if key not in _espn_cache:
        payload = {}
        try:
            r = requests.get(ESPN_SCOREBOARD, params={"dates": key},
                             headers=WIKI_HDR, timeout=15)
            if r.status_code == 200:
                payload = r.json()
            else:
                print(f"  ESPN scoreboard [{key}]: HTTP {r.status_code}", file=sys.stderr)
        except Exception as e:
            print(f"  ESPN error: {e}", file=sys.stderr)
        _espn_cache[key] = payload
    return parse_espn_times(_espn_cache[key], ev_name, ev_date)


def _warn_if_implausible_time(ev_name, loc, main_et):
    """Warn when a resolved ET start time implies a local start past midnight.

    International cards (non-US) that show up with an ET start time later than
    17:00 almost certainly have a data error: 17:00 ET = 21:00 UTC, and with
    any eastward UTC offset the local time would be after midnight.
    """
    if not main_et or main_et == "TBD":
        return
    if _US_REGIONS.search(loc or ""):
        return
    # Oceania cards legitimately start late ET (Sunday morning/noon local),
    # and Latin America shares the US evening slot — a late ET time there is
    # expected, not evidence of a bad conversion.
    region, _, _ = _regional_default_times(loc)
    if region in ("oceania", "latam"):
        return
    try:
        h = int(main_et.split(":")[0])
    except (ValueError, IndexError):
        return
    if h >= 17:
        print(
            f"WARNING: {ev_name} (loc={loc!r}) resolved to {main_et} ET — "
            f"that implies a local start time past midnight. Check ESPN or "
            f"add a _TIME_OVERRIDES entry with the correct ET time (and its "
            f"UTC equivalent in the comment).",
            file=sys.stderr,
        )


# How far ESPN's main-card time may sit from the venue's regional broadcast slot
# before it is treated as the wrong segment rather than a real schedule quirk.
# The four cards that needed a manual _TIME_OVERRIDES rescue all landed exactly
# 3h early (ESPN published the prelim/stream start as the event `date`), while
# the regional slot was never worse than 2h from the published main card:
#
#   card                 published main   regional slot   ESPN
#   Paris (europe)       15:00 ET         15:00  (0h)     12:00  (-3h)
#   Shanghai (asia)      06:00 ET         06:00  (0h)     03:00  (-3h)
#   Abu Dhabi (mideast)  15:00 ET         14:00  (1h)     wrong segment
#   Baku (mideast)       12:00 ET         14:00  (2h)     wrong segment
#
# So a 2h window cleanly separates "ESPN is describing the main card" from
# "ESPN is describing some earlier segment".
_ESPN_REGION_TOLERANCE_H = 2


def _hours_apart(a_hhmm, b_hhmm):
    """Circular distance in hours between two 24h "HH:MM" times, or None.

    Circular so a card either side of midnight (23:00 vs 01:00) reads as 2h
    apart rather than 22h.
    """
    try:
        ah, am = (int(x) for x in a_hhmm.split(":")[:2])
        bh, bm = (int(x) for x in b_hhmm.split(":")[:2])
    except (ValueError, AttributeError, IndexError):
        return None
    diff = abs((ah * 60 + am) - (bh * 60 + bm)) / 60.0
    return min(diff, 24.0 - diff)


def espn_agrees_with_region(espn_main, region_main):
    """True when ESPN's main-card time is close enough to the regional slot to
    be believed. Unknown region (no slot) → believe ESPN, since the alternative
    is "TBD"."""
    if not region_main or region_main == "TBD":
        return True
    apart = _hours_apart(espn_main, region_main)
    return apart is None or apart <= _ESPN_REGION_TOLERANCE_H


def resolve_event_times(ev_name, ev_date, default_main, default_prelim, loc=""):
    """Resolve (main, prelim) ET times for an event.

    Manual _TIME_OVERRIDES win outright. For US/Canada cards the location
    default is a fixed, known broadcast slot (PPV 21:00/19:00, Fight Night
    20:00/17:00 ET) and is authoritative — ESPN's scoreboard ``date`` is the
    event's first-segment (early-prelim) start rather than the main-card start,
    so preferring it made every US main-card time hours too early.

    For international cards ESPN is consulted first, but is no longer trusted
    blind: its ``date`` has the same inconsistent meaning abroad, and when it
    lands on the prelim/stream start the derived prelim slot is pushed three
    hours earlier still — so BOTH times ship three hours early (Paris, Shanghai).
    A resolved main card more than `_ESPN_REGION_TOLERANCE_H` from the venue's
    regional slot is therefore rejected in favour of that slot, which is the
    conservative choice: the slot was within 2h of the published time on every
    card that has needed a manual rescue, while ESPN was a full segment out.
    """
    if ev_name in _TIME_OVERRIDES:
        return default_main, default_prelim
    if default_main != "TBD":            # US/Canada card → fixed ET slot is authoritative
        return default_main, default_prelim
    region, rmain, rprelim = _regional_default_times(loc)
    main, prelim = fetch_espn_times(ev_name, ev_date)
    if main and espn_agrees_with_region(main, rmain):
        print(f"  ESPN times for {ev_name}: main {main} ET / prelim {prelim} ET",
              file=sys.stderr)
        return main, prelim
    if main:
        print(
            f"WARNING: {ev_name} (loc={loc!r}) — ESPN says main {main} ET but the "
            f"{region} slot is {rmain} ET ({_hours_apart(main, rmain):.0f}h apart). "
            f"ESPN is almost certainly reporting an earlier segment (prelims or "
            f"early prelims); using the regional slot instead. If {main} is in "
            f"fact correct, pin the card in _TIME_OVERRIDES.",
            file=sys.stderr,
        )
    if rmain != "TBD":
        print(f"  Regional default times for {ev_name} ({region}): "
              f"main {rmain} ET / prelim {rprelim} ET", file=sys.stderr)
        return rmain, rprelim
    return default_main, default_prelim


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
    for m in RANKINGS_RE.finditer(wt):
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
    row = [cleaned for cleaned in (clean_wiki(c) for c in row) if cleaned]
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

def _implied_prob(o):
    """Implied win probability for an American moneyline integer."""
    if o < 0:
        return abs(o) / (abs(o) + 100)
    else:
        return 100 / (o + 100)


def _valid_odds(f1_odds, f2_odds):
    """Return True iff the moneyline pair is mathematically sane.

    A valid sportsbook line always has a total implied probability >= 100% (the
    house edge). Any pair that sums below 100% is a corrupt or malformed price —
    typically a small-magnitude negative value from a non-US book that the Odds
    API didn't convert cleanly to American format.

    Additionally, no legitimate book posts |odds| < 100 in American format.
    Values like +29 or -36 are the "drop leading digit" corruption class.
    """
    if abs(f1_odds) < 100 or abs(f2_odds) < 100:
        return False
    return _implied_prob(f1_odds) + _implied_prob(f2_odds) >= 1.0


def _index_odds_api(data, source):
    """Turn one Odds API payload into a fighter-pair index tagged with `source`.

    Pure (no network), so the parsing is unit-testable independent of the request.
    """
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
            f1_odds = round(sum(p1) / len(p1))
            f2_odds = round(sum(p2) / len(p2))
            if not _valid_odds(f1_odds, f2_odds):
                print(
                    f"Odds rejected ({h} vs {a}): f1={f1_odds} f2={f2_odds} "
                    f"implied={_implied_prob(f1_odds)+_implied_prob(f2_odds):.1%} — "
                    f"source={source}",
                    file=sys.stderr,
                )
                continue
            pair = tuple(sorted([h.lower(), a.lower()]))
            odds_index[pair] = {
                "f1_name": h,
                "f2_name": a,
                "f1_odds": f1_odds,
                "f2_odds": f2_odds,
                "source":  source,
                # Bookmakers publish each bout's scheduled start as an absolute
                # UTC instant. It rides along in the payload we already pay for,
                # so it is a free second opinion on the card's start time —
                # wholly independent of ESPN, which is the source that has
                # silently shipped a wrong time four times now. Kept as the raw
                # ISO string; see odds_card_start_et().
                "commence_time": fight.get("commence_time", ""),
            }
    return odds_index


def odds_card_start_et(odds_index, card, ev_date):
    """Earliest bookmaker start time across *card*, as a 24h ET "HH:MM", or "".

    The earliest bout on a card is the first prelim, so this approximates the
    PRELIM start — the same thing ev.prelimTime holds. Bouts whose start falls
    on another ET date are ignored so a mis-keyed pair from a neighbouring card
    can't drag the answer.

    This costs no API quota: commence_time arrives inside the odds payload the
    scraper already fetches, so it is a free cross-check rather than a source.
    Treated as advisory only — bookmakers sometimes stamp a whole card with one
    nominal start — so it warns, it never overwrites a resolved time.
    """
    best = None
    for fight in card:
        # Reuse the same fuzzy matcher the odds lookup uses, rather than
        # rebuilding the index key — the key is sorted/cleaned and a rebuilt one
        # silently misses the bouts whose names needed fuzzy matching.
        entry, _ = _match_odds(odds_index, fight["f1"]["name"], fight["f2"]["name"])
        if not entry:
            continue
        et = _utc_iso_to_et(entry.get("commence_time"))
        if et is None or et.strftime("%Y-%m-%d") != ev_date:
            continue
        if best is None or et < best:
            best = et
    return best.strftime("%H:%M") if best else ""


# How far the published prelim time may sit from the bookmakers' earliest start
# before it is worth flagging. Generous, because commence_time is a nominal
# start: only a whole-segment error (the 3h class of bug) should trip it.
_ODDS_TIME_TOLERANCE_H = 2


def reconcile_times_with_odds(ev_name, loc, main, prelim, odds_start):
    """Reconcile resolved ET times against the bookmakers' card start.

    Returns the (main, prelim) to publish.

    What happens on a disagreement depends on whether the venue is anchored to
    a known broadcast slot:

    * Anchored (US/Canada or a mapped international region) — WARN only. The
      slot is a deterministic expectation and commence_time is a nominal start
      that bookmakers sometimes stamp across a whole card, so it is not allowed
      to overrule a real anchor.
    * Unanchored (``classify_region`` returns "") — CORRECT to the odds feed.
      Here the published time came from ESPN with nothing to check it against,
      which is precisely the UFC 331 failure. A second independent source
      beats an unverified one, so the odds start becomes the prelim time and
      the main card is derived from it by the standard segment offset.

    Correcting only the unanchored case keeps the deterministic paths fully
    deterministic: a run where the odds pull was skipped resolves those cards
    identically to one where it ran.
    """
    if not odds_start or not prelim or prelim == "TBD":
        return main, prelim
    apart = _hours_apart(prelim, odds_start)
    if apart is None or apart <= _ODDS_TIME_TOLERANCE_H:
        return main, prelim
    region = classify_region(loc)
    if region:
        print(
            f"WARNING: {ev_name} — prelims resolved to {prelim} ET but the odds "
            f"feed has the card starting {odds_start} ET ({apart:.0f}h apart). "
            f"Keeping {prelim} because the {region} slot anchors it; check the "
            f"published start, and pin _TIME_OVERRIDES if the feed is right.",
            file=sys.stderr,
        )
        return main, prelim
    new_main = _shift_hhmm(odds_start, _prelim_offset_hours(ev_name))
    print(
        f"WARNING: {ev_name} (loc={loc!r}) — prelims resolved to {prelim} ET "
        f"with no regional slot to verify it, and the odds feed disagrees by "
        f"{apart:.0f}h. Correcting to the odds feed: prelims {odds_start} ET, "
        f"main {new_main} ET. Add {loc!r} to _US_REGIONS or _INTL_REGION_SLOTS "
        f"so this card is anchored rather than inferred.",
        file=sys.stderr,
    )
    return new_main, odds_start


def _shift_hhmm(hhmm, hours):
    """"HH:MM" shifted by *hours*, wrapping at midnight."""
    h, m = (int(x) for x in hhmm.split(":")[:2])
    return f"{(h + hours) % 24:02d}:{m:02d}"


_odds_requests_remaining = None   # last x-requests-remaining seen from the Odds API
_odds_last_status = None          # last HTTP status seen from the Odds API

# What each odds provider did this run, keyed by quota bucket (#94). Persisted
# into odds-state.json so the NEXT run can skip a provider whose budget is spent
# instead of spending a call to rediscover that.
_provider_stats = {}


def note_provider_result(quota, source, status=..., remaining=..., bouts=...):
    """Record one provider's outcome for this run (#94).

    Called more than once per provider (once for the response, once for the
    parsed bout count), so only the fields explicitly passed are overwritten —
    a later call must never blank the status the earlier one recorded.
    """
    entry = _provider_stats.setdefault(quota, {"provider": source})
    entry["provider"] = source
    if status is not ...:
        entry["last_status"] = status
    if remaining is not ...:
        entry["requests_remaining"] = remaining
    if bouts is not ...:
        entry["bouts"] = bouts
    return entry


def _fetch_odds_api(regions, source, api_key=None, quota="the-odds-api"):
    """One Odds API source adapter: fetch `regions` and return a tagged index.

    Returns an empty dict on a missing key, a non-200, a request error, or an
    empty payload — all of which the fallback chain treats the same way (the next
    source gets a chance to cover the bout).
    """
    api_key = ODDS_API_KEY if api_key is None else api_key
    if not api_key or not regions:
        return {}
    try:
        r = get_with_retry(
            ODDS_API_URL,
            label=f"odds {source}",
            params={
                "apiKey": api_key,
                "regions": regions,
                "markets": "h2h",
                "oddsFormat": "american",
            },
            timeout=15,
        )
        if r is None:
            return {}
        remaining = r.headers.get("x-requests-remaining")
        print(
            f"Odds API [{source}]: {r.status_code} | remaining: {remaining or '?'}",
            file=sys.stderr,
        )
        # Surface the quota so exhaustion is visible in the health report instead
        # of silently degrading into stale lines for weeks.
        global _odds_requests_remaining, _odds_last_status
        try:
            remaining_n = int(remaining) if remaining is not None else None
        except ValueError:
            remaining_n = None
        # The top-level odds-state fields describe the PRIMARY key's budget —
        # health.py and write_status.odds_budget_exhausted read them and must not
        # start seeing a backup key's quota. Per-provider detail goes to
        # _provider_stats instead (#94).
        if quota == "the-odds-api":
            _odds_last_status = r.status_code
            if remaining_n is not None:
                _odds_requests_remaining = remaining_n
        note_provider_result(quota, source,
                             status=r.status_code, remaining=remaining_n)
        if r.status_code != 200:
            return {}
        data = r.json()
    except Exception as e:
        print(f"Odds API [{source}] error: {e}", file=sys.stderr)
        note_provider_result(quota, source, status=None, remaining=None)
        return {}
    idx = _index_odds_api(data, source)
    note_provider_result(quota, source, bouts=len(idx))
    return idx


# --- Odds API budget -------------------------------------------------------
#
# The Odds API is quota-metered per month. The scraper runs every 5 minutes
# during fight windows (see update.yml) and every run that injects no result
# falls through to a full rebuild, which called fetch_odds() unconditionally —
# ~144 fall-through runs per event weekend, two sources each. That is ~1,200
# calls/month against a 500/month tier: the quota died mid-July, every call
# after it returned non-200, and get_odds_with_fallback quietly reused the last
# good lines. That is how the Aug 8 card ended up showing Aug 1 odds for six
# days with four bouts never priced at all.
#
# Odds only need refreshing as a card approaches, and not at all once it starts
# (lines close; those runs only exist to pull results). Gate the pull on elapsed
# time instead of firing on every invocation.
ODDS_STATE_PATH = Path("odds-state.json")
# (days until the next card, minimum hours between pulls). First match wins.
ODDS_PULL_INTERVALS = (
    (0,   3),    # card is today      → lines all but closed, 3h is plenty
    (2,   2),    # card within 2 days → tightest cadence, replacements land here
    (7,   6),
    (30, 24),
)
ODDS_PULL_MAX_DAYS_OUT = 30   # nothing beyond this is priced yet — don't spend a call

# Proximity alone still overspends on a DORMANT card. #73: the quota died with
# five events sat at awaiting-card, because a card 2 days out is polled every 2h
# whether or not a single book has moved a number. Those calls buy nothing — the
# payload comes back byte-identical.
#
# So the cadence is proximity backed off by observed activity: each consecutive
# pull that returns lines identical to the previous one doubles the wait, capped.
# One moved number resets it to the tight proximity cadence immediately, which is
# the property that matters — backing off must never cost freshness on a card
# whose lines are actually live.
#
# The cap is deliberately low. This throttles a QUIET market, and a quiet market
# is exactly when a late line move is most worth catching; stretching a 2h
# cadence past 8h to save a handful of calls would trade the feature for the
# quota.
ODDS_IDLE_BACKOFF_MAX = 4


def odds_min_interval_hours(days_out):
    """Minimum hours between Odds API pulls given the next card's distance.

    None means "don't pull at all": no card in range to price.
    """
    if days_out is None or days_out < 0 or days_out > ODDS_PULL_MAX_DAYS_OUT:
        return None
    for limit, hours in ODDS_PULL_INTERVALS:
        if days_out <= limit:
            return hours
    return None


def odds_activity_multiplier(idle_pulls):
    """How far to stretch the proximity interval after `idle_pulls` dead pulls.

    Doubles per consecutive unchanged pull (1, 2, 4, ...) and stops at
    ODDS_IDLE_BACKOFF_MAX. Junk (None, negative, non-int) reads as "no idle
    history" and costs nothing: the multiplier is 1 and the proximity cadence
    stands unchanged.
    """
    try:
        n = int(idle_pulls)
    except (TypeError, ValueError):
        return 1
    if n <= 0:
        return 1
    return min(2 ** n, ODDS_IDLE_BACKOFF_MAX)


def odds_lines_digest(odds_index):
    """Fingerprint of the lines in a fetched odds index, or None if it is empty.

    Compared against the previous pull's digest to answer "did the market move?"
    without re-deriving the fighter-pair matching that get_odds_with_fallback
    already does. Only the pair and the two prices go in — `source` is excluded
    on purpose, so the fallback chain covering a bout from a different book (the
    same numbers, a different sportsbook) does not read as line movement.

    None for an empty index is load-bearing: a failed pull must never be recorded
    as "nothing moved", or a dead API key backs the cadence off to its maximum and
    the outage gets quieter the longer it lasts.
    """
    if not odds_index:
        return None
    parts = []
    for pair in sorted(odds_index):
        o = odds_index[pair]
        parts.append(f"{'|'.join(pair)}={o['f1_odds']}/{o['f2_odds']}")
    return hashlib.sha1(";".join(parts).encode("utf-8")).hexdigest()


def next_idle_pulls(previous_idle, prev_digest, new_digest):
    """The idle-pull count to persist after a pull.

    Unchanged lines increment it (a longer wait next time); any movement, or a
    first-ever pull, resets to 0. A pull that returned nothing (new_digest None)
    leaves the count untouched — see odds_lines_digest.
    """
    try:
        n = max(0, int(previous_idle))
    except (TypeError, ValueError):
        n = 0
    if new_digest is None:
        return n
    if prev_digest and new_digest == prev_digest:
        return n + 1
    return 0


def should_fetch_odds(now, last_at, days_out, idle_pulls=0):
    """True when enough time has passed to spend another Odds API call.

    A skipped pull is safe by construction: fetch_odds returns an empty index and
    get_odds_with_fallback keeps the lines already in data.js.
    """
    if os.environ.get("ODDS_FORCE") == "1":
        return True
    interval = odds_min_interval_hours(days_out)
    if interval is None:
        return False
    interval *= odds_activity_multiplier(idle_pulls)
    if not last_at:
        return True
    prev = _parse_ts(last_at)
    if not prev:
        return True
    return (now - prev) >= timedelta(hours=interval)


def _next_event_days_out(data, now):
    """Whole days from today until the soonest event in data.js that isn't past.

    None when data.js lists no future event.
    """
    today = now.date()
    best  = None
    for ds in re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', data):
        try:
            d = datetime.strptime(ds, "%Y-%m-%d").date()
        except ValueError:
            continue
        if d < today:
            continue
        if best is None or d < best:
            best = d
    return None if best is None else (best - today).days


def load_odds_state():
    try:
        return json.loads(ODDS_STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_odds_state(state):
    try:
        ODDS_STATE_PATH.write_text(
            json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except Exception as e:
        print(f"Could not write {ODDS_STATE_PATH}: {e}", file=sys.stderr)


def fetch_odds_primary():
    """Primary source: US sportsbooks via The Odds API."""
    return _fetch_odds_api(ODDS_API_REGIONS_PRIMARY, f"the-odds-api:{ODDS_API_REGIONS_PRIMARY}")


def fetch_odds_secondary():
    """Secondary source: a different book set (us2/uk/eu/au) via The Odds API.

    Distinct coverage from the primary, so it both backstops an empty primary
    payload and adds cross-book lines for fights the US books haven't posted yet.
    Note this spends the SAME quota as the primary — see fetch_odds_backup_key
    and fetch_odds_espn for the sources that survive budget exhaustion.
    """
    return _fetch_odds_api(
        ODDS_API_REGIONS_SECONDARY, f"the-odds-api:{ODDS_API_REGIONS_SECONDARY}"
    )


def fetch_odds_backup_key():
    """Same API, a second account's key — an independent monthly quota (#94).

    Costs nothing when ODDS_API_KEY_SECONDARY is unset (the usual case): the
    provider returns an empty index and the chain moves on.
    """
    if not ODDS_API_KEY_SECONDARY:
        return {}
    return _fetch_odds_api(
        ODDS_API_REGIONS_PRIMARY,
        f"the-odds-api-backup:{ODDS_API_REGIONS_PRIMARY}",
        api_key=ODDS_API_KEY_SECONDARY,
        quota="the-odds-api-backup",
    )


# --- Provider registry and quota-aware selection (#94) ---------------------

class OddsProvider:
    """One source in the odds fallback chain.

    `quota` names the budget the provider spends, so providers sharing a key
    share an exhaustion state; `metered` marks whether it has a budget at all.
    """

    def __init__(self, name, fetch, quota=None, metered=True):
        self.name    = name
        self.fetch   = fetch
        self.quota   = quota or name
        self.metered = metered

    @property
    def __name__(self):          # keeps the existing "Odds source X" logging
        return self.name

    def __call__(self):
        return self.fetch()


# Ordered fallback chain. Higher-priority sources win; later ones only fill the
# fighter-pairs nobody above them covered (see fetch_odds). Append a provider
# here to register a new sportsbook/API.
ODDS_PROVIDERS = [
    OddsProvider("the-odds-api:primary",   fetch_odds_primary,    quota="the-odds-api"),
    OddsProvider("the-odds-api:secondary", fetch_odds_secondary,  quota="the-odds-api"),
    OddsProvider("the-odds-api:backup-key", fetch_odds_backup_key,
                 quota="the-odds-api-backup"),
]
# Back-compat alias: the chain used to be a plain list of callables.
ODDS_SOURCES = ODDS_PROVIDERS

# How long a spent quota bucket is skipped before it is probed again. The Odds
# API resets monthly, so the month rollover unblocks it too — the timer only
# exists so a plan upgrade or an early reset isn't ignored for weeks.
ODDS_QUOTA_RETRY_HOURS = 12


def provider_quota_state(state, quota):
    """The persisted record for one quota bucket ({} when there is none)."""
    providers = (state or {}).get("providers") or {}
    entry = providers.get(quota)
    return entry if isinstance(entry, dict) else {}


def quota_exhausted(pstate):
    """True when a bucket's last call reported a spent budget.

    The Odds API answers 401 for both a rejected key and a spent quota;
    x-requests-remaining tells them apart (0 = spent). A rejected key is a
    different failure and must keep being retried — it never self-heals, and
    quietly skipping it would hide the outage.
    """
    if not pstate:
        return False
    if pstate.get("last_status") == 429:
        return True
    rem = pstate.get("requests_remaining")
    return rem is not None and rem <= 0


def quota_blocked(pstate, now, retry_hours=ODDS_QUOTA_RETRY_HOURS):
    """True when a spent bucket is still inside its cooldown.

    Never blocks forever: a UTC month rollover (when the quota resets) or
    `retry_hours` since exhaustion, whichever comes first, re-opens it. An
    exhaustion with no recorded timestamp is probed rather than skipped, so a
    state file written by an older version can't mute a provider.
    """
    if not quota_exhausted(pstate):
        return False
    at = _parse_ts(pstate.get("exhausted_at"))
    if at is None:
        return False
    if (now.year, now.month) != (at.year, at.month):
        return False
    return (now - at) < timedelta(hours=retry_hours)


def select_odds_providers(providers, state, now):
    """The providers worth calling this run, in priority order (#94).

    Skipping a spent metered provider is the point: it stops the run burning
    time on calls that can only 401, and it is what lets the unmetered ESPN
    fallback actually price a card while the primary budget is gone.
    """
    picked = []
    for p in providers:
        pstate = provider_quota_state(state, getattr(p, "quota", getattr(p, "name", "")))
        if getattr(p, "metered", True) and quota_blocked(pstate, now):
            print(
                f"Odds provider {getattr(p, 'name', p)}: skipped — budget spent "
                f"(remaining {pstate.get('requests_remaining')}, since "
                f"{pstate.get('exhausted_at')})",
                file=sys.stderr,
            )
            continue
        picked.append(p)
    return picked


def record_provider_state(state, now, stats=None):
    """Fold this run's per-provider results into the persisted odds state (#94).

    Sets `exhausted_at` the first time a bucket reports a spent budget and
    clears it as soon as the bucket answers with quota again, which is what
    makes the skip in select_odds_providers self-healing.
    """
    stats = _provider_stats if stats is None else stats
    providers = dict((state or {}).get("providers") or {})
    for quota, result in stats.items():
        prev  = providers.get(quota) if isinstance(providers.get(quota), dict) else {}
        entry = dict(prev)
        entry.update(result)
        entry["last_fetch_at"] = now.isoformat()
        if result.get("bouts"):
            entry["last_ok_at"] = now.isoformat()
        if quota_exhausted(entry):
            entry.setdefault("exhausted_at", now.isoformat())
        else:
            entry.pop("exhausted_at", None)
        providers[quota] = entry
    if providers:
        state["providers"] = providers
    return state


def fetch_odds(sources=None, state=None, now=None):
    """Build the combined fighter-pair odds index by querying each source in
    priority order.

    Each source returns its own tagged index; entries are merged so the first
    source to cover a fighter-pair wins and later sources only fill the gaps. A
    source that fails or parses zero bouts contributes nothing, so the chain
    degrades gracefully instead of leaving a card with no lines (#14/#18). Every
    entry keeps a `source` attribution (see odds_source).

    Passing `state` (the persisted odds state) additionally skips providers whose
    budget is known to be spent, so the unmetered fallback gets its turn instead
    of the run stalling on a dead quota (#94).
    """
    sources = ODDS_PROVIDERS if sources is None else sources
    if state is not None:
        sources = select_odds_providers(sources, state, now or datetime.now(timezone.utc))
    combined = {}
    for src in sources:
        label = getattr(src, "__name__", str(src))
        try:
            idx = src()
        except Exception as e:
            print(f"Odds source {label} error: {e}", file=sys.stderr)
            continue
        added = 0
        for pair, o in idx.items():
            if pair not in combined:
                combined[pair] = o
                added += 1
        print(
            f"Odds source {label}: +{added} new fights ({len(combined)} total)",
            file=sys.stderr,
        )
    if not combined:
        print("No odds from any source", file=sys.stderr)
    return combined


def _match_odds(odds_index, f1_name, f2_name):
    """Find the index entry for a bout by fuzzy name matching.

    Returns (entry, swapped) or (None, False). `swapped` is True when the entry's
    f1/f2 are reversed relative to the queried order.

    Orientation must come from the stored home/away names (f1_name aligns with
    f1_odds, f2_name with f2_odds) — NOT from the index key, which is sorted
    alphabetically. Using the sorted key swapped odds whenever alphabetical order
    differed from home/away order (e.g. "Sean O'Malley" sorts after "Aiemann
    Zahabi", flipping their moneylines).
    """
    f1l    = f1_name.lower()
    f2l    = f2_name.lower()
    f1last = last_name(f1_name)
    f2last = last_name(f2_name)
    for o in odds_index.values():
        n1, n2 = o["f1_name"].lower(), o["f2_name"].lower()
        match_f1    = f1last in n1 or n1 in f1l or f1l in n1
        match_f2    = f2last in n2 or n2 in f2l or f2l in n2
        match_swap1 = f1last in n2 or n2 in f1l or f1l in n2
        match_swap2 = f2last in n1 or n1 in f2l or f2l in n1
        if match_f1 and match_f2:
            return o, False
        if match_swap1 and match_swap2:
            return o, True
    return None, False


def get_odds(odds_index, f1_name, f2_name):
    """Look up odds for a fight by fuzzy name matching. Returns {f1, f2} or None."""
    o, swapped = _match_odds(odds_index, f1_name, f2_name)
    if not o:
        return None
    if swapped:
        return {"f1": o["f2_odds"], "f2": o["f1_odds"]}
    return {"f1": o["f1_odds"], "f2": o["f2_odds"]}


def odds_source(odds_index, f1_name, f2_name):
    """Which registered source supplied this bout's odds, for per-event attribution."""
    o, _ = _match_odds(odds_index, f1_name, f2_name)
    return o.get("source") if o else None


def extract_existing_odds(html):
    """Read odds already embedded in the HTML to preserve them when the API has no data."""
    existing = {}
    for m in EXISTING_ODDS_RE.finditer(html):
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
    stored_slugs = _event_slug_map(html)
    pat = re.compile(
        r'name:"([^"]+)",\s*\n\s*'
        r'date:"(\d{4}-\d{2}-\d{2})",\s*\n\s*'
        r'venue:"([^"]*)",\s*\n\s*'
        r'loc:"([^"]*)"'
    )
    for m in pat.finditer(html):
        ev_name, ev_date, venue, loc = m.groups()
        # Prefer the slug persisted at discovery time (keeps diacritics the
        # ASCII-folded name has lost); fall back to deriving it from the name.
        slug = stored_slugs.get((ev_name, ev_date)) or ev_name.replace(" ", "_")
        if slug in seen:
            continue
        try:
            ed = datetime.strptime(ev_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        # Preserve recent past events through today. (The upcoming-events scraper
        # only sees events still on Wikipedia's "Scheduled" list, which drops them
        # the moment they finish — so just-completed cards must be preserved here,
        # or they vanish into a gap and their picks can no longer be scored.)
        if ed < cutoff or ed > now:
            continue
        seen.add(slug)
        results.append((ev_date, slug, ev_name, venue, loc))
        print(f"  Preserving past event: {ev_name} ({ev_date})", file=sys.stderr)
    return results


def update_results_archive(data, now):
    """
    Maintain a permanent RESULTS_ARCHIVE var in data.js. EVENTS only keeps the
    last 30 days, so finished events (and their results) eventually vanish —
    which silently breaks all-time scoring and any belt/title lineage in the
    frontend. While a past event is still in EVENTS its archive entry is
    re-snapshotted (so late result injections land), and entries are never
    deleted once the event ages out.
    """
    archive = {}
    m = re.search(r"var RESULTS_ARCHIVE=(\{.*?\});", data, flags=re.DOTALL)
    if m:
        try:
            archive = json.loads(m.group(1))
        except ValueError:
            print("Warning: RESULTS_ARCHIVE unparseable — keeping current snapshot only", file=sys.stderr)

    hdr_pat = re.compile(
        r'name:"([^"]+)",\s*\n\s*'
        r'date:"(\d{4}-\d{2}-\d{2})",\s*\n\s*'
        r'venue:"[^"]*"'
    )
    # `lbl` is captured so the archive can say which segment a bout belonged to.
    # EVENTS only holds 30 days, so once a card ages out the archive is the only
    # record of it — and without the label the frontend cannot tell a main-card
    # pick from a prelim, which is what the leaderboard's main-card scope needs.
    # Older entries predate this and fall back to bout order (see _pickInScope).
    fight_pat = re.compile(
        r'\{lbl:"([^"]*)",wc:"[^"]*".*?'
        r'winner:"([^"]+)",method:"([^"]*)",round:(?:\d+|null),state:"post"'
        r'[^{]*f1:\{n:"([^"]+)"[^}]+\},f2:\{n:"([^"]+)"'
    )
    headers = list(hdr_pat.finditer(data))
    today   = now.strftime("%Y-%m-%d")
    changed = 0
    for i, hm in enumerate(headers):
        ev_name, ev_date = hm.group(1), hm.group(2)
        if ev_date >= today:
            continue
        end   = headers[i + 1].start() if i + 1 < len(headers) else len(data)
        chunk = data[hm.end():end]
        fights = [
            {"f1": f1, "f2": f2, "winner": w, "method": meth, "lbl": lbl}
            for lbl, w, meth, f1, f2 in fight_pat.findall(chunk)
        ]
        if not fights:
            continue
        entry = {"name": ev_name, "fights": fights}
        if archive.get(ev_date) != entry:
            changed += 1
        archive[ev_date] = entry

    if not archive:
        return data
    if changed:
        print(f"Results archive: {changed} event(s) added/updated ({len(archive)} total)", file=sys.stderr)
    js_json = json.dumps(archive, separators=(",", ":"), ensure_ascii=False, sort_keys=True)
    if "var RESULTS_ARCHIVE" in data:
        return patch_js_var(data, "RESULTS_ARCHIVE", js_json)
    # First run: declare the var just above EVENTS
    return data.replace("var EVENTS=", f"var RESULTS_ARCHIVE={js_json};\nvar EVENTS=", 1)


def get_odds_with_fallback(odds_index, existing_odds, f1_name, f2_name):
    """Return live odds, falling back to the odds already embedded in the HTML.

    Both the live and fallback result are validated through _valid_odds before
    being returned — a corrupted value already in data.js must not survive into
    the next write just because the live API also returned bad data.
    """
    result = get_odds(odds_index, f1_name, f2_name)
    if result and _valid_odds(result["f1"], result["f2"]):
        return result
    key = frozenset([last_name(f1_name), last_name(f2_name)])
    o   = existing_odds.get(key)
    if not o:
        return None
    if last_name(f1_name) == last_name(o["f1_name"]):
        candidate = {"f1": o["f1_odds"], "f2": o["f2_odds"]}
    else:
        candidate = {"f1": o["f2_odds"], "f2": o["f1_odds"]}
    return candidate if _valid_odds(candidate["f1"], candidate["f2"]) else None

def reprice_card(card, odds_index, existing_odds):
    """Refresh the odds on an existing card in place; returns how many changed.

    Used when the regression guard keeps a previously-built card: the bouts are
    worth keeping, the prices on them are not. get_odds_with_fallback returns the
    line already in data.js when the feed has nothing for a bout, so a bout the
    guard saved never loses the price it already had.
    """
    repriced = 0
    for fight in card:
        fresh = get_odds_with_fallback(
            odds_index, existing_odds, fight["f1"]["name"], fight["f2"]["name"])
        if not fresh:
            continue
        if fresh != fight.get("odds"):
            repriced += 1
        fight["odds"] = fresh
    return repriced


# ---------------------------------------------------------------------------
# Fighter stats  (UFCStats)
# ---------------------------------------------------------------------------

_ufcstats_letter_cache = {}

# UFCStats gates its pages behind a SHA-256 proof-of-work interstitial: the page
# ships a `nonce` and a difficulty, the client finds an `n` whose
# sha256("nonce:n") begins with that many hex zeros, POSTs it to /__c, and is
# handed a `_fmc` cookie (valid ~7 days) that unlocks the real content. It is a
# hashcash challenge, not a browser check, so it replays cleanly in requests —
# solved once per run and reused across every fighter fetch via a shared session.
_ufcstats_session = None


def _get_ufcstats_session():
    global _ufcstats_session
    if _ufcstats_session is None:
        _ufcstats_session = requests.Session()
        _ufcstats_session.headers.update(UFCSTATS_HDR)
    return _ufcstats_session


def _parse_ufcstats_challenge(html):
    """Parse the PoW interstitial. Returns (nonce, difficulty, post_path) or None."""
    m_nonce = re.search(r'nonce\s*=\s*"([0-9a-fA-F]+)"', html)
    m_diff  = re.search(r"new Array\(\s*(\d+)\s*\+\s*1\s*\)\.join\(", html)
    if not (m_nonce and m_diff):
        return None
    m_path = re.search(r"""open\(\s*['"]POST['"]\s*,\s*['"]([^'"]+)['"]""", html)
    return m_nonce.group(1), int(m_diff.group(1)), (m_path.group(1) if m_path else "/__c")


def _solve_ufcstats_pow(nonce, difficulty, _cap=20_000_000):
    """Smallest n where sha256('nonce:n') has `difficulty` leading hex zeros."""
    target = "0" * difficulty
    for n in range(_cap):
        if hashlib.sha256(f"{nonce}:{n}".encode()).hexdigest()[:difficulty] == target:
            return n
    raise RuntimeError(f"UFCStats PoW unsolved within {_cap} (difficulty {difficulty})")


def _ufcstats_get(url, params=None, timeout=20):
    """GET a UFCStats URL, transparently clearing the proof-of-work interstitial."""
    sess = _get_ufcstats_session()
    r = sess.get(url, params=params, timeout=timeout)
    for _ in range(2):  # normally one solve unlocks the whole session for ~7 days
        ch = _parse_ufcstats_challenge(r.text) if r.status_code == 200 else None
        if not ch:
            break
        nonce, difficulty, post_path = ch
        try:
            n = _solve_ufcstats_pow(nonce, difficulty)
            sess.post(
                requests.compat.urljoin(r.url, post_path),
                data=f"nonce={nonce}&n={n}",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=timeout,
            )
        except (requests.RequestException, RuntimeError) as e:
            print(f"  UFCStats challenge solve failed: {e}", file=sys.stderr)
            break
        r = sess.get(url, params=params, timeout=timeout)
    return r


def _load_ufcstats_letter(letter):
    """Fetch all fighters whose last name starts with *letter* from UFCStats. Cached."""
    letter = letter.lower()
    if letter in _ufcstats_letter_cache:
        return _ufcstats_letter_cache[letter]
    try:
        r = _ufcstats_get(
            "http://www.ufcstats.com/statistics/fighters",
            params={"char": letter, "page": "all"},
            timeout=20,
        )
        if r.status_code != 200:
            print(f"  UFCStats letter page ({letter}): HTTP {r.status_code}", file=sys.stderr)
            _ufcstats_letter_cache[letter] = []
            return []
        soup = BeautifulSoup(r.text, "html.parser")
        entries = []
        for row in soup.select("table.b-statistics__table tbody tr"):
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
            # Capture enough to diagnose a structure/anti-bot change from the CI logs
            # without another round-trip: page size, tables, plus the page title and a
            # body preview so a challenge/redirect/error stub is identifiable on sight.
            tables = soup.find_all("table")
            classes = sorted({c for t in tables for c in (t.get("class") or [])})
            title = (soup.title.get_text(strip=True) if soup.title else "")
            preview = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))[:300]
            print(
                f"  UFCStats letter page ({letter}): 0 rows parsed — "
                f"HTTP {r.status_code}, final_url={r.url}, bytes={len(r.text)}, "
                f"tables={len(tables)}, table_classes={classes}, "
                f"has_b-statistics__table={'b-statistics__table' in r.text}, "
                f"title={title!r}, body={preview!r}",
                file=sys.stderr,
            )
        _ufcstats_letter_cache[letter] = entries
        time.sleep(0.5)
        return entries
    except Exception as e:
        print(f"  UFCStats letter fetch error ({letter}): {e}", file=sys.stderr)
        # Don't cache the failure — allow a retry next call for this letter
        return []


_NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def _name_tokens(name):
    """Clean → accent-fold → split on spaces/hyphens/dots → drop generational
    suffixes. The normalised token list used to align card names with UFCStats."""
    s = clean(name).lower().replace(".", " ").replace("-", " ")
    return [t for t in s.split() if t and t not in _NAME_SUFFIXES]


def _name_tokens_match(row_first, row_last, target_name):
    """Match a UFCStats (first, last) row against a card name.

    UFCStats stores first/last separately and files particle surnames under the
    particle ("Du Plessis", "De Ridder"), keeps generational suffixes, and lists
    some names in the opposite order. The old rule (row last-name == the card's
    *last token*) silently missed all of those. Here both sides are reduced to a
    normalised token list and matched order-independently, while still requiring
    the surname to line up so distinct fighters aren't conflated.
    """
    t   = _name_tokens(target_name)
    row = _name_tokens(row_first) + _name_tokens(row_last)
    if not t or not row:
        return False
    # Exact token set (any order): particle surnames, suffixes, reversed order.
    if set(t) == set(row):
        return True
    # Otherwise the surname must appear and a given name must be compatible
    # (Jon/Jonathan, Saint/St.); extra given names are ignored so a dropped one
    # (UFCStats "Ian Garry" vs card "Ian Machado Garry") still matches.
    #
    # Given names are compared as sets, not first-token-to-anything: UFCStats
    # keeps only part of a multi-part given name, and the part it keeps is not
    # always the leading one. Pinning the comparison to t[0] matched a dropped
    # *middle* name but silently missed a dropped *leading* one — UFCStats
    # "Diego Ferreira" never matched the card's "Carlos Diego Ferreira", so that
    # fighter's record stayed blank on the card. The surname check above still
    # pins identity, so widening this cannot conflate different fighters.
    surname = t[-1]
    if surname not in row:
        return False
    if len(t) == 1:
        return True
    givens_t   = [x for x in t   if x != surname]
    givens_row = [x for x in row if x != surname]
    return any(
        a == b or a.startswith(b[:2]) or b.startswith(a[:2])
        for a in givens_t
        for b in givens_row
    )


# Card name → the name UFCStats files the fighter under. Last resort, for the
# handful of fighters whose UFCStats surname is a different word entirely (a
# nickname promoted to surname, or a dropped family name) — no token matcher can
# bridge that, because there is no shared surname to pin identity on. Everything
# that IS bridgeable (particles, suffixes, dropped given names, reversed order)
# belongs in _name_tokens_match, not here. Keys are clean()ed + lowercased.
_UFCSTATS_NAME_ALIASES = {
    # Wikipedia/Sherdog list him as Jose "Montanha" Luiz; UFCStats and the UFC
    # both file him under Montanha, so the card name shares no surname with the
    # UFCStats row and his record rendered blank.
    "jose luiz": "Jose Montanha",
}


# How many same-name candidates are worth a disambiguating page fetch. Ambiguity
# is rare, so this only ever costs requests on the handful of names that need it.
_UFCSTATS_DISAMBIG_MAX = 4
# "Sep. 05, 2026" / "September 5, 2026" as UFCStats writes fight dates.
_UFCSTATS_DATE_RE = re.compile(r"([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})")


def parse_ufcstats_date(text):
    """The first 'Mon DD, YYYY' date in *text* as a date, or None."""
    m = _UFCSTATS_DATE_RE.search(text or "")
    if not m:
        return None
    month = MONTH_MAP.get(m.group(1)[:3].lower())
    if not month:
        return None
    try:
        return datetime(int(m.group(3)), month, int(m.group(2))).date()
    except ValueError:
        return None


def order_ufcstats_matches(matches, last_dates):
    """Order same-name UFCStats rows, best match first. Pure.

    The old rule was "most total fights", on the theory that the busiest record
    belongs to the active roster member. It doesn't, and the failure is silent:
    a two-time UFC prospect loses to any retired journeyman who shares his name.
    Petr Yan resolved to an 11-13 fighter born in 1980 and Jean Silva to a
    48-year-old with a single UFC bout — both wrong records on a live card, and
    both fed straight into the fight model, which then "disagreed" with the
    market by 40+ points on the strength of the wrong man's stats.

    Recency is the signal that actually separates them: whoever fought most
    recently is the one a current card means. Total fights stays as the
    tie-break, for candidates whose last-fight date couldn't be read.
    """
    def key(m):
        d = last_dates.get(m[0])
        return (d is not None, d or date.min, m[1] + m[2] + m[3])
    return sorted(matches, key=key, reverse=True)


def _ufcstats_last_fight_date(url):
    """Date of the most recent bout listed on a UFCStats fighter page, or None."""
    try:
        r = _ufcstats_get(url, timeout=15)
        if r.status_code != 200:
            return None
        soup = BeautifulSoup(r.text, "html.parser")
        dates = []
        for row in soup.select("tbody.b-fight-details__table-body tr"):
            cells = row.select("td")
            if len(cells) < 7:
                continue
            d = parse_ufcstats_date(cells[6].get_text(" ", strip=True))
            if d:
                dates.append(d)
        return max(dates) if dates else None
    except Exception as e:
        print(f"  UFCStats: could not date {url}: {e}", file=sys.stderr)
        return None


def _search_ufcstats(name):
    """Search UFCStats for *name* by name-token initial. Returns (url, record) or None.

    Candidates are gathered from EVERY letter page before one is chosen. Stopping
    at the first page with a hit is what put an 11-13-0 fighter born in 1980 on
    the card as Petr Yan: UFCStats lists that namesake surname-first ("Yan Petr"),
    which files him under P, and P is searched before Y — so the real Yan's page
    was never even loaded, and the tie-break below never ran because only one
    candidate had been seen.
    """
    name = _UFCSTATS_NAME_ALIASES.get(clean(name).lower(), name)
    toks = _name_tokens(name)
    if not toks:
        return None
    # Search the initial of every name token: a particle surname is filed under
    # the particle ("De Ridder" → D), and reversed name order or a compound
    # surname can put the fighter under any of their tokens' letters.
    letters = []
    for tok in toks:
        if tok[0] not in letters:
            letters.append(tok[0])
    for attempt in range(2):  # one retry on empty result
        matches, empty = [], False
        for letter in letters:
            rows = _load_ufcstats_letter(letter)
            if not rows:
                empty = True
                if attempt == 0:
                    # Letter page returned empty — clear cache so the retry refetches.
                    _ufcstats_letter_cache.pop(letter, None)
                continue
            for row_first, row_last, href, w, l, d in rows:
                if _name_tokens_match(row_first, row_last, name):
                    matches.append((href, w, l, d))
        # De-duplicate: a fighter can appear on more than one letter page when
        # both of their name tokens share an initial with the search.
        seen, unique = set(), []
        for m in matches:
            if m[0] in seen:
                continue
            seen.add(m[0])
            unique.append(m)
        matches = unique
        if matches:
            if len(matches) > 1:
                print(
                    f"  UFCStats: {len(matches)} fighters match {name!r} — "
                    f"picking the most recently active",
                    file=sys.stderr,
                )
                probes = matches[:_UFCSTATS_DISAMBIG_MAX]
                last_dates = {
                    m[0]: _ufcstats_last_fight_date(m[0]) for m in probes
                }
                matches = order_ufcstats_matches(probes, last_dates)
                print(
                    "  UFCStats: "
                    + ", ".join(
                        f"{m[1]}-{m[2]}-{m[3]} last {last_dates.get(m[0]) or '?'}"
                        for m in matches
                    ),
                    file=sys.stderr,
                )
            href, w, l, d = matches[0]
            return (href, f"{w}-{l}-{d}" if (w or l) else "")
        if not empty:
            break            # pages loaded fine, the name simply isn't there
        if attempt == 0:
            time.sleep(2)
    return None


def _norm_name(n):
    """Last name, lowercased, accents stripped — for rematch cross-reference."""
    n = unicodedata.normalize("NFD", n)
    n = "".join(c for c in n if unicodedata.category(c) != "Mn")
    parts = n.strip().split()
    return parts[-1].lower() if parts else ""


def _norm_full(n):
    """Full name, lowercased, accents stripped, whitespace-collapsed. Used for
    opponent-history rematch matching, where last-name-only comparison conflates
    distinct fighters who happen to share a surname."""
    n = unicodedata.normalize("NFD", n)
    n = "".join(c for c in n if unicodedata.category(c) != "Mn")
    return " ".join(n.lower().split())


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


def _wiki_record(wikitext):
    """Derive a 'W-L-D' record from a fighter's Wikipedia infobox.

    {{Infobox martial artist}} carries ``wins`` / ``losses`` / ``draws`` fields,
    which is a far more stable source than scraping a rendered stats table — and
    the fallback that keeps records fresh when UFCStats is unavailable. Returns ''
    when the fields can't be found (no infobox, or a non-fighter page).
    """
    if not wikitext:
        return ""
    def field(name):
        # Anchor on the '|' so 'wins' doesn't also match 'amateur wins' / 'ko wins'.
        m = re.search(r'\|\s*' + name + r'\s*=\s*(\d+)', wikitext, re.IGNORECASE)
        return m.group(1) if m else None
    w, l = field("wins"), field("losses")
    if w is None or l is None:
        return ""
    return f"{w}-{l}-{field('draws') or '0'}"


def fetch_wiki_record(name):
    """Fetch a fighter's Wikipedia page and return their 'W-L-D' record (or '')."""
    return _wiki_record(fetch_wikitext(name.replace(" ", "_")))


# How often a cached fighter is re-validated from UFCStats, and how long we wait
# before retrying one whose fetch failed. The record and opponent list are the
# only fields that silently go wrong (a stale/incorrect record freezes forever,
# an empty opponent list breaks rematch detection), so entries are refreshed on
# a cadence rather than cached once and trusted indefinitely.
STATS_REFRESH_DAYS = 14   # re-validate a cached fighter (record + opponents) this often
STATS_RETRY_DAYS   = 3    # cooldown before retrying a fighter whose fetch failed
# ...except for fighters on an imminent card, who are retried every run. The flat
# 3-day cooldown was silently fatal: Carlos Diego Ferreira and Jose Luiz both
# failed their lookup on Aug 6 for a card on Aug 8, so the cooldown ran to Aug 9
# and they were structurally guaranteed to show a blank record right through the
# event. Close to a card, a wasted retry costs one request; a blank record costs
# the card.
STATS_URGENT_DAYS  = 7    # a card this close retries failures + refreshes every run
# No fighter on a UFC card is this old. A cached profile that says otherwise
# belongs to a namesake, not to the fighter it is filed under — and the freshness
# cadence alone will never repair it, because a WRONG entry looks exactly as
# fresh as a right one. Petr Yan sat on a title co-main as an 11-13-0 fighter
# born in 1980: the run that cached him stamped fetched_at, so the search fix
# that shipped hours later was locked out for the full STATS_REFRESH_DAYS.
STATS_MAX_PLAUSIBLE_AGE   = 44
# ...but re-searching every run would be wasteful (and would loop forever on a
# genuine 45-year-old), so an implausible profile is re-derived at most daily.
STATS_MISMATCH_RECHECK_H  = 24


def _parse_ts(s):
    """Parse an ISO timestamp; treat anything unparseable as long-stale.

    A naive value is assumed to be UTC so the caller's tz-aware arithmetic never
    raises — a single bad timestamp must not abort the whole scrape.
    """
    try:
        dt = datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _profile_age_years(entry, now):
    """Age implied by a cached profile's UFCStats DOB, or None if unreadable."""
    try:
        born = datetime.strptime(entry.get("dob", ""), "%b %d, %Y")
    except (TypeError, ValueError):
        return None
    return (now - born.replace(tzinfo=timezone.utc)).days / 365.25


def profile_is_implausible(entry, now):
    """True when a cached profile cannot be the fighter it is filed under.

    Deliberately one narrow test rather than a general "does this look right"
    heuristic: age is the tell that no real roster member can produce, and a
    false positive here only costs one extra search per day. health.py reports
    the same condition (plus a ranking-based one it has the data for); this is
    the half that has to live in the scraper, because detection that cannot
    trigger a correction just describes the problem for two weeks.
    """
    age = _profile_age_years(entry or {}, now)
    return age is not None and age >= STATS_MAX_PLAUSIBLE_AGE


def _needs_stats_fetch(entry, now, urgent=False):
    """Decide whether a fighter's cached stats should be (re)fetched this run.

    Returns (fetch: bool, force_search: bool). ``force_search`` requests the
    authoritative UFCStats *search* path (which re-derives the win-loss record)
    rather than a cheap re-hit of the cached detail URL.

    ``urgent`` marks a fighter booked on a card inside STATS_URGENT_DAYS: the
    failure cooldown and the refresh window are both bypassed, because a gap that
    persists until the card is a gap the user sees.

    Legacy entries written before this cadence existed carry no ``fetched_at``
    stamp, so they are treated as stale and re-validated once — which is what
    repairs a frozen wrong record or an opponent list emptied by a past failure.
    """
    if not entry:
        return True, True                       # brand new → full search fetch
    if urgent and (entry.get("fetch_failed") or not entry.get("rec")):
        return True, True                       # imminent card + known gap → retry now
    failed = entry.get("fetch_failed")
    if failed and now - _parse_ts(failed) < timedelta(days=STATS_RETRY_DAYS):
        return False, False                     # failed recently → cooldown, skip
    if "form" not in entry or "opp" not in entry:
        return True, False                      # incomplete → cheap cached-URL refetch
    fetched = entry.get("fetched_at")
    if not fetched or now - _parse_ts(fetched) >= timedelta(days=STATS_REFRESH_DAYS):
        return True, True                       # stale/legacy → re-validate via search
    # A profile that cannot belong to this fighter is re-derived from the search
    # page whatever its freshness stamp says — otherwise the entry that is wrong
    # is precisely the one nothing ever revisits.
    if (profile_is_implausible(entry, now)
            and now - _parse_ts(fetched) >= timedelta(hours=STATS_MISMATCH_RECHECK_H)):
        return True, True
    return False, False


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
        dr = _ufcstats_get(detail_url, timeout=15)
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
                # Opponent name: cells_d[1] has two <a> tags — self then opponent.
                # Only record COMPLETED bouts: UFCStats lists a fighter's next
                # scheduled fight as a "next" row, and counting that upcoming
                # opponent made the rematch check fire for every booked bout.
                if result_txt in ("win", "loss", "draw"):
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


def extract_card_records(html):
    """Map each fighter name to their last-known record from the existing card data.

    A full rebuild reconstructs every fight with an empty record and refills only
    what UFCStats/Wikipedia can currently resolve. Names UFCStats can't match
    (particle surnames like "du Plessis"/"de Ridder", "Jr."/"III" suffixes,
    romanised names) would otherwise be blanked on every run. This lets the
    rebuild fall back to the record already on the page — better stale than empty.
    """
    records = {}
    for name, rec in re.findall(r'\{n:"([^"]+)",r:"([^"]*)"', html):
        if rec and name not in records:
            records[name] = rec
    return records

# ---------------------------------------------------------------------------
# Push notifications
# ---------------------------------------------------------------------------

def send_push_notifications(new_results):
    """Send win/loss push notifications for newly resolved fights.

    push_subs is readable only by the service role (RLS), so the actual web-push
    delivery happens inside the send-push edge function. This groups pickers of
    each fight into win/loss lists and makes one targeted call per group. The
    function's notif_log dedup (event_date + type) makes re-sends from
    overlapping cron runs no-ops.
    """
    if not new_results:
        return
    if not SUPABASE_ANON:
        print("Push skipped: SUPABASE_ANON not set", file=sys.stderr)
        return
    picks = sb_get("/rest/v1/picks?select=user_id,f1,f2,pick")
    if not picks:
        print("Push skipped: no picks available (Supabase empty or unreachable)", file=sys.stderr)
        return
    for res in new_results:
        winner, loser = res["winner"], res["loser"]
        event_date = res.get("event_date", "")
        # Recency guard: a full rebuild re-injects an entire recent card at once,
        # so every fight looks "newly injected" here. notif_log dedups fights
        # already announced (by an earlier run or a client-side trigger), and
        # this bounds whatever remains to genuinely-recent cards — so a catch-up
        # rebuild can back up the live path without ever firing stale spoilers
        # for an event that aged out and got re-scraped. Live fights are same-day.
        if event_date:
            try:
                ed = datetime.strptime(event_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                if ed < datetime.now(timezone.utc) - timedelta(days=2):
                    continue
            except ValueError:
                pass
        winners, losers = [], []
        for pick in picks:
            f1, f2, chosen = pick["f1"], pick["f2"], pick["pick"]
            is_this_fight = (
                (names_match(f1, winner) and names_match(f2, loser))
                or (names_match(f2, winner) and names_match(f1, loser))
            )
            if not is_this_fight or not pick.get("user_id"):
                continue
            (winners if names_match(chosen, winner) else losers).append(pick["user_id"])
        # asc() before the slug: an unfolded "ł" survives the lowercase and comes
        # out as a separator here ("sygu-a"), which is a different key from the
        # "sygua" every folded sender derives — and a different key means a
        # second notification for the same fight. Fold at the key, not only
        # upstream, so it is stable whichever spelling reaches this function.
        fight_key = re.sub(r"[^a-z0-9]+", "-", asc(f"{winner}-{loser}").lower()).strip("-")
        # safe_title/safe_body is the spoiler-free variant — identical for both
        # groups and naming no winner, so neither the text nor a difference
        # between notifications can leak the result. The send-push function
        # delivers it to everyone except subscribers who opted in to live
        # results (push_subs.live_results), who get the full title/body.
        for group, user_ids, title, body in (
            ("win",  winners, "Your pick WON! 🔥", f"{winner} def. {loser} — you called it!"),
            ("loss", losers,  "Tough luck ❌",      f"{winner} def. {loser}"),
        ):
            if not user_ids:
                continue
            try:
                r = requests.post(
                    f"{SUPABASE_URL}/functions/v1/send-push",
                    headers={
                        "Authorization": f"Bearer {SUPABASE_ANON}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "event_date": event_date,
                        "type": f"result:{fight_key}:{group}",
                        "title": title,
                        "body": body,
                        "safe_title": "🥊 Fight result is in",
                        "safe_body": "A fight you picked is final — open the app to see how you did. (No spoilers here!)",
                        "include_user_ids": user_ids,
                    },
                    timeout=15,
                )
                r.raise_for_status()
                print(
                    f"  Push {group} ({winner} def. {loser}): {r.json()}",
                    file=sys.stderr,
                )
            except Exception as e:
                print(f"  Push failed ({group}, {winner} def. {loser}): {e}", file=sys.stderr)

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
            # Locate the fight object's extent by brace depth. A name carrying
            # stray braces (see clean_wiki) never balances, leaving fe == fs and
            # an EMPTY slice — whose substitutions changed nothing while still
            # counting as an injection. main() exits on any injection, so that
            # phantom result blocked every rebuild (odds, stats, rankings) for as
            # long as the event stayed in the results window. Skip a fight we
            # cannot delimit instead of silently editing nothing.
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
            if fe <= fs:
                print(f"  WARNING: unbalanced fight object near {f1n} vs {f2n} "
                      "— cannot inject result", file=sys.stderr)
                break
            fstr = js[fs:fe]
            fstr = re.sub(r'winner:"[^"]*"',     lambda _: f'winner:"{wn}"',     fstr)
            fstr = re.sub(r'method:"[^"]*"',     lambda _: f'method:"{method}"', fstr)
            fstr = re.sub(r"round:(?:null|\d+)", f"round:{rnd if rnd else 'null'}", fstr)
            fstr = re.sub(r'state:"[^"]*"',      lambda _: 'state:"post"',       fstr)
            if fstr == js[fs:fe]:
                # Nothing actually changed. Counting this would report an
                # injection that never happened and, via main(), skip the rebuild.
                break
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


def _dedupe_events(events):
    """Collapse events that share a (name, date) to a single richest entry.

    Discovery keys de-duplication on the Wikipedia slug, so the same event can be
    built twice under different slugs — most damagingly a title-fallback stub
    (one TBD bout derived from the event name) colliding with the fully-parsed
    card preserved from existing data. Keep the version with the most fights, in
    first-seen order, so a stub can never shadow or duplicate the real card.
    """
    best = {}
    for ev in events:
        key = (ev.get("name"), ev.get("date"))
        if key not in best or len(ev.get("fights", [])) > len(best[key].get("fights", [])):
            best[key] = ev
    seen, out = set(), []
    for ev in events:
        key = (ev.get("name"), ev.get("date"))
        if key in seen:
            continue
        seen.add(key)
        out.append(best[key])
    if len(out) != len(events):
        print(f"Deduped events: {len(events)} -> {len(out)}", file=sys.stderr)
    return out


_EXIST_FIGHT_PAT = re.compile(
    r'\{lbl:(?P<lbl>"[^"]*"|null),wc:(?P<wc>"[^"]*"|null),'
    r'title:(?P<title>true|false),rematch:(?P<rematch>true|false),'
    r'odds:(?P<odds>\{f1:[^,}]+,f2:[^}]+\}|null),'
    r'winner:(?P<winner>"[^"]*"),method:(?P<method>"[^"]*"),'
    r'round:(?P<round>\d+|null),state:(?P<state>"[^"]*"),'
    r'f1:\{n:"(?P<f1n>[^"]+)",r:"(?P<f1r>[^"]*)",rk:"(?P<f1rk>[^"]*)",s:[^}]*\},'
    r'f2:\{n:"(?P<f2n>[^"]+)",r:"(?P<f2r>[^"]*)",rk:"(?P<f2rk>[^"]*)",s:[^}]*\}\}'
)


def _extract_existing_cards(data):
    """Parse the fight card already serialised in data.js, keyed by (name, date).

    A full rebuild re-scrapes each event from Wikipedia. Once an event is over,
    Wikipedia rewrites its page from an announced-bouts table into a results
    table that parse_upcoming_card can't read, so the parse returns nothing and
    the title-regex fallback synthesises a one-bout stub from the event name —
    which then overwrites the real card AND drops every result already injected.
    Reading the existing card back lets step_build_events refuse to shrink a card
    (see the regression guard), so a bad parse can never destroy good data.
    """
    cards = {}
    hdr = re.compile(r'name:"([^"]+)",\s*\n\s*date:"(\d{4}-\d{2}-\d{2})",')
    heads = list(hdr.finditer(data))
    for i, h in enumerate(heads):
        name, date = h.group(1), h.group(2)
        end = heads[i + 1].start() if i + 1 < len(heads) else len(data)
        chunk = data[h.end():end]
        fights = []
        for fm in _EXIST_FIGHT_PAT.finditer(chunk):
            odds = None
            om = re.match(r'\{f1:([^,}]+),f2:([^}]+)\}', fm.group("odds"))
            if om:
                def _num(x):
                    x = x.strip()
                    try:
                        return int(x)
                    except ValueError:
                        try:
                            return float(x)
                        except ValueError:
                            return x
                odds = {"f1": _num(om.group(1)), "f2": _num(om.group(2))}
            lbl = json.loads(fm.group("lbl")) if fm.group("lbl") != "null" else ""
            wc  = json.loads(fm.group("wc")) if fm.group("wc") != "null" else "TBD"
            fights.append({
                "label":   lbl,
                "wc":      wc,
                "title":   fm.group("title") == "true",
                "rematch": fm.group("rematch") == "true",
                "odds":    odds,
                "winner":  json.loads(fm.group("winner")),
                "method":  json.loads(fm.group("method")),
                "round":   None if fm.group("round") == "null" else int(fm.group("round")),
                "state":   json.loads(fm.group("state")),
                "f1": {"name": fm.group("f1n"), "record": fm.group("f1r"), "ranking": fm.group("f1rk")},
                "f2": {"name": fm.group("f2n"), "record": fm.group("f2r"), "ranking": fm.group("f2rk")},
            })
        if fights:
            cards[(name, date)] = fights
    return cards


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
        ]
        # Persist the article slug so later runs never have to rebuild it from
        # the ASCII-folded name (which loses diacritics — Medić → Medic — and
        # then points at a title that doesn't exist). Written after loc: so the
        # name/date/venue/loc adjacency other regexes rely on stays intact.
        if ev.get("slug"):
            lines.append(f"    slug:{json.dumps(ev['slug'])},")
        lines += [
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

def _wiki_event_slug(ev_name):
    """Wikipedia article slug for an event name.

    A numbered PPV's article is titled just "UFC 329" — the full
    "UFC 329: McGregor vs. Holloway 2" is only a redirect, whose short stub the
    fetcher discards, so results were never read. A Fight Night's article IS the
    full "UFC Fight Night: A vs. B" title, so keep that as-is.
    """
    m = re.match(r"UFC\s+\d+", ev_name)
    base = m.group(0) if m else ev_name
    return re.sub(r"[^a-zA-Z0-9 :._-]", "", base).replace(" ", "_")


def step_inject_results(data, now):
    """
    Check Wikipedia for results from events in the past 2 days and inject them
    into the data.js text. Returns (updated_data, new_results) on success,
    (None, []) if nothing changed.
    """
    ex_names = re.findall(r'name:"([^"]+)"', data)
    ex_dates = re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', data)
    ex_slugs = _event_slug_map(data)

    js             = data
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
        slug = ex_slugs.get((ev_name, ev_date)) or _wiki_event_slug(ev_name)
        wt   = fetch_event_wikitext(ev_name, slug)
        if not wt:
            print(f"WARNING: no results page reachable for {ev_name} "
                  f"({ev_date}) — tried slug '{slug}' and title search; "
                  "results cannot update until this resolves", file=sys.stderr)
            continue
        results = parse_results(wt)
        if results:
            js, n = inject_results(js, results)
            total_injected += n
            if n:
                for r in results:
                    r["event_date"] = ev_date
                new_results.extend(results)
        time.sleep(1)

    if not total_injected:
        return None, []

    updated = patch_js_var(js, "GENERATED_AT", f'"{fmt_update(now)}"')
    return updated, new_results


def step_build_events(data, now):
    """
    Rebuild the EVENTS block from Wikipedia and The Odds API, refresh fighter
    stats, and update rankings. Returns the updated data.js string.
    """
    existing_odds  = extract_existing_odds(data)
    existing_cards = _extract_existing_cards(data)

    # Odds are quota-metered; pull only when the cadence allows (see
    # should_fetch_odds). Skipping is safe — the empty index falls through to the
    # lines already in data.js.
    odds_state = load_odds_state()
    days_out   = _next_event_days_out(data, now)
    idle_pulls = odds_state.get("idle_pulls", 0)
    if should_fetch_odds(now, odds_state.get("last_fetch_at"), days_out, idle_pulls):
        print(f"Fetching odds (next card {days_out}d out)...", file=sys.stderr)
        odds_index = fetch_odds(state=odds_state, now=now)
        digest     = odds_lines_digest(odds_index)
        odds_state["idle_pulls"] = next_idle_pulls(
            idle_pulls, odds_state.get("lines_digest"), digest)
        # Only a pull that returned lines updates the fingerprint. Overwriting it
        # with None on a failed pull would make the NEXT successful pull look like
        # movement and reset the backoff for no reason.
        if digest is not None:
            odds_state["lines_digest"] = digest
        odds_state["last_fetch_at"] = now.isoformat()
        odds_state["last_status"]   = _odds_last_status
        if _odds_requests_remaining is not None:
            odds_state["requests_remaining"] = _odds_requests_remaining
        odds_state["next_event_days_out"] = days_out
        # Per-provider budgets, so the next run can skip a spent one and let the
        # unmetered fallback price the card instead (#94).
        record_provider_state(odds_state, now)
        save_odds_state(odds_state)
        if odds_state["idle_pulls"]:
            print(
                f"Odds unchanged for {odds_state['idle_pulls']} consecutive pull(s) "
                f"— next wait x{odds_activity_multiplier(odds_state['idle_pulls'])}",
                file=sys.stderr,
            )
    else:
        odds_index = {}
        iv = odds_min_interval_hours(days_out)
        mult = odds_activity_multiplier(idle_pulls)
        print(
            f"Skipping odds pull — next card {days_out}d out, "
            f"min interval {iv}h x{mult} (idle {idle_pulls}), "
            f"last pull {odds_state.get('last_fetch_at')}",
            file=sys.stderr,
        )

    print("Building events from Wikipedia...", file=sys.stderr)
    discovered = discover_upcoming_events(now)
    seen_slugs = {slug for _, slug, *_ in discovered}

    # Include recent past events from the current data.js that Wikipedia's
    # "Scheduled" section no longer lists — ensures results for events in the
    # last 30 days are preserved when the EVENTS array is rebuilt.
    past = extract_recent_past_events(data, now, seen_slugs)

    merged = [
        (ev_date, slug, ev_name, venue, loc) + _event_times(ev_name, loc)
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
        main_time, prelim_time = resolve_event_times(
            ev_name, ev_date, main_time, prelim_time, loc)
        _warn_if_implausible_time(ev_name, loc, main_time)
        wt          = fetch_event_wikitext(ev_name, slug)
        # If the direct slug missed and the title search found the real
        # article, persist the resolved slug rather than the broken one.
        slug        = _event_slug_cache.get(ev_name) or slug
        wiki_fights = parse_upcoming_card(wt) if wt else []
        print(f"  Wiki fights found: {len(wiki_fights)}", file=sys.stderr)

        if not wiki_fights:
            m = re.search(r":\s*(\w+)\s+vs\.?\s+(\w+)", ev_name, re.IGNORECASE)
            if m:
                wiki_fights = [{"f1": m.group(1), "f2": m.group(2), "wc": "TBD", "title": False}]

        card = []
        no_prelims = ev_name in _NO_PRELIM_CARDS
        for i, wf in enumerate(wiki_fights):
            if i == 0:        lbl = "Main Event"
            elif i == 1:      lbl = "Co-Main"
            elif no_prelims:  lbl = "Main Card"
            elif i < 5:       lbl = "Main Card"
            else:             lbl = "Prelim"
            f1, f2 = wf["f1"], wf["f2"]
            wiki_rematch = wf.get("rematch", False) or _wiki_rematch(wt, f1, f2)
            if wiki_rematch:
                print(f"  Rematch (wiki): {f1} vs {f2}", file=sys.stderr)
            # Layer 4: BOTH fighters' Wikipedia fight records must confirm the past bout.
            # Requiring cross-confirmation eliminates false positives from common surnames
            # or upcoming fights inadvertently appearing in one fighter's record. Runs for
            # every bout, not just the headliners — mid-card rematches (e.g. Sandhagen vs
            # Bautista II) were being missed when the event page didn't spell out "rematch".
            if not wiki_rematch:
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
        # Regression guard: never let a bad/partial parse shrink a card that we
        # already have. Once an event is over, Wikipedia's page flips to a results
        # table parse_upcoming_card can't read, so the parse returns nothing and the
        # title-regex fallback above builds a one-bout stub from the event name. That
        # stub (or any partial parse) must not replace the fuller card — with all its
        # injected results — already in data.js. Keep whichever card has more fights.
        prev = existing_cards.get((ev_name, ev_date))
        if prev and len(prev) > len(card):
            print(f"  Card regression guard: parse gave {len(card)} fight(s) for "
                  f"{ev_name}; keeping existing {len(prev)}-fight card", file=sys.stderr)
            # Keep the fuller card, but NOT its stale prices. Swapping the whole
            # card also discarded the lines this run just fetched, so an event
            # that trips the guard every run could never be priced at all: the
            # Sep 5 2026 card matched 12 of 13 bouts against a healthy Odds API
            # and still published with zero odds, which then reported as a parse
            # failure. Re-price the bouts we keep; get_odds_with_fallback returns
            # the existing line when the feed has nothing, so a bout the guard
            # saved never loses the price it already had.
            card = prev
            repriced = reprice_card(card, odds_index, existing_odds)
            if repriced:
                print(f"  Re-priced {repriced} bout(s) on the kept card",
                      file=sys.stderr)
        if not card:
            continue
        # Per-event source attribution: count which adapter covered each bout's
        # line, so a card filled by the secondary fallback is visible in the logs.
        # Count over the card being PUBLISHED, not the parse that produced it.
        # Reading from wiki_fights meant a guard-kept card reported the sources of
        # bouts it had just discarded — the log said 12 bouts priced on a card
        # that shipped with none.
        src_counts = {}
        for fight in card:
            src = odds_source(
                odds_index, fight["f1"]["name"], fight["f2"]["name"]) or "none"
            src_counts[src] = src_counts.get(src, 0) + 1
        print(f"  Odds sources for {ev_name}: {src_counts}", file=sys.stderr)
        # Free second opinion on the clock, from the payload already fetched.
        main_time, prelim_time = reconcile_times_with_odds(
            ev_name, loc, main_time, prelim_time,
            odds_card_start_et(odds_index, card, ev_date))
        new_events.append({
            "name":        ev_name,
            "date":        ev_date,
            "venue":       venue,
            "loc":         loc,
            "slug":        slug,
            "tv":          "Paramount+",
            "time":        main_time,
            "prelimTime":  prelim_time,
            "fights":      card,
        })
        print(f"  Built: {ev_name} ({len(card)} fights)", file=sys.stderr)
        time.sleep(1)

    if not new_events:
        print("No events built — keeping existing data.js", file=sys.stderr)
        return data

    # Preserve results already injected into the existing data so a full rebuild
    # never wipes winners for fights that finished more than 2 days ago.
    _post_pat = re.compile(
        r'winner:"([^"]+)",method:"([^"]*)",round:(\d+|null),state:"post"[^{]*'
        r'f1:\{n:"([^"]+)"[^}]+\},f2:\{n:"([^"]+)"'
    )
    existing_results = {}
    for m in _post_pat.finditer(data):
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

    # Fighter stats — fetch new, backfill missing form, refresh changed records.
    # Fighters booked inside STATS_URGENT_DAYS are marked urgent so a previously
    # failed lookup is retried immediately rather than waiting out its cooldown.
    stats_cache  = extract_stats_cache(data)
    all_fighters = {}
    for ev in new_events:
        try:
            ed = datetime.strptime(ev["date"], "%Y-%m-%d").replace(tzinfo=timezone.utc)
            days_out = (ed - now).days
        except (ValueError, KeyError):
            days_out = 999
        urgent = 0 <= days_out <= STATS_URGENT_DAYS
        for fight in ev["fights"]:
            for side in (fight["f1"], fight["f2"]):
                n = side.get("name")
                if n and n != "TBD":
                    all_fighters[n] = all_fighters.get(n, False) or urgent
    to_fetch = []
    for n in sorted(all_fighters):
        fetch, force_search = _needs_stats_fetch(
            stats_cache.get(n), now, urgent=all_fighters[n])
        if fetch:
            to_fetch.append((n, force_search))
    print(
        f"Fetching stats for {len(to_fetch)} fighters "
        f"({sum(1 for n, _ in to_fetch if n not in stats_cache)} new)...",
        file=sys.stderr,
    )
    for fname, force_search in to_fetch:
        # force_search bypasses the cached detail URL so the record is re-derived
        # from the UFCStats search page — the only source that carries it.
        cached_url = None if force_search else stats_cache.get(fname, {}).get("url")
        prev_rec = stats_cache.get(fname, {}).get("rec", "")
        s = fetch_fighter_stats(fname, cached_url=cached_url)
        if s:
            if not s.get("rec"):
                # A cached-URL hit carries no record; if UFCStats search also had
                # none, fall back to Wikipedia rather than blanking a known record.
                s["rec"] = prev_rec or fetch_wiki_record(fname)
            elif prev_rec and s["rec"] != prev_rec:
                print(f"  Record change [{fname}]: {prev_rec} -> {s['rec']}", file=sys.stderr)
            s["fetched_at"] = now.isoformat()
            stats_cache[fname] = s            # replace wholesale → clears any prior fetch_failed
        else:
            # UFCStats is unavailable for this fighter. Never fabricate an empty
            # opponent list (that used to poison rematch detection); mark the
            # failure for a bounded retry, but still refresh the record from
            # Wikipedia so a UFCStats outage can't freeze it.
            entry = stats_cache.setdefault(fname, {})
            wrec = fetch_wiki_record(fname)
            if wrec and wrec != entry.get("rec"):
                if entry.get("rec"):
                    print(f"  Record change [{fname}] (wiki): {entry['rec']} -> {wrec}", file=sys.stderr)
                entry["rec"] = wrec
            entry["fetch_failed"] = now.isoformat()
        time.sleep(1)
    print(f"Stats cache: {len(stats_cache)} fighters", file=sys.stderr)

    # Back-fill fighter records: prefer the freshly-fetched UFCStats record, but
    # fall back to the last-known record already on the card so a rebuild never
    # blanks a fighter UFCStats/Wikipedia couldn't resolve this run.
    prev_records = extract_card_records(data)
    for ev in new_events:
        for fight in ev["fights"]:
            for side in (fight["f1"], fight["f2"]):
                if not side.get("record"):
                    cached = stats_cache.get(side["name"], {})
                    if cached.get("rec"):
                        side["record"] = cached["rec"]
                    elif prev_records.get(side["name"]):
                        side["record"] = prev_records[side["name"]]

    # Rematch detection via UFCStats opponent history. Opponent lists hold only
    # COMPLETED bouts (the upcoming fight is excluded at fetch time), matched on
    # full name so distinct fighters sharing a surname aren't conflated. A bout
    # already concluded this card sits in both histories, so it counts as a
    # rematch only when they ALSO met before it (require 2 meetings for a
    # concluded bout, 1 for an upcoming one).
    _opp_full_cache = {}
    def _opp_fulls(name):
        if name not in _opp_full_cache:
            _opp_full_cache[name] = [_norm_full(o) for o in stats_cache.get(name, {}).get("opp", [])]
        return _opp_full_cache[name]

    for ev in new_events:
        for fight in ev["fights"]:
            if fight.get("rematch"):
                continue  # already flagged by Wikipedia
            f1n = fight["f1"]["name"]
            f2n = fight["f2"]["name"]
            need = 2 if fight.get("state") == "post" else 1
            met = max(_opp_fulls(f1n).count(_norm_full(f2n)),
                      _opp_fulls(f2n).count(_norm_full(f1n)))
            if met >= need:
                fight["rematch"] = True
                print(f"  Rematch detected: {f1n} vs {f2n}", file=sys.stderr)

    new_events = _dedupe_events(new_events)

    data = patch_js_var(data, "EVENTS", events_js(new_events))
    data = patch_js_var(
        data, "FIGHTER_STATS",
        json.dumps(stats_cache, separators=(",", ":"), ensure_ascii=False),
    )
    rankings = fetch_rankings()
    if rankings:
        data = patch_js_var(
            data, "RANKINGS",
            json.dumps(rankings, separators=(",", ":"), ensure_ascii=False),
        )
    data = patch_js_var(data, "GENERATED_AT", f'"{fmt_update(now)}"')

    if len(data) < 20000:
        print("Output suspiciously small — aborting write", file=sys.stderr)
        return data   # caller will detect no-write

    return data

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    data_path = Path("data.js")
    if not data_path.exists():
        print("No data.js", file=sys.stderr)
        sys.exit(1)

    data = data_path.read_text(encoding="utf-8")
    now  = datetime.now(timezone.utc)

    print(
        "Existing events:",
        list(zip(
            re.findall(r'date:"(\d{4}-\d{2}-\d{2})"', data)[:6],
            re.findall(r'name:"([^"]+)"', data)[:6],
        )),
        file=sys.stderr,
    )

    # Step 1: inject results for recent/live events
    updated, new_results = step_inject_results(data, now)
    if updated:
        updated = update_results_archive(updated, now)
        data_path.write_text(updated, encoding="utf-8")
        print(f"Results injected", file=sys.stderr)
        send_push_notifications(new_results)
        sys.exit(0)

    # Step 2: full rebuild — events, odds, stats, rankings
    updated = step_build_events(data, now)
    if len(updated) >= 20000:
        # A rebuild re-adds recently-finished events as "pending". Inject their
        # results in the same run so a freshly restored card (e.g. one that had
        # dropped out of the data) is scored immediately instead of waiting for a
        # second pass. Push fires here too so the scraper backs up the client-
        # side trigger when a result lands only via this path — the notif_log
        # dedup and the recency guard in send_push_notifications keep it from
        # re-announcing or spoiling already-final / aged-out fights.
        reinjected, reinjected_results = step_inject_results(updated, now)
        if reinjected:
            updated = reinjected
            print("Results injected after rebuild", file=sys.stderr)
            send_push_notifications(reinjected_results)
        updated = update_results_archive(updated, now)
        data_path.write_text(updated, encoding="utf-8")
        new_events = re.findall(r'name:"([^"]+)"', updated)
        new_fights = len(re.findall(r'"lbl":|lbl:', updated))
        print(f"Done: {len(new_events)} events", file=sys.stderr)


if __name__ == "__main__":
    main()
