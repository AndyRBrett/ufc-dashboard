#!/usr/bin/env python3
"""
Data-quality gate for data.js.

The scraper is built to degrade gracefully: every source has a fallback, so a
failed Wikipedia parse keeps the old card, a failed UFCStats lookup keeps the old
record, and an empty odds payload keeps the old lines. That keeps the site up,
but it also means a broken pull and a good pull produce the same exit code — the
commit lands either way and nobody finds out until someone opens the app and
sees a withdrawn fighter or a blank record on tonight's card.

This module is the missing half: it reads the built data.js and reports what is
actually wrong with it, weighted by how close the affected card is.

Two severities, and the split matters:

  BLOCK  Structural breakage — data.js unparseable, EVENTS empty, or the next
         card losing bouts it already had. Publishing this is strictly worse
         than keeping what is already live, so the gate fails and the workflow
         stops before committing.

  WARN   Data gaps — a blank record, a missing line, a TBD fighter. These are
         reported and alerted on but never block, because during a live card a
         blocked commit also blocks the results everyone is watching. A gap is
         worth waking someone up for; it is not worth freezing the card.

Usage:
    python health.py                 # report to stdout + health-report.json
    python health.py --gate          # same, but exit 1 on any BLOCK finding
    python health.py --baseline FILE # compare against a previous data.js
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DATA_PATH   = Path("data.js")
REPORT_PATH = Path("health-report.json")
# Pre-rendered markdown so CI never has to format findings inline — embedding a
# formatter in a workflow's shell block is how you break the YAML.
REPORT_MD_PATH = Path("health-report.md")

# A card this close is one users are actively picking — gaps on it are alertable.
IMMINENT_DAYS = 7
# Inside this window a TBD fighter or a missing card is no longer "not announced
# yet", it is broken.
CRITICAL_DAYS = 2
# Odds coverage is judged over a WIDER window than the other data gaps (#66).
#
# This used to reuse IMMINENT_DAYS, which left a silent 7-to-14-day blind spot:
# write_status.classify_event flags an unpriced announced card as "parse-failure"
# from 14 days out, but health.py stopped looking at 7 — so an event in that band
# was written into overseer-status.json's `errors` while health.py produced no
# finding at all. No WARN, no tracking issue, green run. That is exactly how
# 2026-08-22 Hernandez vs Rodrigues (9 days out, 8 announced bouts, zero odds)
# stayed invisible behind a 100% run success rate. Keep this in step with
# write_status.ODDS_EXPECTED_WITHIN_DAYS — the env var is shared on purpose.
ODDS_EXPECTED_WITHIN_DAYS = int(os.environ.get("ODDS_EXPECTED_WITHIN_DAYS", "14"))
# Odds older than this on an imminent card mean the odds pipeline has stalled.
ODDS_STALE_HOURS = 36
# Below this the Odds API quota is about to run out and lines will silently freeze.
ODDS_QUOTA_WARN = 50
# An age no fighter on a UFC card has. The oldest to compete in the modern UFC is
# in his late 40s, so this only fires on a profile that belongs to somebody else.
PROFILE_MAX_AGE = 44

EVENT_RE = re.compile(r'name:"([^"]+)",\s*\n\s*date:"(\d{4}-\d{2}-\d{2})"')
# The clock fields, read per-event segment. Optional by design: an event that
# predates them, or one written without a prelim slot, must still parse.
LOC_RE        = re.compile(r'\n\s*loc:"([^"]*)"')
TIME_RE       = re.compile(r'\n\s*time:"([^"]*)"')
PRELIM_TIME_RE = re.compile(r'\n\s*prelimTime:"([^"]*)"')
# One serialised bout, as written by events_js.
FIGHT_RE = re.compile(
    r'\{lbl:"(?P<lbl>[^"]*)",wc:"(?P<wc>[^"]*)".*?'
    r'odds:(?P<odds>\{f1:-?\d+,f2:-?\d+\}|null),'
    r'winner:"(?P<winner>[^"]*)".*?'
    r'f1:\{n:"(?P<f1>[^"]*)",r:"(?P<f1r>[^"]*)".*?'
    r'f2:\{n:"(?P<f2>[^"]*)",r:"(?P<f2r>[^"]*)"'
)


def parse_data(text):
    """Slice data.js into [{name, date, fights:[...]}], scoped to the EVENTS block.

    Scoped deliberately: RESULTS_ARCHIVE holds the same shapes and would
    otherwise be counted as live cards.
    """
    i = text.find("var EVENTS=")
    if i == -1:
        return []
    block = text[i:]
    heads = list(EVENT_RE.finditer(block))
    events = []
    for n, m in enumerate(heads):
        end = heads[n + 1].start() if n + 1 < len(heads) else len(block)
        seg = block[m.start():end]
        fights = [
            {
                "lbl": g["lbl"], "wc": g["wc"],
                "odds": None if g["odds"] == "null" else g["odds"],
                "winner": g["winner"],
                "f1": g["f1"], "f1r": g["f1r"],
                "f2": g["f2"], "f2r": g["f2r"],
            }
            for g in (mm.groupdict() for mm in FIGHT_RE.finditer(seg))
        ]
        def field(rx):
            mm = rx.search(seg)
            return mm.group(1) if mm else ""

        events.append({
            "name": m.group(1), "date": m.group(2), "fights": fights,
            "loc": field(LOC_RE),
            "time": field(TIME_RE),
            "prelimTime": field(PRELIM_TIME_RE),
        })
    return events


def parse_stats_cache(text):
    m = re.search(r"var FIGHTER_STATS=(\{.*?\});", text, re.DOTALL)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}


def parse_rankings(text):
    m = re.search(r"var RANKINGS=(\{.*?\});", text, re.DOTALL)
    if not m:
        return {}
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}


def profile_age(dob, today):
    """Age in years from a UFCStats DOB ("Oct 08, 1977"), or None if unreadable."""
    try:
        born = datetime.strptime(dob, "%b %d, %Y").date()
    except (TypeError, ValueError):
        return None
    return (today - born).days / 365.25


def profile_mismatch(name, st, rank, today):
    """Why this cached profile looks like a DIFFERENT fighter, or "".

    UFCStats files several fighters under the same name, and the scraper has to
    pick one. When it picks wrong nothing errors: the card shows a plausible
    record, the stats modal shows plausible numbers, and they belong to somebody
    else. Petr Yan sat on a live card as 11-13-0 born 1980, and Jean Silva as a
    48-year-old with one UFC bout — both ranked, both fighting that month.

    So test the profile against what we independently know about the fighter,
    and keep the tests to ones a real roster member cannot fail:

      * nobody on an upcoming UFC card is over PROFILE_MAX_AGE;
      * a fighter the UFC ranks in their own division has, by definition, fought
        in the UFC — a ranked profile with no UFC opponents is not him.

    Debutants and unpriced regional signings legitimately have no UFC history,
    which is why the second test needs the ranking: it is the part they can't
    have. Empty profiles are left to stats-missing/stats-fetch-failed.
    """
    if not st or not (_has_fight_data(st) or st.get("rec")):
        return ""
    age = profile_age(st.get("dob", ""), today)
    if age is not None and age >= PROFILE_MAX_AGE:
        return (f"profile is {age:.0f} years old (DOB {st.get('dob')}) — no active "
                f"fighter is; this is probably a different {name}")
    if rank and len(st.get("opp") or []) <= 1:
        return (f"ranked #{rank} but the profile lists "
                f"{len(st.get('opp') or [])} UFC opponent(s) — a ranked fighter "
                f"has a UFC record, so this is probably a different {name}")
    return ""


def days_out(date_str, today):
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d").date()
    except ValueError:
        return None
    return (d - today).days


_REGION_FN = "unset"


def _region_of(loc):
    """Slot family for *loc* via scrape.classify_region: "us", a region label,
    or "" when the venue is anchored to nothing.

    Returns None — which every caller treats as "no opinion" — when scrape.py
    cannot be imported. health.py is otherwise dependency-free and is run
    standalone in places scrape's third-party deps aren't installed; a missing
    import must degrade this one check, not crash the whole gate.
    """
    global _REGION_FN
    if _REGION_FN == "unset":
        try:
            from scrape import classify_region
            _REGION_FN = classify_region
        except Exception:
            _REGION_FN = None
    if _REGION_FN is None:
        return None
    try:
        return _REGION_FN(loc)
    except Exception:
        return None


def _has_fight_data(st):
    """Mirror of the app's noFightData(): a debutant's zeros are not measurements."""
    if not st:
        return False
    if st.get("form"):
        return True
    return any(float(st.get(k) or 0) for k in ("slpm", "acc", "td", "tdd"))


def check(text, baseline_text=None, now=None, odds_state=None):
    """Run every check. Returns (findings, summary)."""
    now      = now or datetime.now(timezone.utc)
    today    = now.date()
    findings = []

    def add(sev, kind, msg, **extra):
        findings.append({"severity": sev, "check": kind, "message": msg, **extra})

    # --- structural -------------------------------------------------------
    if not text or len(text) < 20000:
        add("BLOCK", "data-size",
            f"data.js is {len(text)} bytes — far below the ~20KB floor a real build produces")
        return findings, _summarise(findings, 0)

    events = parse_data(text)
    if not events:
        add("BLOCK", "events-empty", "data.js parsed to zero events")
        return findings, _summarise(findings, 0)

    # `days_out(...) or -1` would be wrong here: a card happening TODAY is 0 days
    # out, 0 is falsy, and the gate would go blind on the one day it matters most.
    upcoming = []
    for e in events:
        d = days_out(e["date"], today)
        if d is not None and d >= 0:
            upcoming.append(e)
    if not upcoming:
        add("BLOCK", "no-upcoming", "data.js lists no future event")

    # Card regression against the currently-published data.js.
    base = {}
    if baseline_text:
        base = {(e["name"], e["date"]): e for e in parse_data(baseline_text)}
        for ev in upcoming:
            prev = base.get((ev["name"], ev["date"]))
            if prev and len(ev["fights"]) < len(prev["fights"]):
                add("BLOCK", "card-regression",
                    f"{ev['name']} dropped from {len(prev['fights'])} bouts to "
                    f"{len(ev['fights'])} — refusing to publish a shrunken card",
                    event=ev["name"], date=ev["date"])

    # --- start times ------------------------------------------------------
    #
    # The clock had no gate at all until UFC 331 shipped four hours early and
    # Paris three hours early on the same weekend. Both were silent: every other
    # check was green because the bouts, odds and records were all fine. These
    # are WARN, never BLOCK — a wrong time is bad, but refusing to publish
    # during a card also blocks the live results everyone is watching.
    for ev in upcoming:
        d = days_out(ev["date"], today)
        label = f"{ev['name']} ({d}d out)"

        if not ev["time"] or ev["time"] == "TBD":
            if d is not None and d <= IMMINENT_DAYS:
                add("WARN", "start-time-missing",
                    f"{label}: no main-card start time — the card shows TBD to users",
                    event=ev["name"], date=ev["date"])
        elif _region_of(ev["loc"]) == "":
            # No slot anchors this venue, so nothing cross-checks whatever ESPN
            # returned. This is the UFC 331 hole: a host city missing from
            # _US_REGIONS is invisible until someone reads the clock by hand.
            add("WARN", "start-time-unanchored",
                f"{label}: venue {ev['loc']!r} matches no known region, so its "
                f"{ev['time']} ET start is unverified — add it to _US_REGIONS "
                f"or _INTL_REGION_SLOTS",
                event=ev["name"], date=ev["date"])

        # A start time that MOVED between runs is either a real reschedule or
        # the scraper changing its mind; both are worth a human look, and a
        # silent shift is exactly how the wrong clock reached users.
        if baseline_text:
            prev = base.get((ev["name"], ev["date"]))
            if prev and prev.get("time") and ev["time"] != prev["time"]:
                add("WARN", "start-time-changed",
                    f"{label}: main-card start moved {prev['time']} → {ev['time']} ET",
                    event=ev["name"], date=ev["date"])
            if prev and prev.get("prelimTime") and ev["prelimTime"] != prev["prelimTime"]:
                add("WARN", "start-time-changed",
                    f"{label}: prelim start moved {prev['prelimTime']} → "
                    f"{ev['prelimTime']} ET",
                    event=ev["name"], date=ev["date"])

    # --- odds coverage, over the wider odds-expected window (#66) ----------
    # Separate from the imminent-card loop below because odds are expected to
    # exist well before the other gaps become alertable. Books price a card
    # roughly two weeks out, so an announced card still carrying no lines inside
    # that window is a real gap — and it must be reported at 9 days out, not
    # first noticed at 7.
    for ev in upcoming:
        d = days_out(ev["date"], today)
        if d is None or d > ODDS_EXPECTED_WITHIN_DAYS or not ev["fights"]:
            continue
        tag = {"event": ev["name"], "date": ev["date"], "days_out": d}
        priced = sum(1 for f in ev["fights"] if f["odds"])
        if priced == 0:
            add("WARN", "odds-missing-all",
                f"{ev['name']} ({d}d out) has no odds on any of its "
                f"{len(ev['fights'])} bouts", **tag)
        elif priced < len(ev["fights"]):
            add("WARN", "odds-missing-some",
                f"{ev['name']} ({d}d out): {len(ev['fights']) - priced} of "
                f"{len(ev['fights'])} bouts have no odds", **tag)

    # --- data gaps on imminent cards --------------------------------------
    stats = parse_stats_cache(text)
    for ev in upcoming:
        d = days_out(ev["date"], today)
        if d is None or d > IMMINENT_DAYS:
            continue
        tag = {"event": ev["name"], "date": ev["date"], "days_out": d}
        if not ev["fights"]:
            add("BLOCK", "card-empty",
                f"{ev['name']} is {d}d out with zero bouts parsed", **tag)
            continue

        for f in ev["fights"]:
            for side in ("f1", "f2"):
                name, rec = f[side], f[side + "r"]
                if not name or name == "TBD":
                    sev = "BLOCK" if d <= CRITICAL_DAYS else "WARN"
                    add(sev, "fighter-tbd",
                        f"{ev['name']} ({d}d out): {f['lbl']} still has a TBD fighter",
                        **tag)
                    continue
                if not rec:
                    add("WARN", "record-blank",
                        f"{ev['name']} ({d}d out): {name} has no record", fighter=name, **tag)
                st = stats.get(name)
                if st is None:
                    add("WARN", "stats-missing",
                        f"{ev['name']} ({d}d out): {name} has no stats entry",
                        fighter=name, **tag)
                elif st.get("fetch_failed") and not st.get("rec"):
                    add("WARN", "stats-fetch-failed",
                        f"{ev['name']} ({d}d out): {name} stats lookup failed "
                        f"({st['fetch_failed'][:10]})", fighter=name, **tag)

    # --- cached profiles that belong to somebody else ----------------------
    # Not restricted to imminent cards, and not a gap check: a wrong profile is
    # wrong the day it is cached, it shows the user a confident false record, and
    # it feeds the fight model. Catching it early is the whole point.
    rankings = parse_rankings(text)
    seen_fighters = set()
    for ev in upcoming:
        d = days_out(ev["date"], today)
        for f in ev["fights"]:
            for side in ("f1", "f2"):
                name = f[side]
                if not name or name == "TBD" or name in seen_fighters:
                    continue
                seen_fighters.add(name)
                why = profile_mismatch(name, stats.get(name), rankings.get(name), today)
                if why:
                    add("WARN", "profile-mismatch",
                        f"{ev['name']} ({d}d out): {name} — {why}",
                        fighter=name, event=ev["name"], date=ev["date"], days_out=d)

    # --- odds pipeline health ---------------------------------------------
    if odds_state:
        last = odds_state.get("last_fetch_at")
        soonest = min((days_out(e["date"], today) for e in upcoming), default=None)
        if last and soonest is not None and soonest <= IMMINENT_DAYS:
            try:
                age_h = (now - datetime.fromisoformat(last)).total_seconds() / 3600
                if age_h > ODDS_STALE_HOURS:
                    add("WARN", "odds-stale",
                        f"last Odds API pull was {age_h:.0f}h ago with a card "
                        f"{soonest}d out")
            except ValueError:
                pass
        status = odds_state.get("last_status")
        if status is not None and status != 200:
            add("WARN", "odds-api-error",
                f"last Odds API call returned HTTP {status} — lines are frozen "
                f"at their previous values")
        rem = odds_state.get("requests_remaining")
        if rem is not None and rem <= ODDS_QUOTA_WARN:
            # WARN, never BLOCK. An exhausted quota is an ops problem, not a
            # reason to withhold the build: the data being published is not made
            # worse by it — it still carries fresh results — and blocking mid-card
            # stops those results reaching anyone. This shipped as a BLOCK and
            # promptly froze the live card's results, which is precisely the
            # failure the severity split exists to prevent.
            tail = ("lines are frozen until the quota resets" if rem <= 0
                    else "lines will freeze silently when it hits zero")
            add("WARN", "odds-quota",
                f"Odds API quota down to {rem} requests — {tail}")

    return findings, _summarise(findings, len(events))


def _summarise(findings, n_events):
    return {
        "events": n_events,
        "block": sum(1 for f in findings if f["severity"] == "BLOCK"),
        "warn": sum(1 for f in findings if f["severity"] == "WARN"),
    }


def render(findings, summary):
    """Human-readable report — also used as the GitHub Actions job summary."""
    if not findings:
        return f"✅ data health OK — {summary['events']} events, no findings.\n"
    lines = [
        f"### Data health: {summary['block']} blocking, {summary['warn']} warning "
        f"({summary['events']} events)\n"
    ]
    for sev in ("BLOCK", "WARN"):
        rows = [f for f in findings if f["severity"] == sev]
        if not rows:
            continue
        lines.append(f"\n**{sev}** ({len(rows)})\n")
        for f in rows:
            lines.append(f"- `{f['check']}` — {f['message']}")
    return "\n".join(lines) + "\n"


def render_issue(findings):
    """Body for the tracking issue — rewritten in place on every run."""
    run = os.environ.get("GITHUB_RUN_ID")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    out = ["Automated report from the `update` workflow — rewritten on every run.", ""]
    link = f" · [run log]({server}/{repo}/actions/runs/{run})" if run else ""
    out.append(f"Last run: {stamp}{link}")
    out.append("")
    if not findings:
        out.append("No findings.")
    for f in findings:
        out.append(f"- **{f['severity']}** `{f['check']}` — {f['message']}")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gate", action="store_true",
                    help="exit 1 when a BLOCK finding is present")
    ap.add_argument("--baseline", help="previous data.js to diff card sizes against")
    ap.add_argument("--data", default=str(DATA_PATH))
    args = ap.parse_args()

    text = Path(args.data).read_text(encoding="utf-8") if Path(args.data).exists() else ""
    baseline = None
    if args.baseline and Path(args.baseline).exists():
        baseline = Path(args.baseline).read_text(encoding="utf-8")

    odds_state = {}
    p = Path("odds-state.json")
    if p.exists():
        try:
            odds_state = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass

    findings, summary = check(text, baseline, odds_state=odds_state)
    report = render(findings, summary)
    print(report)

    REPORT_PATH.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": summary,
        "findings": findings,
    }, indent=2) + "\n", encoding="utf-8")
    REPORT_MD_PATH.write_text(render_issue(findings), encoding="utf-8")

    # Surface it in the Actions run without anyone opening logs.
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as fh:
            fh.write(report)

    if args.gate and summary["block"]:
        print(f"health: {summary['block']} blocking finding(s) — refusing to publish.",
              file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
