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

import alert_calibration as calib

DATA_PATH     = Path("data.js")
STATUS_PATH   = Path("overseer-status.json")
SNAPSHOT_PATH = Path("odds-snapshots.jsonl")
# Built by odds_series.py from the snapshot log; read here only to calibrate the
# per-tier alert thresholds (#93).
SERIES_PATH   = Path("odds-series.json")

# A bout whose moneyline has drifted at least this many points from its opening
# line is a "steam move" worth flagging — the sharpest signal this tracker
# captures (#17). Configurable so it can be tuned without a code change; the
# headliner line_movement was already computed but only the lean single value
# surfaced, so undercard steam stayed buried in the snapshot log.
MOVEMENT_ALERT_THRESHOLD = int(os.environ.get("MOVEMENT_ALERT_THRESHOLD", "10"))

# Optional outbound notification. When set, the alerts array is POSTed as JSON to
# this URL each run that produces movers (Slack/Discord/webhook). Unset = no-op.
ALERT_WEBHOOK_URL = os.environ.get("ALERT_WEBHOOK_URL", "")
# Which alerts have already been announced, so a standing steam move isn't
# re-posted every run (#67). Committed alongside the other state files.
ALERT_STATE_PATH = Path("odds-alert-state.json")
# An already-announced move must grow by this fraction to be news again. At 0.25
# a 20-point move re-alerts at 25 points, not at 21 — enough headroom that
# ordinary jitter around the threshold stays quiet.
ALERT_REGRESS_PCT = float(os.environ.get("ALERT_REGRESS_PCT", "0.25"))

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

# ...but "we expected lines and got none" is only a failure when a fetch could
# actually have delivered them. When the Odds API budget is spent there was no
# request to parse, so an unpriced card is the *known consequence* of a condition
# update.yml has already decided is a warning, not a break — and calling it a
# parse failure re-fails the run through the back door for the same root cause.
# That is exactly what happened on 2026-08-14: the quota hit zero, the newly
# announced 08-22 card could never be priced, and every run went red every 5
# minutes on a condition that self-heals at the monthly reset.
ODDS_STATE_PATH = Path(__file__).with_name("odds-state.json")


def odds_budget_exhausted(path=ODDS_STATE_PATH):
    """True when the last Odds API call failed *because the budget is spent*.

    The Odds API answers 401 for both a rejected key and an exhausted quota;
    x-requests-remaining tells them apart (0 = we spent it). A rejected key never
    self-heals and must keep failing the run, so only the quota case is excused
    here. Missing or unreadable state is treated as "not exhausted" — the
    conservative reading, which keeps genuine parse failures loud.
    """
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return state.get("last_status") in (401, 403) and state.get("requests_remaining") == 0

# A single serialised fight: odds literal followed by both fighters' names.
# Matches scrape.fight_js output, which emits each fight on one line.
FIGHT_RE = re.compile(
    r'lbl:"(?P<lbl>[^"]*)",wc:"(?P<wc>[^"]*)",[^{]*'
    r'odds:\{f1:(?P<f1_odds>-?\d+),f2:(?P<f2_odds>-?\d+)\},'
    r'winner:"[^"]*",method:"[^"]*",round:[^,]*,state:"[^"]*",'
    r'f1:\{n:"(?P<f1>[^"]+)"[^}]*\},f2:\{n:"(?P<f2>[^"]+)"'
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
        # lbl/wc ride along so the alert tier comes from the card itself rather
        # than a position guess, and so the snapshot log accumulates the weight
        # class a future per-division calibration will need (#93).
        fights = [
            {"f1": m2["f1"], "f2": m2["f2"],
             "f1_odds": int(m2["f1_odds"]), "f2_odds": int(m2["f2_odds"]),
             "lbl": m2["lbl"], "wc": m2["wc"]}
            for m2 in FIGHT_RE.finditer(seg)
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


def classify_event(ev, ev_hist, today, budget_exhausted=False):
    """Disambiguate an event's extraction state into one of four statuses (#14).

    - "ok":               at least one odds-bearing bout parsed — a real extraction.
    - "parse-failure":    we expected lines and got none. Either the odds were
                          present in this event's snapshot history and have since
                          vanished (a regression), or the event is close enough
                          that books should already be pricing it (within
                          ODDS_EXPECTED_WITHIN_DAYS).
    - "odds-unavailable": we expected lines and got none, but the Odds API budget
                          was spent so no call was made to produce them. Nothing
                          is broken on our side and it self-heals at the quota
                          reset, so it warns without failing the run.
    - "awaiting-card":    no odds yet, but legitimately so — an upcoming event
                          still far enough out that sportsbooks haven't posted
                          lines, or a past event that simply never carried odds.
                          Not actionable, so it must NOT pollute the error list.

    `today` is a YYYY-MM-DD string; `ev_hist` is this event's snapshot history as
    returned by load_snapshot_history (a list of (at, fights)); `budget_exhausted`
    is odds_budget_exhausted() hoisted out so the classification stays pure.
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
    # (fighters but no odds) makes this an unambiguous odds parse failure —
    # unless we never had the budget to ask, in which case it is the expected,
    # self-healing consequence of the exhausted quota rather than a break.
    if days_out <= ODDS_EXPECTED_WITHIN_DAYS:
        return "odds-unavailable" if budget_exhausted else "parse-failure"

    return "awaiting-card"


def failure_errors(out_events):
    """Error lines for parse-failure events, naming which half actually broke (#66).

    The old single message — "parse failure (expected bouts, got none)" — was
    simply wrong whenever the bouts HAD parsed and only the odds were missing,
    which is the common case. 2026-08-22 Hernandez vs Rodrigues reported it with
    `bout_count: 8` sitting right there in the same payload, and the contradiction
    sent the investigation hunting a bout-parser bug that did not exist: all 8
    bouts had parsed cleanly and every one carried `odds:null`.

    Splitting them means the message names the real gap — a scraper/selector
    problem in the first case, an odds-source or name-matching problem in the
    second. Returns a list of error strings (empty when nothing failed).
    """
    no_bouts = [e["event_id"] for e in out_events
                if e["status"] == "parse-failure" and not e.get("bout_count")]
    no_odds = [e["event_id"] for e in out_events
               if e["status"] == "parse-failure" and e.get("bout_count")]
    out = []
    if no_bouts:
        out.append("parse failure (expected bouts, got none): " + ", ".join(no_bouts))
    if no_odds:
        out.append("odds missing on an announced card (bouts parsed, zero priced): "
                   + ", ".join(no_odds))
    return out


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


def implied_prob(odds):
    """Implied win probability for an American moneyline (#26).

    Mirrors scrape._implied_prob. Duplicated rather than imported on purpose:
    scrape.py pulls in bs4 and requests at import time, and write_status.py runs
    in workflow steps that deliberately don't install them.
    """
    if odds is None:
        return None
    return abs(odds) / (abs(odds) + 100) if odds < 0 else 100 / (odds + 100)


def prob_shift(open_odds, current_odds):
    """Change in implied win probability, in percentage points (#26).

    A move from -110 to -150 and one from +400 to +340 are both '40 points of
    American odds', but the first is a ~7pt probability swing and the second
    ~3pt. Points of moneyline are not a linear measure of what the market
    actually changed its mind about; probability is, which is what makes this
    worth carrying alongside the raw movement.
    """
    a, b = implied_prob(open_odds), implied_prob(current_odds)
    if a is None or b is None:
        return None
    return round((b - a) * 100, 1)


# Weightings for alert priority (#52). Magnitude alone buried a headliner move
# under undercard noise — a 12-point swing on the main event is more actionable
# than a 40-point swing on a prelim nobody is betting.
MAIN_EVENT_WEIGHT = 2.5
# Multiplier by days until the card. A move 2 days out is close to final and
# worth acting on; the same move 3 weeks out will likely be retraced.
IMMINENCE_WEIGHTS = ((2, 2.0), (7, 1.4), (14, 1.1))


def imminence_weight(days_out):
    if days_out is None or days_out < 0:
        return 1.0
    for limit, weight in IMMINENCE_WEIGHTS:
        if days_out <= limit:
            return weight
    return 1.0


def alert_priority(alert, days_out=None):
    """Rank score for a line-movement alert (#52).

    Magnitude scaled by who is fighting and how soon. Kept as an explicit score
    on the payload rather than a sort-order side effect, so the dashboard can
    show *why* an alert is ranked where it is instead of asking the reader to
    trust an opaque ordering.
    """
    score = alert["magnitude"] * imminence_weight(days_out)
    if alert.get("main_event"):
        score *= MAIN_EVENT_WEIGHT
    return round(score, 1)


def load_odds_series(path=SERIES_PATH):
    """The persisted per-bout odds time-series, or {} when it isn't there yet.

    Only the alert calibration reads this, and it degrades to the global default
    on {} — so a missing or corrupt series file must never fail the status run.
    """
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def event_movers(fights, opens, threshold, thresholds=None):
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
        # Points of moneyline mean different things on a headliner and on a
        # prelim, so each bout is judged against its own tier's calibrated bar
        # (#93) — the global threshold is only the fallback.
        tier = calib.bout_tier(i, f.get("lbl", ""))
        bar  = calib.threshold_for(thresholds, tier, threshold)
        if magnitude >= bar:
            opener = opens.get(matchup_key(f))
            mover = {
                "f1": f["f1"], "f2": f["f2"],
                "f1_movement": d["f1_odds"], "f2_movement": d["f2_odds"],
                "magnitude": magnitude,
                "main_event": i == 0,
                "tier": tier,
                "threshold": bar,
                "wc": f.get("wc", ""),
            }
            # How much the market actually changed its mind, in probability
            # points rather than moneyline points (#26).
            if opener:
                aligned = realign(opener, f)
                for side in ("f1", "f2"):
                    shift = prob_shift(aligned[f"{side}_odds"], f[f"{side}_odds"])
                    if shift is not None:
                        mover[f"{side}_prob_shift"] = shift
            movers.append(mover)
    return movers


def alert_key(alert):
    """Stable identity for a line-movement alert, independent of run order."""
    return f"{alert['event_id']}|" + "|".join(sorted((alert["f1"], alert["f2"])))


def new_alerts(alerts, seen, regress_pct=ALERT_REGRESS_PCT):
    """Filter `alerts` down to the ones worth sending again (#67).

    A steam move does not un-happen. Once a line has drifted past the threshold
    it stays past it, so every subsequent run re-detects the same mover and — on
    a card night, at a 5-minute cadence — re-posts it roughly 288 times a day.
    That is how a genuinely useful alert becomes something you mute, which costs
    you the next real one.

    An alert re-fires only when the move has grown materially past what was last
    announced (`regress_pct` beyond the previous magnitude). A line that keeps
    steaming is news again; one merely sitting where it already was is not.

    Returns (to_send, updated_seen) and never mutates `seen`, so a webhook
    failure can leave the state untouched and retry on the next run rather than
    swallowing the alert permanently.
    """
    to_send, updated = [], dict(seen)
    for a in alerts:
        key = alert_key(a)
        prev = seen.get(key)
        magnitude = a["magnitude"]
        if prev is None or magnitude >= prev * (1 + regress_pct):
            to_send.append(a)
            updated[key] = magnitude
        else:
            # Keep the high-water mark so a line drifting back and forth across
            # the threshold can't re-alert on every oscillation.
            updated[key] = max(prev, magnitude)
    return to_send, updated


def load_alert_state():
    """Previously-announced alert magnitudes, keyed by alert_key."""
    if not ALERT_STATE_PATH.exists():
        return {}
    try:
        data = json.loads(ALERT_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}          # corrupt state re-alerts once; it never blocks alerting
    return data.get("sent", {}) if isinstance(data, dict) else {}


def save_alert_state(sent):
    ALERT_STATE_PATH.write_text(
        json.dumps({"updated_at": iso_z(datetime.now(timezone.utc)), "sent": sent},
                   indent=2, sort_keys=True) + "\n",
        encoding="utf-8")


# --- odds budget: exhaustion is an operator event, not a JSON field --------
#
# odds_budget_exhausted has been true and surfaced NOWHERE but the raw status
# file (#76). Nothing pages, nothing renders, and the consequence — a card whose
# lines quietly stop refreshing — looks identical to a quiet market. The flag
# existed; the telling did not.
#
# The quota is monthly, and the API never says when it resets. ODDS_QUOTA_RESET_DAY
# is that day of the month (default 1, the common case); a wrong value costs an
# inaccurate countdown in the banner, never a missed alert, because nothing here
# is gated on it.
ODDS_QUOTA_RESET_DAY = int(os.environ.get("ODDS_QUOTA_RESET_DAY", "1"))
BUDGET_ALERT_KEY = "odds-budget-exhausted"


def days_until_reset(today, reset_day=None):
    """Whole days from `today` to the next monthly quota reset."""
    reset_day = ODDS_QUOTA_RESET_DAY if reset_day is None else reset_day
    day = max(1, min(28, reset_day))       # 28 so every month has the date
    candidate = today.replace(day=day)
    # Strictly earlier, not "<=": on the reset day itself the quota is back NOW,
    # so the countdown is 0. Rolling to next month here made the banner read
    # "resets in 30 days" on the very day the budget refilled.
    if candidate < today:
        month, year = today.month + 1, today.year
        if month > 12:
            month, year = 1, year + 1
        candidate = today.replace(year=year, month=month, day=day)
    return (candidate - today).days


def budget_alert(exhausted, seen, today):
    """(alert or None, updated_seen) for the exhaustion state.

    Fires when the flag first flips, then at most once a day while it stays up,
    and re-arms when the quota recovers. The 5-minute fight-window cadence means
    a naive alert posts ~288 times a day, which is how a real signal becomes one
    you mute — the same reasoning as dedupe_alerts, on a state rather than a
    magnitude.
    """
    updated = dict(seen)
    stamp = today.isoformat()
    if not exhausted:
        updated.pop(BUDGET_ALERT_KEY, None)   # recovery re-arms the alert
        return None, updated
    if updated.get(BUDGET_ALERT_KEY) == stamp:
        return None, updated
    updated[BUDGET_ALERT_KEY] = stamp
    return {
        "kind": "odds_budget_exhausted",
        "message": (
            "Odds API budget exhausted — lines will not refresh until the quota "
            f"resets in {days_until_reset(today)} day(s)."
        ),
    }, updated


def most_affected_events(events, today, limit=5):
    """Upcoming events soonest-first — who loses most from lines going cold.

    An event that has already happened cannot be hurt by a stale line, and one
    three weeks out was not being priced anyway; the card about to happen is the
    one this costs.
    """
    upcoming = []
    for ev in events:
        head = (ev.get("event_id") or "").split(":", 1)[0]
        try:
            date = datetime.strptime(head, "%Y-%m-%d").date()
        except ValueError:
            continue
        if date < today:
            continue
        upcoming.append({
            "event_id": ev.get("event_id"),
            "days_out": (date - today).days,
            "status": ev.get("status"),
        })
    upcoming.sort(key=lambda e: e["days_out"])
    return upcoming[:limit]


def post_alerts(alerts):
    """Best-effort POST of the alerts payload to ALERT_WEBHOOK_URL.

    Never raises: a notification failure must not fail the status run, which is
    also a liveness heartbeat. No-op when the URL is unset or there's nothing to
    send.
    """
    if not ALERT_WEBHOOK_URL or not alerts:
        return False
    body = json.dumps({"alerts": alerts}).encode("utf-8")
    req  = urllib.request.Request(
        ALERT_WEBHOOK_URL, data=body, headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(req, timeout=10)
        print(f"Posted {len(alerts)} line-movement alert(s) to webhook", file=sys.stderr)
        return True
    except Exception as e:
        print(f"Alert webhook failed: {e}", file=sys.stderr)
        return False


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

    # Read once per run, not per event: every event is judged against the same
    # budget state, and re-reading it mid-loop would let a concurrent write split
    # one run's classification across two different answers.
    budget_dead = odds_budget_exhausted()

    # Per-tier alert thresholds, re-derived each run from the committed odds
    # time-series (#93). One global constant let prelim noise flood the feed at
    # the same sensitivity as a main-event steam move.
    calibration = calib.calibrate(load_odds_series(), MOVEMENT_ALERT_THRESHOLD)
    thresholds  = calibration["thresholds"]

    out_events   = []
    stale_events = 0
    alerts       = []
    for ev in events:
        fp       = fingerprint(ev["fights"])
        data_ok  = has_data(ev["fights"]) and fp != EMPTY_SHA
        ev_hist  = history.get(ev["event_id"], [])
        status_  = classify_event(ev, ev_hist, today, budget_dead)
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
            for mover in event_movers(ev["fights"], opens,
                                      MOVEMENT_ALERT_THRESHOLD, thresholds):
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
    unpriced_ids = [e["event_id"] for e in out_events if e["status"] == "odds-unavailable"]
    errors.extend(failure_errors(out_events))

    # Most ACTIONABLE steam first, not merely the loudest (#52). Raw magnitude
    # buried a headliner's move under undercard noise: a 12-point swing on the
    # main event two days out matters more than a 40-point swing on a prelim
    # three weeks away. The score is attached to each alert rather than applied
    # as an invisible sort order, so the ranking can be explained.
    for a in alerts:
        event_date = (a["event_id"].split(":", 1)[0] if ":" in a["event_id"] else None)
        try:
            days = ((datetime.strptime(event_date, "%Y-%m-%d").date()
                     - datetime.now(timezone.utc).date()).days) if event_date else None
        except ValueError:
            days = None
        a["priority"] = alert_priority(a, days)
    alerts.sort(key=lambda a: a["priority"], reverse=True)

    status = {
        "generated_at":             now_iso,
        "events_tracked":           len(out_events),
        "stale_events":             stale_events,
        "parse_failure_events":     len(failure_ids),
        "awaiting_card_events":     len(awaiting_ids),
        # Counted separately from parse failures so the run signal stays clean
        # while the gap is still visible to the overseer and the health issue.
        "odds_unavailable_events":  len(unpriced_ids),
        "odds_budget_exhausted":    budget_dead,
        # The flag alone told nobody anything (#76). This is what a banner needs
        # to say something useful: when the quota comes back, and which cards go
        # cold in the meantime.
        "odds_budget": {
            "exhausted":     budget_dead,
            "reset_day":     ODDS_QUOTA_RESET_DAY,
            "resets_in_days": days_until_reset(now.date()),
            "most_affected": most_affected_events(out_events, now.date()) if budget_dead else [],
        },
        "stale_threshold_hours":    STALE_THRESHOLD_HOURS,
        "movement_alert_threshold": MOVEMENT_ALERT_THRESHOLD,
        # What each tier is actually judged by, and the evidence behind it (#93).
        "movement_alert_thresholds": thresholds,
        "movement_alert_calibration": calibration["tiers"],
        "events":                   out_events,
        "alerts":                   alerts,
        "errors":                   errors,
    }
    STATUS_PATH.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")

    # Optional push: notify a webhook when steam moves appear. Best-effort, and
    # deduped so a standing mover isn't re-announced on every 5-minute run (#67).
    # State advances only on a successful post, so a webhook outage retries next
    # run instead of silently swallowing the alert.
    fresh, updated_seen = new_alerts(alerts, load_alert_state())
    # Exhaustion rides the same channel but not the same dedup: it is a state,
    # not a move, so it fires on the flip and then once a day until it clears
    # rather than being compared against a magnitude it does not have.
    budget_msg, updated_seen = budget_alert(budget_dead, updated_seen, now.date())
    if budget_msg:
        fresh = fresh + [budget_msg]
    if not ALERT_WEBHOOK_URL:
        pass                       # nothing configured: don't burn the dedup state
    elif not fresh:
        if alerts:
            print(f"Suppressed {len(alerts)} already-announced alert(s)", file=sys.stderr)
    elif post_alerts(fresh):
        save_alert_state(updated_seen)

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
