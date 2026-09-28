"""Non-UFC cards (PFL, RIZIN, DWCS) for the sport switcher and Fight Lab hub.

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
PFL was checked and published 2026-09-24. Since then the switch is also per
promotion (`publish` in PROMOTIONS): the candidate file always carries every
promotion, the live file only the published ones.

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

# `publish` is per promotion. EXTRA_PUBLISH=1 switches the live file on at
# all; within it, only promotions marked publish=True reach events-extra.json.
# The rest stay in shadow: every run writes the FULL feed to
# events-extra.candidate.json, so a new promotion's first real cards can be
# checked against the actual card before its flag is flipped. Adding a
# promotion never publishes it by itself.
#
# `list_page` may carry {year}: the page is then read for this year and, when
# the window reaches into it, next year (a December run needs January's cards).
# `list_section` names the events table's heading when the page carries more
# than the table (RIZIN's year page is the list AND every card's section).
PROMOTIONS = [
    {
        "id": "pfl", "name": "PFL", "sport": "mma", "publish": True,
        "list_page": "List_of_Professional_Fighters_League_events",
        "year_page": "{year}_in_Professional_Fighters_League",
        # An event link or plain name that is a PFL card.
        "name_re": r"(?:PFL|Professional Fighters League)\b",
    },
    {
        # One page per year: an events table under "List of events" whose rows
        # link to in-page anchors ([[#Rizin 55|Rizin 55]]), then one section
        # per card with the usual {{MMAevent bout}} templates. Checked against
        # the real 2026 page on 2026-09-28: Landmark 16's parsed card had 8 of
        # its 13 bouts independently confirmed and none contradicted (one bout
        # the page hadn't added yet was missing, which is a gap, not a lie).
        "id": "rizin", "name": "RIZIN", "sport": "mma", "publish": True,
        "list_page": "{year}_in_Rizin_Fighting_Federation",
        "list_section": r"List of events",
        "year_page": "{year}_in_Rizin_Fighting_Federation",
        "name_re": r"(?:Super\s+)?Rizin\b",
    },
    {
        # Dana White's Contender Series: no article per card. The main article
        # lists seasons (start and end dates, linked season page); a season
        # page has one "== Week 8 – September 29 ==" section per Tuesday, each
        # with an infobox (name, date, venue) and {{MMAevent bout}} templates.
        # Checked against the real season 10 page on 2026-09-28; its week 8
        # card matched UFC.com's and Sherdog's bout for bout (5 of 5).
        "id": "dwcs", "name": "DWCS", "sport": "mma", "publish": True,
        "list_page": "Dana_White's_Contender_Series",
        "seasons": True,
    },
]


# --------------------------------------------------------------- discovery --
def _sections(wt, heading_re):
    """Every section under a heading matching heading_re (a list page read for
    two years is two pages, each with its own events table)."""
    out = []
    for m in re.finditer(r"^(=+)\s*(?:%s)[^=\n]*\1\s*$" % heading_re, wt, re.IGNORECASE | re.MULTILINE):
        level = len(m.group(1))
        tail = wt[m.end():]
        end = re.search(r"^={1,%d}[^=\n].*?=+\s*$" % level, tail, re.MULTILINE)
        out.append(tail[:end.start()] if end else tail)
    return out


def _section(wt, heading_re):
    found = _sections(wt, heading_re)
    return found[0] if found else ""


def discover(promo, wikitext, now):
    """Upcoming (and just-finished) events from the promotion's events list.

    Returns [{name, slug or None, date, venue, location}], soonest first, within
    [-WINDOW_PAST_DAYS, +WINDOW_AHEAD_DAYS] of now.
    """
    # Upcoming AND past rows: a card that just finished has usually already
    # moved to the Past table, and it must stay (and pick up its results) for
    # WINDOW_PAST_DAYS. The date window below decides what's kept; duplicates
    # across tables collapse on (date, name).
    if promo.get("list_section"):
        # A page that is more than its events table: never read dates out of
        # the rest of it (an infobox date plus any "Rizin" mention is a row).
        parts = _sections(wikitext, promo["list_section"])
    else:
        parts = [_section(wikitext, r"Scheduled|Upcoming"), _section(wikitext, r"Past|Previous|Completed")]
    section = "\n|-\n".join(p for p in parts if p) or ("" if promo.get("list_section") else wikitext)
    link_re = re.compile(r"\[\[([^\]\|#]*%s[^\]\|#]*)(?:\|([^\]]+))?\]\]" % promo["name_re"], re.IGNORECASE)
    plain_re = re.compile(r"(?:^|\|)\s*(%s[^\n|]*)" % promo["name_re"], re.IGNORECASE | re.MULTILINE)
    out, seen = [], set()
    for row in re.split(r"^\s*\|-", section, flags=re.MULTILINE):
        # A link to an anchor on the same page ([[#Rizin 55|Rizin 55]]) is not
        # an article: keep its text, so the card is found by its section.
        row = re.sub(r"\[\[#[^\]\|]*\|([^\]]+)\]\]", r"\1", row)
        row = re.sub(r"\[\[#([^\]\|]+)\]\]", r"\1", row)
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


# ------------------------------------------------------------ season shows --
_SEASON_LINK_RE = re.compile(r"\[\[([^\]\|#]*\bseason\b[^\]\|#]*)(?:\|[^\]]*)?\]\]", re.IGNORECASE)
_WEEK_RE = re.compile(r"^==\s*(Week\s+(\d+)\b[^=\n]*?)\s*==\s*$", re.IGNORECASE | re.MULTILINE)
_H2_RE = re.compile(r"^==[^=\n].*?==\s*$", re.MULTILINE)


def _field(section, name):
    m = re.search(r"^\|\s*%s\s*=(.*)$" % name, section, re.IGNORECASE | re.MULTILINE)
    return scrape.clean_wiki(m.group(1)).strip() if m else ""


def current_seasons(listing, now):
    """Season pages whose run overlaps the window, from the "List of seasons"
    table: [{slug, start, end}]. A row carries its season link, then its
    start date, then its end date (an end not known yet reads as open)."""
    out = []
    table = _section(listing, r"List of seasons") or listing
    for row in re.split(r"^\s*\|-", table, flags=re.MULTILINE):
        lm = _SEASON_LINK_RE.search(row)
        if not lm:
            continue
        dates = re.findall(r"\{\{dts\|[^}]*\}\}", row)
        start = scrape.parse_date_wiki(dates[0]) if dates else None
        end = scrape.parse_date_wiki(dates[1]) if len(dates) > 1 else None
        if not start:
            continue
        try:
            s_ = datetime.strptime(start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            e_ = datetime.strptime(end, "%Y-%m-%d").replace(tzinfo=timezone.utc) if end else s_ + timedelta(days=120)
        except ValueError:
            continue
        if s_ > now + timedelta(days=WINDOW_AHEAD_DAYS) or e_ < now - timedelta(days=WINDOW_PAST_DAYS):
            continue
        out.append({"slug": lm.group(1).strip().replace(" ", "_"), "start": start, "end": end})
    return out


def season_weeks(season_wikitext, start, now):
    """One card per "Week N" section of a season page, within the window:
    [{name, slug: None, date, venue, location, wt}], soonest first.

    The date is the section's own infobox |date=, never the first date found
    anywhere in it (a reference's publish date comes later in the same text).
    Failing that, the heading's "September 29" plus the season's year."""
    out = []
    heads = list(_WEEK_RE.finditer(season_wikitext))
    for m in heads:
        tail = season_wikitext[m.end():]
        nxt = _H2_RE.search(tail)
        sec = tail[:nxt.start()] if nxt else tail
        d = scrape.parse_date_wiki(_field(sec, "date"))
        if not d:
            hm = re.search(r"([A-Za-z]+)\s+(\d{1,2})\s*$", m.group(1))
            mo = scrape.MONTH_MAP.get(hm.group(1).lower(), 0) if hm else 0
            if mo:
                y = int(start[:4]) + (1 if mo < int(start[5:7]) else 0)
                d = "%04d-%02d-%02d" % (y, mo, int(hm.group(2)))
        if not d:
            continue
        when = datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        if when < now - timedelta(days=WINDOW_PAST_DAYS) or when > now + timedelta(days=WINDOW_AHEAD_DAYS):
            continue
        name = _field(sec, "name") or "Dana White's Contender Series, %s" % scrape.clean_wiki(re.split(r"\s*[–—-]\s*", m.group(1))[0]).strip()
        out.append({"name": scrape.asc(name), "slug": None, "date": d,
                    "venue": _field(sec, "venue"), "location": _field(sec, "city"), "wt": sec})
    out.sort(key=lambda e: e["date"])
    return out[:MAX_EVENTS]


# ------------------------------------------------------------------- cards --
def _real(name):
    return bool(name) and len(name) >= 2 and name.strip().upper() not in ("TBD", "TBA")


# scrape.parse_upcoming_card marks a title fight by a champion's "(c)". An
# inaugural or vacant title has no champion yet (PFL Chicago's women's
# flyweight belt, 2026-10-16, is exactly that), so also read the bout's own
# text for a championship; "eliminator" / "#1 contender" bouts aren't titles.
_TITLE_RE = re.compile(r"\bchampionship\b|\btitle\s+(?:bout|fight)\b|\bfor the [^|\n}]*\btitle\b", re.I)
_NOT_TITLE_RE = re.compile(r"\beliminator\b|\bcontender\b", re.I)


def _title_pairs(wikitext):
    pairs = []
    for block in re.finditer(r"\{\{MMAevent bout\s*\n(.*?)\}\}", wikitext, re.DOTALL | re.IGNORECASE):
        text = block.group(1)
        if _TITLE_RE.search(text) and not _NOT_TITLE_RE.search(text):
            pairs.append(scrape.clean_wiki(text))
    return pairs


# Wikipedia's own typos, so the card doesn't repeat them.
_DIVISION_FIX = {"welteweight": "Welterweight", "welterwieght": "Welterweight", "lightwieght": "Lightweight"}


def card_from_wikitext(wikitext):
    """Bouts from an event's wikitext, main event first, with any results."""
    fights = scrape.parse_upcoming_card(wikitext)
    results = scrape.parse_results(wikitext)
    titled = _title_pairs(wikitext)
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
        div = f.get("wc") or ""
        div = _DIVISION_FIX.get(div.strip().lower(), div)
        title = bool(f.get("title")) or any(a in t and b in t for t in titled)
        bouts.append({"a": a, "b": b, "label": "Main Event" if not bouts else "",
                      "division": div, "title": title,
                      "odds": None, "winner": winner, "method": method, "round": rnd})
    return bouts


def _name_tokens(s):
    toks = re.findall(r"[A-Za-z0-9]+", s)
    words = {t.lower() for t in toks if len(t) > 2 and not t.isdigit() and t.upper() != "PFL"}
    nums = {t.lstrip("0") or "0" for t in toks if t.isdigit()}
    return words, nums


def section_for_event(year_wikitext, name):
    """An event without its own article is usually a section of the year page.

    Numbers are identity, not noise: "World Tournament 1" and "World
    Tournament 5" differ ONLY by their number, so a heading must carry exactly
    the event's numbers (and every one of its words). "PFL 1" has no words at
    all and still matches on its number.
    """
    words, nums = _name_tokens(name)
    if not words and not nums:
        return ""
    best = None
    for m in re.finditer(r"^(=+)\s*([^=\n]+?)\s*\1\s*$", year_wikitext, re.MULTILINE):
        title = m.group(2)
        tw, tn = _name_tokens(title)
        # Same numbers, and one name's words contain the other's ("PFL Chicago"
        # vs "PFL Chicago: Carmouche vs. Bishop"). The closest wins, so bare
        # "PFL 1" picks the "PFL 1" heading over "PFL World Tournament 1".
        if tn != nums or not (words <= tw or tw <= words) or not (tw or tn):
            continue
        score = len(words ^ tw)
        if best is None or score < best[0]:
            best = (score, m)
    if not best:
        return ""
    # Slice from THIS heading's position, never re-search by title: a prefix
    # search for "PFL 1" would land on "PFL 10".
    m = best[1]
    level = len(m.group(1))
    tail = year_wikitext[m.end():]
    end = re.search(r"^={1,%d}[^=\n].*?=+\s*$" % level, tail, re.MULTILINE)
    return tail[:end.start()] if end else tail


# How far the year page's date may sit from the events list's for the same card.
# The two pages are edited separately and drift (PFL Chicago: Oct 16 on one,
# Oct 17 on the other); a same-named card a year away never comes close.
LINK_DATE_SLACK_DAYS = 3


def link_from_year_page(year_wikitext, name, date):
    """The article for an event the events list names without linking.

    The list page often carries a new card as plain text ("PFL MENA 11") while
    the year page's own events table links it ("[[PFL MENA 11|PFL MENA 11: Last
    Man Standing]]", "[[PFL Africa 3 (2026)|PFL Africa 3: Morocco]]"). A row
    matches on the same rules as section_for_event (exactly the event's numbers,
    one name's words inside the other's), judged on the link's display text,
    since the target can carry a disambiguating year, AND on a date within
    LINK_DATE_SLACK_DAYS: "PFL Africa 3" was also a 2025 card.
    """
    words, nums = _name_tokens(name)
    if not (words or nums):
        return None
    try:
        want = datetime.strptime(date, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None
    best = None
    for row in re.split(r"^\s*\|-", year_wikitext, flags=re.MULTILINE):
        d = scrape.parse_date_wiki(row)
        if not d:
            continue
        try:
            gap = abs((datetime.strptime(d, "%Y-%m-%d") - want).days)
        except ValueError:
            continue
        if gap > LINK_DATE_SLACK_DAYS:
            continue
        for lm in re.finditer(r"\[\[([^\]\|#]+)(?:\|([^\]]+))?\]\]", row):
            tw, tn = _name_tokens(scrape.clean_wiki(lm.group(2) or lm.group(1)))
            if tn != nums or not (words <= tw or tw <= words) or not (tw or tn):
                continue
            score = (gap, len(words ^ tw))
            if best is None or score < best[0]:
                best = (score, lm.group(1).strip().replace(" ", "_"))
    return best[1] if best else None


# ------------------------------------------------------------------- build --
def build(fetch, now, previous=None):
    """Build the feed. `fetch(slug) -> wikitext or ""` (scrape.fetch_wikitext
    in production, a dict lookup in the tests)."""
    prev_events = {(e.get("promotion"), e.get("date"), e.get("name")): e
                   for e in (previous or {}).get("events", [])}
    # One fetch per page per run: RIZIN's list page IS its year page.
    pages = {}
    def get(slug):
        if slug not in pages:
            pages[slug] = fetch(slug) or ""
        return pages[slug]
    events, report, promos = [], [], []
    for p in PROMOTIONS:
        promos.append({"id": p["id"], "name": p["name"], "sport": p["sport"]})
        if p.get("seasons"):
            listing = get(p["list_page"])
        elif "{year}" in p["list_page"]:
            yrs = sorted({now.year, (now + timedelta(days=WINDOW_AHEAD_DAYS)).year})
            listing = "\n".join(get(p["list_page"].format(year=y)) for y in yrs).strip()
        else:
            listing = get(p["list_page"])
        if not listing:
            report.append({"promotion": p["id"], "problem": "events list unavailable"})
            # Keep what we had: a failed fetch is not a cancelled card.
            events.extend(e for e in (previous or {}).get("events", [])
                          if e.get("promotion") == p["id"] and _in_window(e.get("date"), now))
            continue
        years = {}
        def year_page(d):
            y = d[:4]
            if y not in years:
                years[y] = get(p["year_page"].format(year=y))
            return years[y]
        if p.get("seasons"):
            found, missing = [], []
            for season in current_seasons(listing, now):
                swt = get(season["slug"])
                if swt:
                    found.extend(season_weeks(swt, season["start"], now))
                else:
                    missing.append(season["slug"])
            if missing:
                report.append({"promotion": p["id"], "problem": "season page unavailable: %s" % ", ".join(missing)})
                # Keep what we had: a failed fetch is not a cancelled card.
                have = {(e["date"], e["name"]) for e in found}
                found.extend(dict(e, wt=None) for e in (previous or {}).get("events", [])
                             if e.get("promotion") == p["id"] and _in_window(e.get("date"), now)
                             and (e.get("date"), e.get("name")) not in have)
            listed = sorted(found, key=lambda e: e["date"])
        else:
            listed = discover(p, listing, now)
        for ev in listed:
            if "wt" in ev:
                # A season show's card came with its own section, or (wt=None)
                # is a previous card kept through a failed fetch.
                if ev["wt"] is None:
                    events.append({k: v for k, v in ev.items() if k != "wt"})
                    continue
                bouts = card_from_wikitext(ev["wt"])
                source = "season page"
                entry = {"promotion": p["id"], "name": ev["name"], "date": ev["date"],
                         "venue": ev["venue"], "location": ev["location"], "broadcast": "",
                         "bouts": bouts}
                _publishable(p, ev, bouts, entry, source, prev_events, events, report)
                continue
            slug = ev["slug"]
            if not slug:
                # Listed as plain text: the year page's events table may link it.
                slug = link_from_year_page(year_page(ev["date"]), ev["name"], ev["date"])
            wt = get(slug) if slug else ""
            source = "article" if wt else ""
            bouts = card_from_wikitext(wt) if wt else []
            if len(bouts) < MIN_BOUTS:
                yp = year_page(ev["date"])
                sec = section_for_event(yp, ev["name"]) if yp else ""
                if sec:
                    bouts, source = card_from_wikitext(sec), "year page"
            entry = {"promotion": p["id"], "name": ev["name"], "date": ev["date"],
                     "venue": ev["venue"], "location": ev["location"], "broadcast": "",
                     "bouts": bouts}
            _publishable(p, ev, bouts, entry, source, prev_events, events, report)
    events.sort(key=lambda e: (e["date"], e["promotion"]))
    feed = {"about": ABOUT, "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "promotions": promos, "events": events}
    return feed, report


def _publishable(p, ev, bouts, entry, source, prev_events, events, report):
    """Add the card, or, if it parsed to a stub, the previous version of it."""
    if len(bouts) < MIN_BOUTS:
        old = prev_events.get((p["id"], ev["date"], ev["name"]))
        report.append({"promotion": p["id"], "event": ev["name"], "date": ev["date"],
                       "problem": "only %d bout(s) parsed" % len(bouts),
                       "kept_previous": bool(old)})
        if old:
            events.append(old)
        return False
    events.append(entry)
    report.append({"promotion": p["id"], "event": ev["name"], "date": ev["date"],
                   "bouts": len(bouts), "source": source,
                   "main_event": "%s vs %s" % (bouts[0]["a"], bouts[0]["b"])})
    return True


def _in_window(d, now):
    try:
        when = datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return False
    return when >= now - timedelta(days=WINDOW_PAST_DAYS)


# ------------------------------------------------------------------ cadence --
def should_fetch(state, previous, now, publish=False):
    if os.environ.get("EXTRA_FORCE"):
        return True, "forced"
    # Switching shadow <-> publish reads a different previous file; the
    # shadow run's timestamp must not delay filling the live one.
    if "publish" in state and bool(state.get("publish")) != bool(publish):
        return True, "publish mode changed"
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


def main(now=None):
    # `now` is injectable so tests can pin the clock: their fixture cards have
    # real dates, and on the wall clock they age out of the window and fail
    # update.yml's pytest guard, which runs before the scrape and would stop
    # every data update, live results included.
    now = now or datetime.now(timezone.utc)
    publish = os.environ.get("EXTRA_PUBLISH") == "1"
    state = _read(STATE_JSON)
    live_ids = published_ids() if publish else set()
    # What we had, per promotion, from the file each one is written to: a
    # published promotion's cards from the live file, a shadowed one's from the
    # candidate. That is what a failed fetch falls back to.
    live_prev, cand_prev = _read(LIVE_JSON), _read(CANDIDATE_JSON)
    previous = {"events": [e for e in live_prev.get("events", []) if e.get("promotion") in live_ids] +
                          [e for e in cand_prev.get("events", []) if e.get("promotion") not in live_ids]}
    go, why = should_fetch(state, previous, now, publish)
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
    # The candidate always gets everything, so a shadowed promotion can be
    # checked; the live file only ever gets promotions marked publish=True.
    _write(CANDIDATE_JSON, feed)
    print("extra: %d event(s) -> %s (shadow: all promotions)" % (len(feed["events"]), CANDIDATE_JSON.name))
    if publish:
        live = only(feed, live_ids)
        if live["events"] or live_prev.get("events"):
            _write(LIVE_JSON, live)
        print("extra: %d event(s) -> %s (%s)" % (len(live["events"]), LIVE_JSON.name,
                                                 ", ".join(sorted(live_ids)) or "none published"))
    return 0


def published_ids():
    return {p["id"] for p in PROMOTIONS if p.get("publish")}


def only(feed, ids):
    """The feed cut down to the given promotions: their cards AND their entries
    in `promotions`, so the switcher never offers a sport with nothing behind it."""
    return dict(feed, promotions=[p for p in feed["promotions"] if p["id"] in ids],
                events=[e for e in feed["events"] if e["promotion"] in ids])


def _write(path, feed):
    body = json.dumps(feed, indent=1, ensure_ascii=False) + "\n"
    old = path.read_text(encoding="utf-8") if path.exists() else ""
    # generated_at alone changing is not worth a commit.
    strip = lambda s: re.sub(r'"generated_at": "[^"]*"', "", s)
    if strip(old) != strip(body):
        path.write_text(body, encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
