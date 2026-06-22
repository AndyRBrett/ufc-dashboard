#!/usr/bin/env python3
"""
Per-fighter odds time-series + closing-line-value tracker — emits odds-series.json.

The append-only odds-snapshots.jsonl log already records every odds change per
bout, but as a flat run-by-run history: answering "how has this fighter's line
moved?" or "what was the closing line?" means re-scanning the whole log every
time. This rebuilds that log into the shape the product actually needs:

  * a per-bout odds TIME-SERIES (fighter-aligned across snapshots) so a one-shot
    odds alert becomes a movement chart — the points are ready to plot directly;
  * a per-fighter index, so a fighter's line history is one lookup, not a scan;
  * CLOSING-LINE VALUE: once an event is in the past its line is frozen, and we
    persist each bout's open, close, and clv (close − open, per fighter). The
    closing line is the sharp-betting benchmark, so storing it enables
    backtesting a pick's entry odds against where the market actually closed.

This deliberately BUILDS ON the fixed status logic (#14): the snapshot log only
ever contains events that passed has_data, so awaiting-card / parse-failure
events with no real lines are already excluded — we never chart an empty payload.

odds-series.json is regenerated in full from the snapshot log each run (idempotent
and order-stable), so it always reflects the complete history. Run after
write_status.py in the same workflow.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Shared, already-tested helpers live in write_status — the single source of
# truth for snapshot loading and fighter-aligned odds math, so the series here
# can't drift from the freshness/alert logic that reads the same log.
from write_status import (
    iso_z,
    load_snapshot_history,
    matchup_key,
    realign,
)

SERIES_PATH = Path("odds-series.json")


def _aligned_odds(snapshot_fight, canon):
    """Snapshot bout's odds re-keyed onto the canonical f1/f2 order.

    realign maps the snapshot's per-fighter odds onto canon's fighter order, so a
    later snapshot that serialised the two fighters the other way round still
    lines up fighter-for-fighter in the series. canon supplies only the names; its
    odds are never used (the snapshot always carries both fighters).
    """
    a = realign(snapshot_fight, {"f1": canon["f1"], "f2": canon["f2"],
                                 "f1_odds": 0, "f2_odds": 0})
    return a["f1_odds"], a["f2_odds"]


def build_bout_series(event_history):
    """Per-bout, fighter-aligned odds time-series for one event.

    Returns bouts in first-seen (card) order, each:
        {f1, f2, points, series:[{at, f1_odds, f2_odds}...]}
    Consecutive identical readings are collapsed, so each point marks an actual
    line change — the log appends on any bout's change, so an unchanged bout would
    otherwise repeat. Orientation is locked to each bout's first appearance.
    """
    canon  = {}     # matchup_key -> {f1, f2} (first-seen orientation)
    order  = []     # matchup_key in first-seen order
    series = {}     # matchup_key -> [{at, f1_odds, f2_odds}...]
    for at, fights in event_history:
        for f in fights:
            k = matchup_key(f)
            if k not in canon:
                canon[k] = {"f1": f["f1"], "f2": f["f2"]}
                order.append(k)
                series[k] = []
            f1o, f2o = _aligned_odds(f, canon[k])
            pts = series[k]
            if pts and pts[-1]["f1_odds"] == f1o and pts[-1]["f2_odds"] == f2o:
                continue  # unchanged since last recorded point — collapse
            pts.append({"at": at, "f1_odds": f1o, "f2_odds": f2o})

    bouts = []
    for k in order:
        c = canon[k]
        bouts.append({
            "f1":     c["f1"],
            "f2":     c["f2"],
            "points": len(series[k]),
            "series": series[k],
        })
    return bouts


def event_date(event_id):
    """The YYYY-MM-DD date prefix of an event_id, or None if unparseable."""
    head = event_id.split(":", 1)[0]
    try:
        return datetime.strptime(head, "%Y-%m-%d").date()
    except ValueError:
        return None


def closing_line(bout, concluded):
    """Open, close and closing-line value for a bout.

    open  = first recorded line. close = last recorded line, but only once the
    event has concluded — an upcoming bout's line is still moving, so its close is
    null and clv is deferred (charting it as "closed" would be wrong). clv is
    close − open per fighter: the market's total drift to the close, the benchmark
    a pick's entry odds is backtested against.
    """
    s = bout["series"]
    if not s:
        return None, None, None
    open_ = {"at": s[0]["at"], "f1_odds": s[0]["f1_odds"], "f2_odds": s[0]["f2_odds"]}
    if not concluded:
        return open_, None, None
    close = {"at": s[-1]["at"], "f1_odds": s[-1]["f1_odds"], "f2_odds": s[-1]["f2_odds"]}
    clv = {
        "f1_odds": close["f1_odds"] - open_["f1_odds"],
        "f2_odds": close["f2_odds"] - open_["f2_odds"],
    }
    return open_, close, clv


def build_series(history, today):
    """Whole-log → {events:[...], fighters:{...}}.

    events[] holds the full chartable per-bout series + open/close/clv. fighters{}
    is a no-duplication index: per fighter, a summary of each bout they appear in
    (which event, opponent, side, open/close/clv, point count) pointing back at the
    event series for the full curve. `today` is a date; an event on or before it is
    treated as concluded so its closing line is frozen.
    """
    events   = []
    fighters = {}
    for event_id in sorted(history):
        ed        = event_date(event_id)
        concluded = ed is not None and ed < today
        bouts_out = []
        for bout in build_bout_series(history[event_id]):
            open_, close, clv = closing_line(bout, concluded)
            entry = {**bout, "open": open_, "close": close, "clv": clv}
            bouts_out.append(entry)
            for side, name in (("f1", bout["f1"]), ("f2", bout["f2"])):
                fighters.setdefault(name, []).append({
                    "event_id": event_id,
                    "opponent": bout["f2"] if side == "f1" else bout["f1"],
                    "side":     side,
                    "points":   bout["points"],
                    "open":     None if open_ is None else open_[f"{side}_odds"],
                    "close":    None if close is None else close[f"{side}_odds"],
                    "clv":      None if clv is None else clv[f"{side}_odds"],
                })
        events.append({
            "event_id":  event_id,
            "concluded": concluded,
            "bouts":     bouts_out,
        })
    return {"events": events, "fighters": fighters}


def main():
    now     = datetime.now(timezone.utc)
    today   = now.date()
    history = load_snapshot_history()
    series  = {"generated_at": iso_z(now), **build_series(history, today)}
    SERIES_PATH.write_text(json.dumps(series, indent=2) + "\n", encoding="utf-8")
    print(
        f"odds-series.json: {len(series['events'])} events, "
        f"{len(series['fighters'])} fighters",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
