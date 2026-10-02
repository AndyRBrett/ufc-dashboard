#!/usr/bin/env python3
"""
Official card times, read from each card's UFC.com event page: SHADOW MODE.

Every wrong clock this app has shipped came from the same place. scrape.py does
not read a card's start time anywhere; it guesses one from a table (a numbered
event is 21:00 ET, a Fight Night 20:00, Abu Dhabi 14:00 ...), takes ESPN's
event `date` for international cards (which means the main card on some events
and the first prelim on others), and patches each miss with a hand-written
_TIME_OVERRIDES entry. UFC 332 went to CBS at 20:00 ET, the table said 21:00,
and every segment would have stayed pickable for an hour of its own fights.

UFC.com publishes the real thing: each segment (Early Prelims / Prelims / Main
Card) with an absolute start timestamp, and the bouts listed under each one.
That is both clocks the app locks on AND the bout-to-segment split that
scrape.py also infers from bout order (_MAIN_CARD_SIZE, _PRELIM_CARD_SIZE).

This file only READS it. It writes official-times.json, and health.py compares
that with data.js and files any disagreement as a WARN on the data-health issue
("time-mismatch", "segment-mismatch", "time-unconfirmed"). Nothing here changes
what the app shows. Once real cards have shown the reading is right, scrape.py
can take its times from it and the guess tables retire; until then a parser
written without sight of the live page can only ever cause a warning.

Same rules as intel.py: free (no key, no quota), cadence-gated, never fatal,
and a failed fetch keeps the last good reading instead of erasing it.

Run: python official_times.py                 (respects the cadence gate)
     OFFICIAL_TIMES_FORCE=1 python official_times.py
"""

import html as _html
import json
import os
import re
import sys
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

import health

ROOT = Path(__file__).resolve().parent
DATA_JS = ROOT / "data.js"
OUT_JSON = ROOT / "official-times.json"

BASE = "https://www.ufc.com"
EVENTS_LIST = BASE + "/events"
ET = ZoneInfo("America/New_York")

# Cards further out than this rarely have a final schedule, and reading them
# only churns the file.
WINDOW_DAYS = int(os.environ.get("OFFICIAL_TIMES_WINDOW_DAYS", "21"))
# How often each card is re-read. Tight near the card, because a late network
# move (CBS taking a main card) lands in fight week.
INTERVAL_H = ((2, 1), (7, 3), (WINDOW_DAYS, 12))   # (within days, every hours)
HTTP_TIMEOUT = 20
UA = {
    "User-Agent": (
        "UFC-Dashboard/1.0 "
        "(https://github.com/AndyRBrett/ufc-dashboard; andyrbrett@gmail.com)"
    ),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}

SEGMENTS = ("early", "prelim", "main")

# Section anchors on the event page, in the order they are tried. The ids are
# the page's in-page nav targets; the class names are the fallback if the ids
# move. Early is listed before prelim because "fight-card-prelims" is a prefix
# of "fight-card-prelims-early".
_SECTION_RES = (
    ("early",  re.compile(r'id="early-prelims"|class="[^"]*\bfight-card-prelims-early\b')),
    ("prelim", re.compile(r'id="prelims-card"|class="[^"]*\bfight-card-prelims\b(?!-)')),
    ("main",   re.compile(r'id="main-card"|class="[^"]*\bmain-card\b(?!-)')),
)
# Text fallback, for a page whose markup lost both: a heading followed by the
# first timestamp after it.
_HEADING_RES = (
    ("early",  re.compile(r">\s*Early Prelims\s*<", re.I)),
    ("prelim", re.compile(r">\s*Prelims\s*<", re.I)),
    ("main",   re.compile(r">\s*Main Card\s*<", re.I)),
)
_TS_RE = re.compile(r'data-timestamp="(\d{9,11})"')
_CORNER_RE = re.compile(
    r'class="[^"]*\bc-listing-fight__corner-name\b[^"]*"[^>]*>(.*?)</div>', re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_HREF_RE = re.compile(r'href="(/event/[a-z0-9-]+)"')

_MONTHS = ("january", "february", "march", "april", "may", "june", "july",
           "august", "september", "october", "november", "december")


def fold(s):
    """Lowercase, accents stripped, punctuation to spaces, whitespace collapsed."""
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s.replace("'", "").replace("’", ""))
    return " ".join(s.split())


def _text(fragment):
    return " ".join(_html.unescape(_TAG_RE.sub(" ", fragment)).split())


def _et(ts):
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).astimezone(ET)


# ---------------------------------------------------------------------------
# Parsing (pure)
# ---------------------------------------------------------------------------

def _sections(page):
    """[(segment, start, end)] spans of the page, in page order."""
    marks = []
    for seg, rx in _SECTION_RES:
        m = rx.search(page)
        if m:
            marks.append((m.start(), seg))
    if not marks:
        for seg, rx in _HEADING_RES:
            m = rx.search(page)
            if m:
                marks.append((m.start(), seg))
    marks.sort()
    out = []
    for i, (pos, seg) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(page)
        if seg not in (s for s, _, _ in out):
            out.append((seg, pos, end))
    return out


def parse_event_page(page):
    """Segment start times (ET) and bouts from a UFC.com event page.

    Returns {"segments": {seg: {"et": "HH:MM", "date": "YYYY-MM-DD",
    "utc": iso}}, "bouts": {seg: [[a, b], ...]}}. A segment with no timestamp
    is left out rather than guessed.
    """
    segments, bouts = {}, {}
    for seg, start, end in _sections(page):
        body = page[start:end]
        ts = _TS_RE.search(body)
        if ts:
            et = _et(ts.group(1))
            segments[seg] = {
                "et": et.strftime("%H:%M"),
                "date": et.strftime("%Y-%m-%d"),
                "utc": et.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
        names = [n for n in (_text(m.group(1)) for m in _CORNER_RE.finditer(body)) if n]
        pairs = [[names[i], names[i + 1]] for i in range(0, len(names) - 1, 2)]
        if pairs:
            bouts[seg] = pairs
    return {"segments": segments, "bouts": bouts}


def headliners(ev_name):
    """Folded surnames of the two headliners in 'UFC 332: Silva vs. Wang'."""
    tail = ev_name.split(":", 1)[-1]
    m = re.search(r"(.+?)\s+vs\.?\s+(.+)", tail, re.I)
    if not m:
        return ()
    out = []
    for side in m.groups():
        toks = fold(re.sub(r"\b(jr|sr|ii|iii)\b\.?", "", side, flags=re.I)).split()
        if toks:
            out.append(toks[-1])
    return tuple(out)


def page_is_card(page, parsed, ev):
    """Whether *page* is really this card: its headliners are named on it and
    its main card falls within a day of the card's date (ET)."""
    folded = fold(_text(page))
    names = headliners(ev["name"])
    if not names or not all(n in folded for n in names):
        return False
    main = parsed["segments"].get("main")
    if not main:
        return False
    try:
        got = datetime.strptime(main["date"], "%Y-%m-%d").date()
        want = datetime.strptime(ev["date"], "%Y-%m-%d").date()
    except ValueError:
        return False
    return abs((got - want).days) <= 1


def candidate_paths(ev):
    """UFC.com paths worth trying for a card, most likely first."""
    out = []
    m = re.match(r"UFC\s+(\d+)\b", ev["name"])
    if m:
        out.append("/event/ufc-%s" % m.group(1))
    try:
        d = datetime.strptime(ev["date"], "%Y-%m-%d")
        out.append("/event/ufc-fight-night-%s-%d-%d"
                   % (_MONTHS[d.month - 1], d.day, d.year))
    except ValueError:
        pass
    return out


def listing_paths(listing_html, ev):
    """Event links on the /events listing that could be this card: a sponsored
    numbered slug ("/event/cryptocom-ufc-331"), or one carrying its date."""
    links = list(dict.fromkeys(_HREF_RE.findall(listing_html or "")))
    out = []
    m = re.match(r"UFC\s+(\d+)\b", ev["name"])
    if m:
        rx = re.compile(r"(?:^|-)ufc-%s(?:$|-)" % m.group(1))
        out += [p for p in links if rx.search(p.rsplit("/", 1)[-1])]
    try:
        d = datetime.strptime(ev["date"], "%Y-%m-%d")
        tail = "%s-%d-%d" % (_MONTHS[d.month - 1], d.day, d.year)
        out += [p for p in links if p.endswith(tail)]
    except ValueError:
        pass
    return list(dict.fromkeys(out))


# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

def _get(url):
    """(status, text). Status 0 on a transport error; never raises."""
    try:
        r = requests.get(url, headers=UA, timeout=HTTP_TIMEOUT)
        return r.status_code, (r.text if r.status_code == 200 else "")
    except Exception as e:  # noqa: BLE001 — a dead source is reported, not fatal
        print("official_times: %s: %s" % (url, e), file=sys.stderr)
        return 0, ""


def read_card(ev, get=_get, listing=None):
    """Find and parse *ev*'s UFC.com page. Returns (reading, listing_html).

    reading is {"url", "status", "segments", "bouts"} on success, or
    {"status", "error", "tried"} when no page matched.
    """
    tried, last_status = [], None
    paths = candidate_paths(ev)
    for attempt in (0, 1):
        for path in paths:
            if path in tried:
                continue
            tried.append(path)
            status, page = get(BASE + path)
            last_status = status
            if status != 200:
                continue
            parsed = parse_event_page(page)
            if page_is_card(page, parsed, ev):
                return {"url": BASE + path, "status": 200, **parsed}, listing
        if attempt == 0:
            if listing is None:
                status, listing = get(EVENTS_LIST)
                if status != 200:
                    listing = ""
            paths = listing_paths(listing, ev)
    return {"status": last_status, "tried": tried,
            "error": "no UFC.com page matched this card"}, listing


# ---------------------------------------------------------------------------
# Cadence and the state file
# ---------------------------------------------------------------------------

def card_key(ev):
    return "%s|%s" % (ev["name"], ev["date"])


def days_out(ev, now):
    try:
        return (datetime.strptime(ev["date"], "%Y-%m-%d").date() - now.date()).days
    except ValueError:
        return None


def due(ev, prev, now, force=False):
    """Whether *ev* should be read this run."""
    d = days_out(ev, now)
    if d is None or d < -1 or d > WINDOW_DAYS:
        return False
    if force or not prev:
        return True
    try:
        last = datetime.fromisoformat(prev["checked_at"].replace("Z", "+00:00"))
    except (KeyError, ValueError, AttributeError):
        return True
    hours = next(h for within, h in INTERVAL_H if d <= within)
    return now - last >= timedelta(hours=hours)


def update(events, state, now, get=_get, force=False):
    """New state dict. A failed read keeps the last good segments and records
    the failure beside them; a card that left the window is dropped."""
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    prev_cards = (state or {}).get("cards", {})
    cards, listing, read = {}, None, 0
    for ev in events:
        key = card_key(ev)
        prev = prev_cards.get(key)
        d = days_out(ev, now)
        if d is None or d < -1 or d > WINDOW_DAYS:
            continue
        if not due(ev, prev, now, force):
            cards[key] = prev
            continue
        reading, listing = read_card(ev, get=get, listing=listing)
        read += 1
        entry = {"name": ev["name"], "date": ev["date"], "checked_at": stamp}
        if reading.get("segments"):
            entry.update(reading, confirmed_at=stamp)
        else:
            if prev and prev.get("segments"):
                keep = {k: prev[k] for k in ("url", "segments", "bouts", "confirmed_at")
                        if k in prev}
                entry.update(keep)
            entry.update(status=reading.get("status"), error=reading.get("error"),
                         tried=reading.get("tried", []))
        cards[key] = entry
    changed = read > 0 or set(cards) != set(prev_cards)
    return {"generated_at": stamp if changed else (state or {}).get("generated_at", stamp),
            "source": BASE, "cards": cards}, changed, read


def main(now=None):
    if not DATA_JS.exists():
        print("official_times: no data.js — nothing to check")
        return 0
    events = health.parse_data(DATA_JS.read_text(encoding="utf-8"))
    if not events:
        print("official_times: EVENTS did not parse — leaving the file as it is")
        return 0
    state = {}
    if OUT_JSON.exists():
        try:
            state = json.loads(OUT_JSON.read_text(encoding="utf-8"))
        except ValueError:
            state = {}
    now = now or datetime.now(timezone.utc)
    new, changed, read = update(events, state, now,
                                force=bool(os.environ.get("OFFICIAL_TIMES_FORCE")))
    if changed:
        OUT_JSON.write_text(json.dumps(new, indent=1, ensure_ascii=False) + "\n",
                            encoding="utf-8")
    for key, c in new["cards"].items():
        if c.get("error") and c.get("checked_at") == new["generated_at"]:
            print("::warning::official_times: %s — %s (HTTP %s)"
                  % (key, c["error"], c.get("status")))
        elif c.get("checked_at") == new["generated_at"]:
            segs = ", ".join("%s %s" % (s, c["segments"][s]["et"])
                             for s in SEGMENTS if s in c.get("segments", {}))
            print("official_times: %s — %s ET (%s)" % (key, segs, c.get("url")))
    print("official_times: read %d card(s), %d tracked" % (read, len(new["cards"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
