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
one event whose feed has frozen behind the others that are still updating. Each
event's `last_changed_at` is reconstructed from the snapshot history (the most
recent run of unchanged odds), and `is_stale` flags an upcoming event whose lines
have sat unchanged past STALE_THRESHOLD_HOURS.

The full per-bout odds time-series — the product data that line-movement charts
are built from — lives in the append-only odds-snapshots.jsonl log. Implements
#15. overseer-status.json is deliberately LEAN: the Project Overseer reads it
into context every weekly run, so per event it reports only freshness fields plus
a single representative `line_movement` (the main-event line's drift, current
minus open) — not the full per-bout arrays.

Steam moves are surfaced as actionable signals rather than left buried in the
snapshot log: any bout whose line has drifted at least MOVEMENT_ALERT_THRESHOLD
points from its opener (across the whole card, not just the headliner) is emitted
in an `alerts` array, and optionally POSTed to ALERT_WEBHOOK_URL. Implements #17.

A successfully-fetched-but-empty page parses to zero odds-bearing bouts, whose
fingerprint is the SHA-256 of the empty string (e3b0c442...). But "zero odds" has
two very different causes that the old code conflated into a single `has_data:
false` that always read as an error: a card whose bouts are announced but whose
sportsbook lines simply aren't posted yet (an event weeks out — legitimately
empty), versus an event we *expected* lines for and got none (imminent, or odds
that were present and then vanished — a real failure). Each event now carries a
`status` of "ok", "awaiting-card", or "parse-failure" (see classify_event), and
ONLY parse-failures are surfaced in `errors`, so a far-out card that hasn't been
priced no longer pollutes the error/status list. Empty events of either kind
never count toward `stale_events` or any health signal, so an empty extraction
cannot read as up-to-date. Fixes #14.

Run after scrape.py in the same workflow; overseer-status.json is committed each
run so `generated_at` itself doubles as a liveness heartbeat.
"""

import hashlib
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DATA_PATH     = Path("data.js")
STATUS_PATH   = Path("overseer-status.json")
SNAPSHOT_PATH = Path("odds-snapshots.jsonl")

# A bout whose moneyline has drifted at least this many points from its opening
# line is a "steam move" worth flagging — the sharpest signal this tracker
# captures (#17). Configurable so it can be tuned without a code change; the
# headliner line_movement was already computed but only the lean single value
# surfaced, so undercard steam stayed buried in the snapshot log.
MOVEMENT_ALERT_THRESHOLD = int(os.environ.get("MOVEMENT_ALERT_THRESHOLD", "10"))

# Optional outbound notification. When set, the alerts array is POSTed as JSON to
# this URL each run that produces movers (Slack/Discord/webhook). Unset = no-op.
ALERT_WEBHOOK_URL = os.environ.get("ALERT_WEBHOOK_URL", "")

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

# Sportsbooks post UFC moneylines roughly two weeks out, and the daily rebuild
# pulls them in as soon as they exist. So an upcoming event with announced bouts
# but no odds within this window is a "parse-failure" — we expected lines and got
# none — whereas one further out is just "awaiting-card" (priced later, not
# broken). Tunable without a code change. Fixes #14's core conflation.
ODDS_EXPECTED_WITHIN_DAYS = int(os.environ.get("ODDS_EXPECTED_WITHIN_DAYS", "14"))

# A single serialised fight: odds literal followed by both fighters' names.
# Matches scrape.fight_js output, which emits each fight on one line.
FIGHT_RE = re.compile(
    r'odds:\{f1:(-?\d+),f2:(-?\d+)\},'
    r'winner:"[^"]*",method:"[^"]*",round:[^,]*,state:"[^"]*",'
    r'f1:\{n:"([^"]+)"[^}]*\},f2:\{n:"([^"]+)"'
)
# Any serialised bout, whether or not it carries odds (odds:null bouts don't
# match FIGHT_RE). Counts the announced card so an event with fighters but no
# posted lines reads as "awaiting-card", not a zero-bout parse failure (#14).
BOUT_RE = re.compile(r'f1:\{n:"[^"]+"[^}]*\},f2:\{n:"[^"]+"')
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

    Returns [{event_id, date, bout_count, fights:[{f1, f2, f1_odds, f2_odds}]}],
    scoped to the EVENTS block so RESULTS_ARCHIVE never contaminates the counts.
    `fights` holds only odds-bearing bouts (what the time-series tracks);
    `bout_count` is the full announced card (odds-bearing or not), which lets an
    event with fighters but no posted lines be told apart from a true zero-bout
    parse failure (#14).
    """
    i = data.find("var EVENTS=")
    block = data[i:] if i != -1 else data

    heads = list(EVENT_RE.finditer(block))
    events = []
    for n, m in enumerate(heads):
        name, date = m.group(1), m.group(2)
        end = heads[n + 1].start() if n + 1 < len(heads) else len(block)
        seg = block[m.start():end]
        fights = [
            {"f1": f1n, "f2": f2n, "f1_odds": int(f1o), "f2_odds": int(f2o)}
            for f1o, f2o, f1n, f2n in FIGHT_RE.findall(seg)
        ]
        events.append({
            "event_id": f"{date}:{slug(name)}",
            "date": date,
            "bout_count": len(BOUT_RE.findall(seg)),
            "fights": fights,
        })
    return events


def fingerprint(fights):
    """Stable hash of an event's odds, keyed by fighter so reordering is ignored."""
    parts = sorted(f"{f['f1']}:{f['f1_odds']},{f['f2']}:{f['f2_odds']}" for f in fights)
    return hashlib.sha256(";".join(parts).encode("utf-8")).hexdigest()


def has_data(fights):
    """True when the event holds a real extraction, not an empty/near-empty page."""
    return len(fights) >= MIN_BOUTS


def classify_event(ev, ev_hist, today):
    """Disambiguate an event's extraction state into one of three statuses (#14).

    - "ok":            at least one odds-bearing bout parsed — a real extraction.
    - "parse-failure": we expected lines and got none. Either the odds were
                       present in this event's snapshot history and have since
                       vanished (a regression), or the event is close enough that
                       books should already be pricing it (within
                       ODDS_EXPECTED_WITHIN_DAYS).
    - "awaiting-card": no odds yet, but legitimately so — an upcoming event still
                       far enough out that sportsbooks haven't posted lines, or a
                       past event that simply never carried odds. Not actionable,
                       so it must NOT pollute the error list.

    `today` is a YYYY-MM-DD string; `ev_hist` is this event's snapshot history as
    returned by load_snapshot_history (a list of (at, fights)).
    """
    if has_data(ev["fights"]):
        return "ok"

    # Odds present before and gone now ⇒ a real regression, whatever the date.
    if any(fights for _at, fights in ev_hist):
        return "parse-failure"

    try:
        days_out = (datetime.strptime(ev["date"], "%Y-%m-%d").date()
                    - datetime.strptime(today, "%Y-%m-%d").date()).days
    except ValueError:
        days_out = None

    # Past events never priced (e.g. results-only archive rows) aren't broken and
    # will never be priced retroactively — benign, not a failure.
    if days_out is None or days_out < 0:
        return "awaiting-card"

    # Imminent and still unpriced ⇒ lines were expected by now. An announced card
    # (fighters but no odds) makes this an unambiguous odds parse failure.
    if days_out <= ODDS_EXPECTED_WITHIN_DAYS:
        return "parse-failure"

    return "awaiting-card"


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


def event_movers(fights, opens, threshold):
    """Bouts whose line has moved at least `threshold` points from its opener.

    A steam move on either fighter trips the alert (American odds aren't
    symmetric, so each side's drift is reported independently). Returns one entry
    per qualifying bout, ordered as the card is, each tagged with the larger of
    the two absolute drifts so callers can sort by severity. Bouts with no
    recorded opener yet have zero movement and never alert.
    """
    movers = []
    for i, f in enumerate(fights):
        d = delta(opens.get(matchup_key(f)), f)
        magnitude = max(abs(d["f1_odds"]), abs(d["f2_odds"]))
        if magnitude >= threshold:
            movers.append({
                "f1": f["f1"], "f2": f["f2"],
                "f1_movement": d["f1_odds"], "f2_movement": d["f2_odds"],
                "magnitude": magnitude,
                "main_event": i == 0,
            })
    return movers


def post_alerts(alerts):
    """Best-effort POST of the alerts payload to ALERT_WEBHOOK_URL.

    Never raises: a notification failure must not fail the status run, which is
    also a liveness heartbeat. No-op when the URL is unset or there's nothing to
    send.
    """
    if not ALERT_WEBHOOK_URL or not alerts:
        return
    body = json.dumps({"alerts": alerts}).encode("utf-8")
    req  = urllib.request.Request(
        ALERT_WEBHOOK_URL, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(req, timeout=10)
        print(f"Posted {len(alerts)} line-movement alert(s) to webhook", file=sys.stderr)
    except Exception as e:
        print(f"Alert webhook failed: {e}", file=sys.stderr)


def load_snapshot_history():
    """Per-event ordered odds history from the append-only snapshot log.

    Returns {event_id: [(at, fights), ...]} oldest->newest. This is the single
    source of truth for both the opening line and `last_changed_at`, so the lean
    status file needn't store a per-event fingerprint to track change over runs.
    """
    history = {}
    if not SNAPSHOT_PATH.exists():
        return history
    with SNAPSHOT_PATH.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                snap = json.loads(line)
            except json.JSONDecodeError:
                continue
            at = snap.get("at")
            for ev in snap.get("events", []):
                history.setdefault(ev["event_id"], []).append((at, ev.get("fights", [])))
    return history


def open_fights(event_history):
    """Opening line per matchup: the first time each bout appears in the log."""
    opens = {}
    for _at, fights in event_history:
        for f in fights:
            opens.setdefault(matchup_key(f), f)
    return opens


def last_changed_at(event_history, cur_fights, now_iso):
    """Reconstruct when the event's odds last changed, from snapshot history.

    Walks newest->oldest while each snapshot still matches the current odds and
    returns the oldest such match — i.e. when the current line first appeared.
    Falls back to now when the latest snapshot already differs (the odds moved
    this run) or the event has no recorded history yet.
    """
    cur_fp = fingerprint(cur_fights)
    changed = now_iso
    for at, fights in reversed(event_history):
        if at and fingerprint(fights) == cur_fp:
            changed = at
        else:
            break
    return changed


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

    history = load_snapshot_history()

    out_events   = []
    stale_events = 0
    alerts       = []
    for ev in events:
        fp       = fingerprint(ev["fights"])
        data_ok  = has_data(ev["fights"]) and fp != EMPTY_SHA
        ev_hist  = history.get(ev["event_id"], [])
        status_  = classify_event(ev, ev_hist, today)
        changed  = last_changed_at(ev_hist, ev["fights"], now_iso)

        try:
            age_h = (now - datetime.strptime(changed, "%Y-%m-%dT%H:%M:%SZ")
                     .replace(tzinfo=timezone.utc)).total_seconds() / 3600
        except ValueError:
            age_h = 0.0

        # Only upcoming events with tracked odds can be "stale" — concluded events
        # have permanently final lines, and an event with no odds has nothing to
        # freeze. Both are legitimately static, not degraded. Empty-payload events
        # are excluded here too, so a silent extraction never inflates the health
        # signal (#14).
        upcoming = ev["date"] >= today and data_ok
        is_stale = upcoming and age_h > STALE_THRESHOLD_HOURS
        if is_stale:
            stale_events += 1

        # One representative signal for the monitoring file: the headliner's line
        # drift (current minus open). Full per-bout movement stays in the snapshots.
        opens = open_fights(ev_hist)
        main  = ev["fights"][0] if ev["fights"] else None
        movement = delta(opens.get(matchup_key(main)), main)["f1_odds"] if main else 0

        # Steam-move alerts: surface every bout past the threshold, not just the
        # headliner's single line_movement. Empty-payload events have no real
        # lines to move, so they're skipped (#17).
        if data_ok:
            for mover in event_movers(ev["fights"], opens, MOVEMENT_ALERT_THRESHOLD):
                alerts.append({"event_id": ev["event_id"], **mover})

        out_events.append({
            "event_id":        ev["event_id"],
            "status":          status_,
            "last_changed_at": changed,
            "is_stale":        is_stale,
            "has_data":        data_ok,
            "bout_count":      ev["bout_count"],
            "line_movement":   movement,
        })

    # Surface only genuine parse failures in errors — events we expected lines for
    # and got none, or whose lines vanished. Awaiting-card events (an upcoming card
    # books simply haven't priced yet) are legitimately empty and must NOT pollute
    # the error/status list, which is exactly the false-error #14 was filing.
    failure_ids  = [e["event_id"] for e in out_events if e["status"] == "parse-failure"]
    awaiting_ids = [e["event_id"] for e in out_events if e["status"] == "awaiting-card"]
    if failure_ids:
        errors.append("parse failure (expected bouts, got none): " + ", ".join(failure_ids))

    # Loudest movers first, so the most actionable steam tops the list.
    alerts.sort(key=lambda a: a["magnitude"], reverse=True)

    status = {
        "generated_at":             now_iso,
        "events_tracked":           len(out_events),
        "stale_events":             stale_events,
        "parse_failure_events":     len(failure_ids),
        "awaiting_card_events":     len(awaiting_ids),
        "stale_threshold_hours":    STALE_THRESHOLD_HOURS,
        "movement_alert_threshold": MOVEMENT_ALERT_THRESHOLD,
        "events":                   out_events,
        "alerts":                   alerts,
        "errors":                   errors,
    }
    STATUS_PATH.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")

    # Optional push: notify a webhook when steam moves appear. Best-effort.
    post_alerts(alerts)

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
