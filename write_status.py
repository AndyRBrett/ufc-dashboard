#!/usr/bin/env python3
"""
Data-freshness + odds-movement status writer — emits overseer-status.json.

A green GitHub Actions run only proves the request/parse completed; it does NOT
prove the data moved. The common silent failure is the upstream odds feed
freezing and returning the same lines for hours while every scrape keeps
"succeeding". This writes a freshness assertion the Project Overseer reads
alongside run success.

Freshness is tracked PER EVENT, not as one global fingerprint: during fight week
some events move hourly while others sit static, so a single global hash hides
one event whose feed has frozen behind the others that are still updating. For
each event we carry a `last_changed_at` forward across runs (reset whenever its
odds change) and flag `is_stale` once an upcoming event's lines have sat
unchanged past STALE_THRESHOLD_HOURS.

Odds snapshots are appended (never overwritten) to odds-snapshots.jsonl, and the
opening line per bout is read back from that log so each event publishes
`open_odds`, `current_odds`, and `line_movement` (current minus open) — turning
the freshness checker into an actual odds tracker. Implements #15.

A successfully-fetched-but-empty page parses to zero bouts, whose odds
fingerprint is the SHA-256 of the empty string (e3b0c442...). Such events carry
`has_data: false` and are excluded from the `fresh_events` health count so an
empty extraction never reads as up-to-date. Fixes #14.

Run after scrape.py in the same workflow; overseer-status.json is committed each
run so `generated_at` itself doubles as a liveness heartbeat.
"""

import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

DATA_PATH     = Path("data.js")
STATUS_PATH   = Path("overseer-status.json")
SNAPSHOT_PATH = Path("odds-snapshots.jsonl")

# Upcoming-event odds refresh at most once per day (the 09:00 UTC rebuild), so a
# single day's gap is normal. 48h flags an event whose lines have sat unchanged
# across multiple refresh cycles while the card is still live — i.e. that one
# feed has frozen, even as other events keep moving.
STALE_THRESHOLD_HOURS = 48

# SHA-256 of the empty string. An event that parsed to zero bouts hashes to this,
# which is the tell for a successfully-fetched-but-empty page (see #14).
EMPTY_SHA = hashlib.sha256(b"").hexdigest()

# Minimum bouts for an event to count as a real extraction rather than an empty
# (or near-empty) payload.
MIN_BOUTS = 1

# A single serialised fight: odds literal followed by both fighters' names.
# Matches scrape.fight_js output, which emits each fight on one line.
FIGHT_RE = re.compile(
    r'odds:\{f1:(-?\d+),f2:(-?\d+)\},'
    r'winner:"[^"]*",method:"[^"]*",round:[^,]*,state:"[^"]*",'
    r'f1:\{n:"([^"]+)"[^}]*\},f2:\{n:"([^"]+)"'
)
# Event header — name immediately followed by date, as serialised by events_js.
EVENT_RE = re.compile(r'name:"([^"]+)",\s*\n\s*date:"(\d{4}-\d{2}-\d{2})"')


def iso_z(dt):
    """Format a UTC datetime as ISO-8601 with a Z suffix."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def slug(s):
    """Lowercase alnum slug for stable event ids."""
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s.lower())).strip("-")


def parse_events(data):
    """Slice the `var EVENTS=` block into per-event dicts.

    Returns [{event_id, date, fights:[{f1, f2, f1_odds, f2_odds}]}], scoped to the
    EVENTS block so RESULTS_ARCHIVE never contaminates the counts.
    """
    i = data.find("var EVENTS=")
    block = data[i:] if i != -1 else data

    heads = list(EVENT_RE.finditer(block))
    events = []
    for n, m in enumerate(heads):
        name, date = m.group(1), m.group(2)
        end = heads[n + 1].start() if n + 1 < len(heads) else len(block)
        fights = [
            {"f1": f1n, "f2": f2n, "f1_odds": int(f1o), "f2_odds": int(f2o)}
            for f1o, f2o, f1n, f2n in FIGHT_RE.findall(block[m.start():end])
        ]
        events.append({"event_id": f"{date}:{slug(name)}", "date": date, "fights": fights})
    return events


def fingerprint(fights):
    """Stable hash of an event's odds, keyed by fighter so reordering is ignored."""
    parts = sorted(f"{f['f1']}:{f['f1_odds']},{f['f2']}:{f['f2_odds']}" for f in fights)
    return hashlib.sha256(";".join(parts).encode("utf-8")).hexdigest()


def has_data(fights):
    """True when the event holds a real extraction, not an empty/near-empty page."""
    return len(fights) >= MIN_BOUTS


def matchup_key(fight):
    """Order-independent key for a bout, so a fighter swap still matches its opener."""
    return tuple(sorted((fight["f1"], fight["f2"])))


def realign(open_fight, cur_fight):
    """Re-key an opening bout's odds onto the current bout's f1/f2 order so
    open_odds, current_odds and line_movement all line up fighter-for-fighter.
    Falls back to the current odds when this matchup has no recorded opener yet
    (i.e. its first time seen — opening line is wherever it started)."""
    if not open_fight:
        return dict(cur_fight)
    o = {open_fight["f1"]: open_fight["f1_odds"], open_fight["f2"]: open_fight["f2_odds"]}
    return {
        "f1": cur_fight["f1"], "f2": cur_fight["f2"],
        "f1_odds": o.get(cur_fight["f1"], cur_fight["f1_odds"]),
        "f2_odds": o.get(cur_fight["f2"], cur_fight["f2_odds"]),
    }


def delta(open_fight, cur_fight):
    """Line movement for a bout: current minus open, fighter-aligned. Zero when
    no opener exists yet."""
    op = realign(open_fight, cur_fight)
    return {
        "f1": cur_fight["f1"], "f2": cur_fight["f2"],
        "f1_odds": cur_fight["f1_odds"] - op["f1_odds"],
        "f2_odds": cur_fight["f2_odds"] - op["f2_odds"],
    }


def load_prev_events():
    """Map event_id -> previous status entry, tolerating older schemas."""
    if not STATUS_PATH.exists():
        return {}, None
    try:
        prev = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        return {}, str(e)
    return {e["event_id"]: e for e in prev.get("events", [])}, None


def load_open_odds():
    """Opening line per event per matchup from the append-only snapshot log.

    The first time a bout appears is its opening line; later snapshots are
    ignored so `open_odds` stays anchored to where the market started.
    Returns {event_id: {matchup_key: fight_dict}}.
    """
    opens = {}
    if not SNAPSHOT_PATH.exists():
        return opens
    with SNAPSHOT_PATH.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                snap = json.loads(line)
            except json.JSONDecodeError:
                continue
            for ev in snap.get("events", []):
                bucket = opens.setdefault(ev["event_id"], {})
                for f in ev.get("fights", []):
                    bucket.setdefault(matchup_key(f), f)
    return opens


def last_snapshot_fp():
    """Global fingerprint of the most recent appended snapshot, or None."""
    if not SNAPSHOT_PATH.exists():
        return None
    last = None
    with SNAPSHOT_PATH.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                last = line
    if not last:
        return None
    try:
        return json.loads(last).get("fp")
    except json.JSONDecodeError:
        return None


def main():
    now      = datetime.now(timezone.utc)
    today    = now.strftime("%Y-%m-%d")
    now_iso  = iso_z(now)
    errors   = []

    if not DATA_PATH.exists():
        errors.append("data.js not found")
        events = []
    else:
        events = parse_events(DATA_PATH.read_text(encoding="utf-8"))

    if events and not any(e["fights"] for e in events):
        errors.append("no odds found in data.js")

    prev_by_id, prev_err = load_prev_events()
    if prev_err:
        errors.append(f"could not read previous status: {prev_err}")
    open_by_id = load_open_odds()

    out_events       = []
    stale_events     = 0
    fresh_events     = 0
    events_with_data = 0
    empty_payload    = 0
    for ev in events:
        fp      = fingerprint(ev["fights"])
        data_ok = has_data(ev["fights"]) and fp != EMPTY_SHA
        prev    = prev_by_id.get(ev["event_id"])
        # Carry last_changed_at forward only if the odds fingerprint is unchanged;
        # that is what lets per-event staleness accumulate across runs.
        if prev and prev.get("fingerprint") == fp and prev.get("last_changed_at"):
            last_changed_at = prev["last_changed_at"]
        else:
            last_changed_at = now_iso

        try:
            age_h = (now - datetime.strptime(last_changed_at, "%Y-%m-%dT%H:%M:%SZ")
                     .replace(tzinfo=timezone.utc)).total_seconds() / 3600
        except ValueError:
            age_h = 0.0

        # Only upcoming events with tracked odds can be "stale" — concluded events
        # have permanently final lines, and an event with no odds has nothing to
        # freeze. Both are legitimately static, not degraded.
        upcoming = ev["date"] >= today and data_ok
        is_stale = upcoming and age_h > STALE_THRESHOLD_HOURS
        if is_stale:
            stale_events += 1

        # Empty-payload events are excluded from the fresh/health count entirely so
        # a silent extraction failure never reads as up-to-date (#14).
        if data_ok:
            events_with_data += 1
            if not is_stale:
                fresh_events += 1
        else:
            empty_payload += 1

        opens = open_by_id.get(ev["event_id"], {})
        out_events.append({
            "event_id":        ev["event_id"],
            "last_changed_at": last_changed_at,
            "is_stale":        is_stale,
            "has_data":        data_ok,
            "open_odds":       [realign(opens.get(matchup_key(f)), f) for f in ev["fights"]],
            "current_odds":    ev["fights"],
            "line_movement":   [delta(opens.get(matchup_key(f)), f) for f in ev["fights"]],
            "fingerprint":     fp,
        })

    # Surface empty extractions in errors too, so the run cannot look clean while
    # carrying events with no parsed bouts.
    empty_ids = [e["event_id"] for e in out_events if not e["has_data"]]
    if empty_ids:
        errors.append("empty payload (no bouts parsed): " + ", ".join(empty_ids))

    status = {
        "generated_at":              now_iso,
        "events_tracked":            len(out_events),
        "events_with_data":          events_with_data,
        "events_with_empty_payload": empty_payload,
        "fresh_events":              fresh_events,
        "stale_events":              stale_events,
        "stale_threshold_hours":     STALE_THRESHOLD_HOURS,
        "events":                    out_events,
        "errors":                    errors,
    }
    STATUS_PATH.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")

    # Append a timestamped odds snapshot for line-movement history, but only when
    # the odds actually changed since the last one — keeps the append-only log from
    # bloating under the 5-minute fight-window cadence. Empty events are excluded.
    snapshot = {
        "at": now_iso,
        "events": [
            {"event_id": ev["event_id"], "fights": ev["fights"]}
            for ev in events if has_data(ev["fights"])
        ],
    }
    snapshot["fp"] = hashlib.sha256(
        json.dumps(snapshot["events"], sort_keys=True).encode("utf-8")
    ).hexdigest()
    if snapshot["events"] and snapshot["fp"] != last_snapshot_fp():
        with SNAPSHOT_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(snapshot) + "\n")

    print(json.dumps(status), file=sys.stderr)


if __name__ == "__main__":
    main()
