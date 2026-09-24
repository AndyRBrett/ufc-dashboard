"""Non-UFC cards (PFL first) for the Fight Lab hub — SHADOW MODE.

Builds the curated feed the Pick Engine already reads (events-extra.json, format
in docs/PICK-ENGINE.md) from Wikipedia, the same free, keyless source scrape.py
uses for the UFC card, and with scrape.py's own parsers (PFL event articles use
the same {{MMAevent bout}} template).

Why shadow mode. The engine's rule is that nothing here may state a card that
isn't happening, and the development sandbox that wrote this could not reach
Wikipedia to see PFL's real page layout. So by default this writes what it
found to events-extra.candidate.json and a report to extra-state.json, and
leaves events-extra.json — the file the app reads — alone. Once a real run's
candidate has been checked against the actual card, publishing is switched on
with EXTRA_PUBLISH=1 in update.yml. Nothing about the app changes until then.

Budget, same premise as intel.py: no key, no quota, no model call, no new
dependency. A cadence gate keeps it off most 5-minute fight-night runs:
every 12h, every 4h inside a card's week. EXTRA_FORCE=1 bypasses it.

Never destructive: a failed fetch keeps the previous event, a page that parses
to fewer than MIN_BOUTS real bouts is skipped (reported, not published), and a
run that finds nothing at all writes nothing.
"""
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import scrape

ROOT = Path(__file__).resolve().parent
LIVE_JSON = ROOT / "events-extra.json"
CANDIDATE_JSON = ROOT / "events-extra.candidate.json"
STATE_JSON = ROOT / "extra-state.json"

WINDOW_PAST_DAYS = 2      # a card stays through its own fight night (UTC rollover)
WINDOW_AHEAD_DAYS = int(os.environ.get("EXTRA_WINDOW_DAYS", "60"))
MAX_EVENTS = int(os.environ.get("EXTRA_MAX_EVENTS", "4"))
MIN_BOUTS = 2             # fewer than this is a stub or a failed parse, not a card

ABOUT = ("Curated non-UFC cards for the Fight Lab hub (PFL, ONE, boxing). Built by "
         "extra.py from Wikipedia; read by lab/engine.js feedAdapter, which drops any "
         "invalid event with a reason. The UFC card never comes from here - 'ufc' is "
         "reserved for data.js. Format: docs/PICK-ENGINE.md.")

PROMOTIONS = [
    {
        "id": "pfl", "name": "PFL", "sport": "mma",
        "list_page": "List_of_Professional_Fighters_League_events",
        "year_page": "{year}_in_Professional_Fighters_League",
        # An event link or plain name that is a PFL card.
        "name_re": r"(?:PFL|Professional Fighters League)\b",
    },
]


# --------------------------------------------------------------- discovery --
def _section(wt, heading_re):
    m = re.search(r"^(=+)\s*(?:%s)[^=\n]*\1\s*$" % heading_re, wt, re.IGNORECASE | re.MULTILINE)
    if not m:
        return ""
    level = len(m.group(1))
    tail = wt[m.end():]
    end = re.search(r"^={1,%d}[^=\n].*?=+\s*$" % level, tail, re.MULTILINE)
    return tail[:end.start()] if end else tail


def discover(promo, wikitext, now):
    """Upcoming (and just-finished) events from the promotion's events list.

    Returns [{name, slug or None, date, venue, location}], soonest first, within
    [-WINDOW_PAST_DAYS, +WINDOW_AHEAD_DAYS] of now.
    """
    section = _section(wikitext, r"Scheduled|Upcoming") or wikitext
    link_re = re.compile(r"\[\[([^\]\|#]*%s[^\]\|#]*)(?:\|([^\]]+))?\]\]" % promo["name_re"], re.IGNORECASE)
    plain_re = re.compile(r"(?:^|\|)\s*(%s[^\n|]*)" % promo["name_re"], re.IGNORECASE | re.MULTILINE)
    out, seen = [], set()
    for row in re.split(r"^\s*\|-", section, flags=re.MULTILINE):
        d = scrape.parse_date_wiki(row)
        if not d:
            continue
        try:
            when = datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if when < now - timedelta(days=WINDOW_PAST_DAYS) or when > now + timedelta(days=WINDOW_AHEAD_DAYS):
            continue
        lm = link_re.search(row)
        if lm:
            slug = lm.group(1).strip().replace(" ", "_")
            name = scrape.clean_wiki(lm.group(2) or lm.group(1)).strip()
            after = lm.end()
        else:
            pm = plain_re.search(row)
            if not pm:
                continue
            slug, name, after = None, scrape.clean_wiki(pm.group(1)).strip(), pm.end()
        key = (d, name.lower())
        if not name or key in seen:
            continue
        seen.add(key)
        venue, loc = scrape._infer_venue_loc_from_row(row, after)
        out.append({"name": scrape.asc(name), "slug": slug, "date": d,
                    "venue": "" if venue == "TBD" else venue, "location": "" if loc == "TBD" else loc})
    out.sort(key=lambda e: e["date"])
    return out[:MAX_EVENTS]


# ------------------------------------------------------------------- cards --
def _real(name):
    return bool(name) and len(name) >= 2 and name.strip().upper() != "TBD"


def card_from_wikitext(wikitext):
    """Bouts from an event's wikitext, main event first, with any results."""
    fights = scrape.parse_upcoming_card(wikitext)
    results = scrape.parse_results(wikitext)
    bouts = []
    for i, f in enumerate(fights):
        a, b = f["f1"], f["f2"]
        if not (_real(a) and _real(b)) or scrape.names_match(a, b):
            continue
        winner, method, rnd = "", "", None
        for r in results:
            pair = (scrape.names_match(r["winner"], a) and scrape.names_match(r["loser"], b)) or \
                   (scrape.names_match(r["winner"], b) and scrape.names_match(r["loser"], a))
            if pair:
                winner = a if scrape.names_match(r["winner"], a) else b
                method, rnd = r["method"], r["round"]
                break
        bouts.append({"a": a, "b": b, "label": "Main Event" if not bouts else "",
                      "division": f.get("wc") or "", "title": bool(f.get("title")),
                      "odds": None, "winner": winner, "method": method, "round": rnd})
    return bouts


def section_for_event(year_wikitext, name):
    """An event without its own article is usually a section of the year page."""
    words = [w for w in re.split(r"[^A-Za-z0-9]+", name) if len(w) > 2 and w.upper() not in ("PFL",)]
    for m in re.finditer(r"^(=+)\s*([^=\n]+?)\s*\1\s*$", year_wikitext, re.MULTILINE):
        title = m.group(2)
        if words and all(re.search(r"\b%s\b" % re.escape(w), title, re.IGNORECASE) for w in words):
            return _section(year_wikitext, re.escape(title))
    return ""


# ------------------------------------------------------------------- build --
def build(fetch, now, previous=None):
    """Build the feed. `fetch(slug) -> wikitext or ""` (scrape.fetch_wikitext
    in production, a dict lookup in the tests)."""
    prev_events = {(e.get("promotion"), e.get("date"), e.get("name")): e
                   for e in (previous or {}).get("events", [])}
    events, report, promos = [], [], []
    for p in PROMOTIONS:
        promos.append({"id": p["id"], "name": p["name"], "sport": p["sport"]})
        listing = fetch(p["list_page"])
        if not listing:
            report.append({"promotion": p["id"], "problem": "events list unavailable"})
            # Keep what we had: a failed fetch is not a cancelled card.
            events.extend(e for e in (previous or {}).get("events", [])
                          if e.get("promotion") == p["id"] and _in_window(e.get("date"), now))
            continue
        years = {}
        for ev in discover(p, listing, now):
            wt = fetch(ev["slug"]) if ev["slug"] else ""
            source = "article" if wt else ""
            bouts = card_from_wikitext(wt) if wt else []
            if len(bouts) < MIN_BOUTS:
                y = ev["date"][:4]
                if y not in years:
                    years[y] = fetch(p["year_page"].format(year=y)) or ""
                sec = section_for_event(years[y], ev["name"]) if years[y] else ""
                if sec:
                    bouts, source = card_from_wikitext(sec), "year page"
            entry = {"promotion": p["id"], "name": ev["name"], "date": ev["date"],
                     "venue": ev["venue"], "location": ev["location"], "broadcast": "",
                     "bouts": bouts}
            if len(bouts) < MIN_BOUTS:
                old = prev_events.get((p["id"], ev["date"], ev["name"]))
                report.append({"promotion": p["id"], "event": ev["name"], "date": ev["date"],
                               "problem": "only %d bout(s) parsed" % len(bouts),
                               "kept_previous": bool(old)})
                if old:
                    events.append(old)
                continue
            events.append(entry)
            report.append({"promotion": p["id"], "event": ev["name"], "date": ev["date"],
                           "bouts": len(bouts), "source": source,
                           "main_event": "%s vs %s" % (bouts[0]["a"], bouts[0]["b"])})
    events.sort(key=lambda e: (e["date"], e["promotion"]))
    feed = {"about": ABOUT, "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "promotions": promos, "events": events}
    return feed, report


def _in_window(d, now):
    try:
        when = datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return False
    return when >= now - timedelta(days=WINDOW_PAST_DAYS)


# ------------------------------------------------------------------ cadence --
def should_fetch(state, previous, now):
    if os.environ.get("EXTRA_FORCE"):
        return True, "forced"
    try:
        last = datetime.strptime(state.get("last_fetch", ""), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return True, "no previous pull"
    soon = any(_in_window(e.get("date"), now) and e.get("date", "9999") <= (now + timedelta(days=7)).strftime("%Y-%m-%d")
               for e in (previous or {}).get("events", []))
    interval = timedelta(hours=4 if soon else 12)
    if now - last < interval:
        return False, "last pull %s ago (interval %s)" % (now - last, interval)
    return True, "due"


def _read(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def main():
    now = datetime.now(timezone.utc)
    publish = os.environ.get("EXTRA_PUBLISH") == "1"
    state = _read(STATE_JSON)
    previous = _read(LIVE_JSON if publish else CANDIDATE_JSON)
    go, why = should_fetch(state, previous, now)
    if not go:
        print("extra: skipped (%s)" % why)
        return 0
    feed, report = build(scrape.fetch_wikitext, now, previous)
    for r in report:
        if r.get("problem"):
            print("::warning::extra: %s" % json.dumps(r))
    STATE_JSON.write_text(json.dumps({"last_fetch": feed["generated_at"], "publish": publish,
                                      "events": len(feed["events"]), "report": report},
                                     indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    if not feed["events"] and not previous.get("events"):
        print("extra: nothing found; nothing written")
        return 0
    out = LIVE_JSON if publish else CANDIDATE_JSON
    body = json.dumps(feed, indent=1, ensure_ascii=False) + "\n"
    old = out.read_text(encoding="utf-8") if out.exists() else ""
    # generated_at alone changing is not worth a commit.
    strip = lambda s: re.sub(r'"generated_at": "[^"]*"', "", s)
    if strip(old) != strip(body):
        out.write_text(body, encoding="utf-8")
    print("extra: %d event(s) -> %s%s" % (len(feed["events"]), out.name, "" if publish else " (shadow)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
