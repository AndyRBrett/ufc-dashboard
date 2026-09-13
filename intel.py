#!/usr/bin/env python3
"""
Fight Week Intel curator — builds intel.json, the "Fight Week Intel" section the
app renders under each upcoming card.

The point of this file is that it costs nothing to run. Everything here is a
free, unauthenticated, unmetered public RSS/Atom feed, parsed with the standard
library, matched against fighters already in data.js by string comparison. There
is no LLM call, no Odds-API-style quota, and no database: the output is a static
JSON file committed next to data.js and served by GitHub Pages like every other
artifact in this repo.

That last part is the deliberate choice. A Supabase table would have been the
obvious home, but every page load would then cost a DB read forever, for content
that changes twice a week and is identical for every user. A committed JSON file
is free to serve, free to cache, survives Supabase being down, and is reviewable
in a diff.

We link OUT. `blurb` is capped at BLURB_MAX characters of the feed's own summary
so the section is a pointer to the publisher, never a rehost of their article.

Run: python intel.py            (respects the cadence gate)
     INTEL_FORCE=1 python intel.py   (ignore the gate)
"""

import hashlib
import html as _html
import json
import os
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
DATA_JS = ROOT / "data.js"
OUT_JSON = ROOT / "intel.json"
STATE_JSON = ROOT / "intel-state.json"

# Only curate cards this close. Nothing useful is published about a card three
# weeks out, and a wider window just churns the commit every run.
WINDOW_DAYS = int(os.environ.get("INTEL_WINDOW_DAYS", "10"))
# How long a card stays eligible AFTER its date. Not cosmetic padding: `today` is
# UTC, and a US prime-time card runs past UTC midnight — a Saturday 21:00 ET main
# card starts at 01:00 UTC Sunday, by which point a `days_out >= 0` bound has
# already dropped the event. That deleted the section an hour before the main
# card, every Saturday and Sunday. 2 days matches the window render() in
# index.html already uses to keep an event visible; the two must agree, or the
# card is on screen with its intel missing.
WINDOW_PAST_DAYS = int(os.environ.get("INTEL_WINDOW_PAST_DAYS", "2"))
# Items older than this are stale for fight week regardless of what matched.
MAX_ITEM_AGE_DAYS = int(os.environ.get("INTEL_MAX_ITEM_AGE_DAYS", "14"))
MAX_ITEMS_PER_EVENT = int(os.environ.get("INTEL_MAX_ITEMS", "8"))
# Hard cap on how much publisher text we keep. Not a formatting preference —
# it is the line between linking to someone's article and republishing it.
BLURB_MAX = 220
HTTP_TIMEOUT = 20
UA = {
    "User-Agent": (
        "UFC-Dashboard/1.0 "
        "(https://github.com/AndyRBrett/ufc-dashboard; andyrbrett@gmail.com)"
    )
}

# Free public feeds. No key, no quota, no per-call cost.
#
# Override the whole list with INTEL_FEEDS (a JSON array of the same shape) to
# add or drop a publisher without a code change. A feed that 404s, times out or
# returns junk is skipped and recorded in intel.json's `sources` block — it
# never takes the run down, and it is never silent either (see health note in
# CLAUDE.md: a broken pull and a good pull must be distinguishable).
DEFAULT_FEEDS = [
    {"id": "mmajunkie",   "name": "MMA Junkie",   "kind": "article",
     "url": "https://mmajunkie.usatoday.com/feed"},
    {"id": "mmafighting", "name": "MMA Fighting", "kind": "article",
     "url": "https://www.mmafighting.com/rss/current"},
    {"id": "sherdog",     "name": "Sherdog",      "kind": "article",
     "url": "https://www.sherdog.com/rss/news.xml"},
    {"id": "bloodyelbow", "name": "Bloody Elbow", "kind": "article",
     "url": "https://www.bloodyelbow.com/feed"},
    # YouTube channel Atom feeds — the free, key-less way to read a channel.
    # These carry the fight-week interviews, embedded media days and
    # breakdowns, which is the half of "intel" an article feed misses.
    {"id": "yt-ufc",      "name": "UFC",          "kind": "video",
     "url": "https://www.youtube.com/feeds/videos.xml?channel_id=UCvgfXK4nTYKudb0rFR6noLA"},
    {"id": "yt-mmaf",     "name": "MMA Fighting", "kind": "video",
     "url": "https://www.youtube.com/feeds/videos.xml?channel_id=UCGKz8KJvhNLXSZLdCKXQmiA"},
]


def feeds():
    raw = os.environ.get("INTEL_FEEDS", "").strip()
    if not raw:
        return DEFAULT_FEEDS
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) and parsed else DEFAULT_FEEDS
    except Exception:
        return DEFAULT_FEEDS


# ---------------------------------------------------------------------------
# data.js — reuse the shapes health.py already parses
# ---------------------------------------------------------------------------

EVENT_RE = re.compile(
    r'\{\s*name:"(?P<name>[^"]*)",\s*date:"(?P<date>\d{4}-\d{2}-\d{2})"'
)
SLUG_RE = re.compile(r'slug:"([^"]*)"')
FIGHT_RE = re.compile(
    r'\{lbl:"(?P<lbl>[^"]*)".*?'
    r'f1:\{n:"(?P<f1>[^"]*)".*?'
    r'f2:\{n:"(?P<f2>[^"]*)"'
)

# Bigger fish get more weight: an interview with the headliner is the reason
# someone opens this section, a prelim fighter's gym feature is filler.
ROLE_WEIGHT = {"Main Event": 3.0, "Co-Main": 2.2, "Main Card": 1.3}
PRELIM_WEIGHT = 0.7


def parse_events(text):
    """Slice the EVENTS block of data.js into [{name, date, slug, fighters}]."""
    i = text.find("var EVENTS=")
    if i == -1:
        return []
    block = text[i:]
    heads = list(EVENT_RE.finditer(block))
    events = []
    for n, m in enumerate(heads):
        end = heads[n + 1].start() if n + 1 < len(heads) else len(block)
        seg = block[m.start():end]
        slug_m = SLUG_RE.search(seg)
        fighters = []
        for fm in FIGHT_RE.finditer(seg):
            w = ROLE_WEIGHT.get(fm.group("lbl"), PRELIM_WEIGHT)
            for who in (fm.group("f1"), fm.group("f2")):
                if who and who.upper() != "TBD":
                    fighters.append({"name": who, "weight": w})
        events.append({
            "name": m.group("name"),
            "date": m.group("date"),
            "slug": slug_m.group(1) if slug_m else "",
            "fighters": fighters,
        })
    return events


# ---------------------------------------------------------------------------
# Name matching — mirrors nmKey() in index.html so the two agree on identity
# ---------------------------------------------------------------------------

_SUFFIX_RE = re.compile(r"\b(?:jr|sr|ii|iii|iv)\b")


def nm_key(n):
    s = unicodedata.normalize("NFD", str(n or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[.,'’`‘\-]", " ", s)
    s = _SUFFIX_RE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


# A surname alone is only allowed to identify a fighter when it cannot plausibly
# be anything else. These are the ones that can.
COMMON_WORDS = {
    "silva", "santos", "jones", "young", "green", "price", "white", "king",
    "walker", "page", "hill", "wood", "cannon", "rose", "gray", "grey",
    "moreno", "garcia", "rodriguez", "martinez", "lopez", "hernandez", "perez",
    "sanchez", "gomez", "diaz", "fernandes", "pereira", "oliveira", "costa",
    "allen", "brady", "holland", "nelson", "murphy", "phillips", "roberts",
}


def build_matchers(events):
    """Per-fighter matchers, plus the set of surnames unique across ALL cards.

    Uniqueness is checked over every event in data.js, not just the ones in the
    window: "Silva" resolving to the wrong Silva is the mis-attribution this
    whole section lives or dies on.
    """
    surname_owners = {}
    for ev in events:
        for f in ev["fighters"]:
            parts = nm_key(f["name"]).split()
            if len(parts) >= 2:
                surname_owners.setdefault(parts[-1], set()).add(nm_key(f["name"]))
    unique_surnames = {s for s, owners in surname_owners.items()
                       if len(owners) == 1 and len(s) >= 5 and s not in COMMON_WORDS}
    return unique_surnames


def match_fighters(text_key, fighters, unique_surnames):
    """Which of `fighters` this item is about. Returns [(name, weight, strong)]."""
    hits = []
    for f in fighters:
        key = nm_key(f["name"])
        if not key:
            continue
        parts = key.split()
        full = re.search(r"\b" + re.escape(key) + r"\b", text_key)
        if full:
            hits.append((f["name"], f["weight"], True))
            continue
        if len(parts) >= 2:
            surname = parts[-1]
            if surname in unique_surnames and re.search(
                r"\b" + re.escape(surname) + r"\b", text_key
            ):
                # Weaker signal, so it counts for less and can't carry an item
                # on its own (see keep-rule in curate()).
                hits.append((f["name"], f["weight"] * 0.4, False))
    return hits


# ---------------------------------------------------------------------------
# Feed reading — stdlib XML, no new dependency
# ---------------------------------------------------------------------------

ATOM = "{http://www.w3.org/2005/Atom}"
MEDIA = "{http://search.yahoo.com/mrss/}"


def strip_html(s):
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = _html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def blurb_of(s):
    t = strip_html(s)
    if len(t) <= BLURB_MAX:
        return t
    cut = t[:BLURB_MAX].rsplit(" ", 1)[0]
    return cut + "…"


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except Exception:
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except Exception:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def read_feed(feed):
    """Fetch and parse one feed. Returns (items, status) — never raises."""
    try:
        r = requests.get(feed["url"], headers=UA, timeout=HTTP_TIMEOUT)
    except Exception as e:
        return [], "error: %s" % type(e).__name__
    if r.status_code != 200:
        return [], r.status_code
    try:
        root = ET.fromstring(r.content)
    except Exception as e:
        return [], "unparseable: %s" % type(e).__name__

    items = []
    # RSS 2.0
    for it in root.iter("item"):
        link = (it.findtext("link") or "").strip()
        items.append({
            "title": strip_html(it.findtext("title") or ""),
            "url": link,
            "summary": it.findtext("description") or "",
            "published": parse_date(it.findtext("pubDate")),
            "thumb": None,
        })
    # Atom (YouTube channel feeds)
    for it in root.iter(ATOM + "entry"):
        link_el = it.find(ATOM + "link")
        url = (link_el.get("href") if link_el is not None else "") or ""
        group = it.find(MEDIA + "group")
        summary, thumb = "", None
        if group is not None:
            summary = group.findtext(MEDIA + "description") or ""
            th = group.find(MEDIA + "thumbnail")
            if th is not None:
                thumb = th.get("url")
        items.append({
            "title": strip_html(it.findtext(ATOM + "title") or ""),
            "url": url.strip(),
            "summary": summary,
            "published": parse_date(it.findtext(ATOM + "published")
                                    or it.findtext(ATOM + "updated")),
            "thumb": thumb,
        })
    return items, r.status_code


# ---------------------------------------------------------------------------
# Curation
# ---------------------------------------------------------------------------

def days_out(date_str, today):
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d").date()
    except Exception:
        return 9999
    return (d - today).days


def curate(events, now=None):
    now = now or datetime.now(timezone.utc)
    today = now.date()
    upcoming = [e for e in events
                if -WINDOW_PAST_DAYS <= days_out(e["date"], today) <= WINDOW_DAYS]
    out = {"generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
           "window_days": WINDOW_DAYS, "sources": [], "events": {}}
    if not upcoming:
        return out

    unique_surnames = build_matchers(events)
    raw = []
    for feed in feeds():
        items, status = read_feed(feed)
        kept = 0
        for it in items:
            if not it["title"] or not it["url"].startswith(("http://", "https://")):
                continue
            if it["published"] and (now - it["published"]).days > MAX_ITEM_AGE_DAYS:
                continue
            it["source"] = feed["name"]
            it["source_id"] = feed["id"]
            it["kind"] = feed.get("kind", "article")
            raw.append(it)
            kept += 1
        out["sources"].append({"id": feed["id"], "name": feed["name"],
                               "status": status, "items": kept})

    seen_urls = set()
    for ev in upcoming:
        scored = []
        for it in raw:
            text_key = nm_key(it["title"] + " " + strip_html(it["summary"]))
            hits = match_fighters(text_key, ev["fighters"], unique_surnames)
            # A surname-only hit is never enough on its own: that is exactly how
            # an item about a different Silva ends up on this card.
            if not any(strong for _, _, strong in hits):
                continue
            age_days = (now - it["published"]).days if it["published"] else 7
            recency = max(0.2, 1.0 - (age_days / float(MAX_ITEM_AGE_DAYS)))
            video_bonus = 1.15 if it["kind"] == "video" else 1.0
            score = sum(w for _, w, _ in hits) * recency * video_bonus
            scored.append((score, it, hits))
        scored.sort(key=lambda t: -t[0])

        chosen, seen_titles, per_source = [], set(), {}
        for score, it, hits in scored:
            tkey = nm_key(it["title"])
            if tkey in seen_titles or it["url"] in seen_urls:
                continue
            # No single publisher gets to fill the section.
            if per_source.get(it["source_id"], 0) >= 3:
                continue
            seen_titles.add(tkey)
            seen_urls.add(it["url"])
            per_source[it["source_id"]] = per_source.get(it["source_id"], 0) + 1
            chosen.append({
                "title": it["title"][:180],
                "url": it["url"],
                "source": it["source"],
                "kind": it["kind"],
                "published": it["published"].strftime("%Y-%m-%dT%H:%M:%SZ")
                             if it["published"] else None,
                "thumb": it["thumb"],
                "blurb": blurb_of(it["summary"]),
                "fighters": sorted({n for n, _, strong in hits if strong}),
            })
            if len(chosen) >= MAX_ITEMS_PER_EVENT:
                break

        key = ev["slug"] or ev["date"]
        out["events"][key] = {"name": ev["name"], "date": ev["date"],
                              "items": chosen}
    return out


# ---------------------------------------------------------------------------
# Cadence gate — free to call, but not free to commit
# ---------------------------------------------------------------------------

def read_state():
    try:
        return json.loads(STATE_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {}


def card_fingerprint(events, now):
    """Identity of the cards we are curating: slug, date and full roster.

    Any change here — a late replacement, a withdrawal, a moved date, a card
    entering the window — means the curated set is describing a card that no
    longer exists, so it must be rebuilt now rather than at the next slot. Late
    replacements are precisely the thing that lands inside a cadence window (the
    Jessie Rosas withdrawal in update.yml's comment was announced the day before
    the fight).
    """
    today = now.date()
    parts = []
    for e in sorted(events, key=lambda e: (e["date"], e["slug"])):
        if not (-WINDOW_PAST_DAYS <= days_out(e["date"], today) <= WINDOW_DAYS):
            continue
        roster = sorted(nm_key(f["name"]) for f in e["fighters"])
        parts.append("%s|%s|%s" % (e["slug"], e["date"], ",".join(roster)))
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:16]


def should_fetch(events, state, now):
    """Feeds cost no quota, but a pull every 5 minutes on fight night would add a
    commit to every one of those runs for content that changes hourly at best."""
    if os.environ.get("INTEL_FORCE"):
        return True, "forced"
    today = now.date()
    # Same lower bound as curate(), for the same reason: during a live card
    # days_out is already -1, and a >= 0 filter would report "no card within 10d"
    # and stop refreshing the set mid-event.
    nearest = min([days_out(e["date"], today) for e in events
                   if days_out(e["date"], today) >= -WINDOW_PAST_DAYS] or [9999])
    if nearest > WINDOW_DAYS:
        return False, "no card within %dd (nearest %dd)" % (WINDOW_DAYS, nearest)
    last = parse_date(state.get("last_fetch"))
    if not last:
        return True, "no previous pull"
    # The fingerprint outranks the interval. Waiting up to 8 hours to notice a
    # fighter swap would leave the section showing intel about someone who is no
    # longer on the card, through exactly the days when people are reading it.
    fp = card_fingerprint(events, now)
    if state.get("fingerprint") and state["fingerprint"] != fp:
        return True, "card changed (roster/date fingerprint moved)"
    interval = timedelta(hours=3 if nearest <= 3 else 8)
    if now - last < interval:
        return False, "last pull %s ago (interval %s)" % (now - last, interval)
    return True, "due"


def main():
    if not DATA_JS.exists():
        print("intel: no data.js — nothing to curate")
        return 0
    events = parse_events(DATA_JS.read_text(encoding="utf-8"))
    if not events:
        print("intel: EVENTS did not parse — leaving intel.json untouched")
        return 0

    now = datetime.now(timezone.utc)
    go, why = should_fetch(events, read_state(), now)
    if not go:
        print("intel: skipped (%s)" % why)
        return 0

    result = curate(events, now=now)
    n_items = sum(len(e["items"]) for e in result["events"].values())
    OUT_JSON.write_text(json.dumps(result, indent=1, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    STATE_JSON.write_text(json.dumps({
        "last_fetch": result["generated_at"],
        # What the curated set was built against. The next run compares against
        # this to notice a replacement or date move inside the cadence window.
        "fingerprint": card_fingerprint(events, now),
        "sources": result["sources"],
        "events": len(result["events"]),
        "items": n_items,
    }, indent=1) + "\n", encoding="utf-8")

    dead = [s for s in result["sources"] if s["status"] != 200]
    for s in dead:
        print("::warning::intel: feed %s returned %s" % (s["id"], s["status"]))
    print("intel: %d event(s), %d item(s), %d/%d feeds ok"
          % (len(result["events"]), n_items,
             len(result["sources"]) - len(dead), len(result["sources"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
