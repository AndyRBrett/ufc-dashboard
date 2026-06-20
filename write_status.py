#!/usr/bin/env python3
"""
Data-freshness status writer — emits overseer-status.json at the repo root.

A green GitHub Actions run only proves the request/parse completed; it does NOT
prove the data moved. The common silent failure is the upstream odds feed
freezing and returning the same lines for hours while every scrape keeps
"succeeding". This writes a freshness assertion the Project Overseer reads
alongside run success: it fingerprints the odds embedded in data.js and flags
`data_stale` when that fingerprint hasn't changed for longer than
STALE_THRESHOLD_HOURS. Implements #10 — a check distinct from HTTP/scrape success.

Run after scrape.py in the same workflow; the resulting overseer-status.json is
committed each run so `generated_at` itself doubles as a liveness heartbeat.
"""

import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

DATA_PATH   = Path("data.js")
STATUS_PATH = Path("overseer-status.json")

# Odds are refreshed at most once per day (the daily 09:00 UTC rebuild), so a
# single day's gap between identical snapshots is normal. 24h flags odds that
# have genuinely stopped moving across more than one refresh cycle — a freeze,
# not the normal cadence.
STALE_THRESHOLD_HOURS = 24

# Matches the odds literals serialised by scrape.fight_js: odds:{f1:-150,f2:130}
ODDS_RE = re.compile(r"odds:\{f1:(-?\d+),f2:(-?\d+)\}")


def iso_z(dt):
    """Format a UTC datetime as ISO-8601 with a Z suffix."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def events_block(data):
    """Return just the `var EVENTS=` slice so odds/event counts ignore archives."""
    i = data.find("var EVENTS=")
    return data[i:] if i != -1 else data


def main():
    now    = datetime.now(timezone.utc)
    errors = []

    if not DATA_PATH.exists():
        errors.append("data.js not found")
        events = block = ""
    else:
        events = DATA_PATH.read_text(encoding="utf-8")
        block  = events_block(events)

    # Fingerprint the odds snapshot — order is deterministic from the rebuild,
    # so identical lines hash to an identical fingerprint run-over-run.
    odds = ODDS_RE.findall(block)
    odds_fingerprint = hashlib.sha256(
        ";".join(f"{a},{b}" for a, b in odds).encode("utf-8")
    ).hexdigest()

    # One date: literal per event in the EVENTS block.
    events_tracked = len(re.findall(r'date:"\d{4}-\d{2}-\d{2}"', block))

    if block and not odds:
        errors.append("no odds found in data.js")

    # Carry last_data_at forward from the previous status unless the fingerprint
    # changed; that's what lets staleness accumulate across runs.
    last_data_at = iso_z(now)
    if STATUS_PATH.exists():
        try:
            prev = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
            if prev.get("odds_fingerprint") == odds_fingerprint and prev.get("last_data_at"):
                last_data_at = prev["last_data_at"]
        except (json.JSONDecodeError, OSError) as e:
            errors.append(f"could not read previous status: {e}")

    try:
        age_h = (now - datetime.strptime(last_data_at, "%Y-%m-%dT%H:%M:%SZ")
                 .replace(tzinfo=timezone.utc)).total_seconds() / 3600
    except ValueError:
        age_h = 0.0
    data_stale = age_h > STALE_THRESHOLD_HOURS

    status = {
        "generated_at":         iso_z(now),
        "last_data_at":         last_data_at,
        "odds_fingerprint":     odds_fingerprint,
        "data_stale":           data_stale,
        "stale_threshold_hours": STALE_THRESHOLD_HOURS,
        "events_tracked":       events_tracked,
        "errors":               errors,
    }
    STATUS_PATH.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(status), file=sys.stderr)


if __name__ == "__main__":
    main()
