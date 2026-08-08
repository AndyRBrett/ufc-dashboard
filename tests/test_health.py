"""
Unit tests for the data-quality gate (health.py).

The gate is the thing standing between a degraded scrape and a published card,
so its severity split is the part that matters most: structural breakage must
BLOCK the commit, and data gaps must only WARN. Getting that backwards either
publishes a broken card or freezes results mid-event.

Run with:  python -m pytest -q
"""
from datetime import datetime, timezone

import health

NOW = datetime(2026, 8, 7, 12, 0, tzinfo=timezone.utc)
PAD = "// pad\n" * 3000          # keep fixtures above the 20KB size floor


def fight(f1, f2, *, f1r="10-0-0", f2r="9-1-0", odds='{f1:-150,f2:130}',
          lbl="Prelim", winner=""):
    return (f'{{lbl:"{lbl}",wc:"Lightweight",title:false,rematch:false,'
            f'odds:{odds},winner:"{winner}",method:"",round:null,state:"pre",'
            f'f1:{{n:"{f1}",r:"{f1r}",rk:"",s:null}},'
            f'f2:{{n:"{f2}",r:"{f2r}",rk:"",s:null}}}}')


def data_js(events, stats="{}"):
    """Build a data.js whose shape matches what events_js actually serialises."""
    blocks = []
    for name, date, fights in events:
        blocks.append(
            f'  {{\n    name:"{name}",\n    date:"{date}",\n'
            f'    venue:"Apex",\n    loc:"Las Vegas",\n'
            f'    fights:[\n      ' + ",\n      ".join(fights) + "\n    ]\n  }"
        )
    return (f"var FIGHTER_STATS={stats};\n"
            "var EVENTS=[\n" + ",\n".join(blocks) + "\n];\n" + PAD)


def kinds(findings, severity=None):
    return {f["check"] for f in findings
            if severity is None or f["severity"] == severity}


# --- structural breakage must BLOCK ---------------------------------------

def test_truncated_data_blocks():
    findings, summary = health.check("var EVENTS=[];", now=NOW)
    assert summary["block"] == 1
    assert "data-size" in kinds(findings, "BLOCK")


def test_zero_events_blocks():
    findings, summary = health.check("var EVENTS=[];\n" + PAD, now=NOW)
    assert summary["block"] >= 1
    assert "events-empty" in kinds(findings, "BLOCK")


def test_card_shrinking_blocks():
    # The single most dangerous silent failure: a partial Wikipedia parse
    # replacing a full card with a stub. Never publish that over what's live.
    before = data_js([("UFC Fight Night: A vs. B", "2026-08-08",
                       [fight("A", "B"), fight("C", "D"), fight("E", "F")])])
    after = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])])
    findings, summary = health.check(after, baseline_text=before, now=NOW)
    assert "card-regression" in kinds(findings, "BLOCK")
    assert summary["block"] >= 1


def test_card_growing_is_fine():
    before = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])])
    after = data_js([("UFC Fight Night: A vs. B", "2026-08-08",
                      [fight("A", "B"), fight("C", "D")])])
    findings, _ = health.check(after, baseline_text=before, now=NOW)
    assert "card-regression" not in kinds(findings)


def test_empty_imminent_card_blocks():
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])])
    # Strip the only bout, leaving the event header — a zero-bout parse.
    text = text.replace(fight("A", "B"), "")
    findings, _ = health.check(text, now=NOW)
    assert "card-empty" in kinds(findings, "BLOCK")


# --- data gaps must WARN, never block -------------------------------------

def test_blank_record_on_imminent_card_warns_only():
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08",
                     [fight("A", "B", f1r="")])])
    findings, summary = health.check(text, now=NOW)
    assert "record-blank" in kinds(findings, "WARN")
    # Must not block: a blocked commit during a card also blocks live results.
    assert summary["block"] == 0


def test_missing_odds_warns_only():
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08",
                     [fight("A", "B", odds="null")])])
    findings, summary = health.check(text, now=NOW)
    assert "odds-missing-all" in kinds(findings, "WARN")
    assert summary["block"] == 0


def test_partial_odds_reported_separately():
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08",
                     [fight("A", "B"), fight("C", "D", odds="null")])])
    findings, _ = health.check(text, now=NOW)
    assert "odds-missing-some" in kinds(findings, "WARN")


def test_failed_stats_lookup_warns():
    stats = '{"A":{"fetch_failed":"2026-08-06T11:00:00+00:00"}}'
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])],
                   stats=stats)
    findings, _ = health.check(text, now=NOW)
    assert "stats-fetch-failed" in kinds(findings, "WARN")


def test_missing_stats_entry_warns():
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])])
    findings, _ = health.check(text, now=NOW)
    assert "stats-missing" in kinds(findings, "WARN")


# --- proximity weighting ---------------------------------------------------

def test_distant_card_gaps_are_not_reported():
    # A card 8 weeks out legitimately has no odds and half its records missing;
    # alerting on it is the noise that makes people stop reading alerts.
    text = data_js([("UFC 340: Someone vs. Someone", "2026-11-01",
                     [fight("A", "B", f1r="", odds="null")])])
    findings, summary = health.check(text, now=NOW)
    assert summary["warn"] == 0
    assert summary["block"] == 0


def test_tbd_fighter_blocks_only_inside_the_critical_window():
    near = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "TBD")])])
    far = data_js([("UFC Fight Night: A vs. B", "2026-08-13", [fight("A", "TBD")])])
    assert "fighter-tbd" in kinds(health.check(near, now=NOW)[0], "BLOCK")
    assert "fighter-tbd" in kinds(health.check(far, now=NOW)[0], "WARN")


# --- odds pipeline health --------------------------------------------------

def test_exhausted_odds_quota_blocks():
    # This is the failure that froze the Aug 8 card's lines for six days.
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])])
    findings, _ = health.check(text, now=NOW, odds_state={"requests_remaining": 0})
    assert "odds-quota" in kinds(findings, "BLOCK")


def test_low_odds_quota_warns():
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])])
    findings, _ = health.check(text, now=NOW, odds_state={"requests_remaining": 20})
    assert "odds-quota" in kinds(findings, "WARN")


def test_non_200_odds_response_warns():
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])])
    findings, _ = health.check(text, now=NOW, odds_state={"last_status": 401})
    assert "odds-api-error" in kinds(findings, "WARN")


def test_stale_odds_pull_warns_when_a_card_is_close():
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])])
    findings, _ = health.check(
        text, now=NOW, odds_state={"last_fetch_at": "2026-08-01T00:00:00+00:00"})
    assert "odds-stale" in kinds(findings, "WARN")


def test_healthy_card_produces_no_findings():
    stats = ('{"A":{"rec":"10-0-0","form":[{"r":"W","m":"KO"}],"slpm":3.1},'
             '"B":{"rec":"9-1-0","form":[{"r":"L","m":"Dec"}],"slpm":2.4}}')
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])],
                   stats=stats)
    findings, summary = health.check(text, now=NOW)
    assert findings == []
    assert summary == {"events": 1, "block": 0, "warn": 0}


def test_card_happening_today_is_still_checked():
    # 0 days out is falsy. An `or -1` fallback in the upcoming filter made the
    # gate skip the card on the day it runs — blind exactly when it matters.
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-07",
                     [fight("A", "B", f1r="", odds="null")])])
    findings, summary = health.check(text, now=NOW)
    assert summary["warn"] > 0
    assert "record-blank" in kinds(findings, "WARN")


def test_yesterdays_card_is_not_checked():
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-06",
                     [fight("A", "B", f1r="", odds="null")])])
    findings, summary = health.check(text, now=NOW)
    assert summary["warn"] == 0
