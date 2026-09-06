"""
Unit tests for the data-quality gate (health.py).

The gate is the thing standing between a degraded scrape and a published card,
so its severity split is the part that matters most: structural breakage must
BLOCK the commit, and data gaps must only WARN. Getting that backwards either
publishes a broken card or freezes results mid-event.

Run with:  python -m pytest -q
"""
import json
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


def data_js(events, stats="{}", loc="Las Vegas", time="20:00", prelim="17:00",
            rankings="{}"):
    """Build a data.js whose shape matches what events_js actually serialises.

    time/prelimTime are written by default because events_js always writes them
    — a fixture without them is not a "healthy" card, it is one whose clock is
    missing, which health.check now (correctly) reports.
    """
    blocks = []
    for name, date, fights in events:
        blocks.append(
            f'  {{\n    name:"{name}",\n    date:"{date}",\n'
            f'    venue:"Apex",\n    loc:"{loc}",\n'
            f'    tv:"Paramount+",\n    time:"{time}",\n    prelimTime:"{prelim}",\n'
            f'    fights:[\n      ' + ",\n      ".join(fights) + "\n    ]\n  }"
        )
    return (f"var RANKINGS={rankings};\n"
            f"var FIGHTER_STATS={stats};\n"
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


# --- the 7-to-14-day odds blind spot (#66) --------------------------------

def test_unpriced_card_beyond_imminent_window_still_warns():
    # THE REGRESSION TEST for #66. Reproduces 2026-08-22 Hernandez vs Rodrigues:
    # an announced card 9 days out with every bout unpriced. write_status flags
    # it "parse-failure" from 14 days out, but health.py used to stop looking at
    # IMMINENT_DAYS (7), so this event produced no finding whatsoever and the run
    # stayed green while overseer-status.json recorded an error nobody saw.
    nine_days_out = "2026-08-16"          # NOW is 2026-08-07
    text = data_js([("UFC Fight Night: Hernandez vs. Rodrigues", nine_days_out,
                     [fight("Anthony Hernandez", "Gregory Rodrigues", odds="null"),
                      fight("Serghei Spivac", "Vitor Petrino", odds="null")])])
    findings, summary = health.check(text, now=NOW)
    assert "odds-missing-all" in kinds(findings, "WARN"), \
        "an unpriced card inside the odds-expected window must be reported"
    # Still only a warning: a card with no lines is worth shipping for its
    # fighters, records and results. It must not freeze the publish.
    assert summary["block"] == 0


def test_unpriced_card_beyond_odds_window_is_silent():
    # The other side of the boundary: a card 30 days out has legitimately not
    # been priced yet. Warning on it would be noise on every run.
    findings, _ = health.check(
        data_js([("UFC Fight Night: C vs. D", "2026-09-06",
                  [fight("C", "D", odds="null")])]), now=NOW)
    assert "odds-missing-all" not in kinds(findings, "WARN")


def test_odds_window_is_wider_than_imminent_window():
    # Guards the invariant the fix depends on. If someone narrows the odds window
    # back to IMMINENT_DAYS, the blind spot silently reopens.
    assert health.ODDS_EXPECTED_WITHIN_DAYS > health.IMMINENT_DAYS


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

def test_exhausted_odds_quota_warns_but_never_blocks():
    # Shipped as a BLOCK and immediately froze the live card: the quota was
    # already at 0, so the gate refused to publish a build that carried fresh
    # fight results. An exhausted quota does not make the data worse — nothing
    # about it justifies withholding the build.
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])])
    findings, summary = health.check(text, now=NOW,
                                     odds_state={"requests_remaining": 0})
    assert "odds-quota" in kinds(findings, "WARN")
    assert summary["block"] == 0


def test_nothing_about_the_odds_pipeline_can_block_a_publish():
    # Belt and braces over the whole odds-state surface: every one of these is an
    # upstream/ops condition, and none of them is a reason to stop publishing.
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])])
    for state in ({"requests_remaining": 0},
                  {"requests_remaining": -5},
                  {"last_status": 401},
                  {"last_status": 429},
                  {"last_fetch_at": "2026-07-01T00:00:00+00:00"}):
        _, summary = health.check(text, now=NOW, odds_state=state)
        assert summary["block"] == 0, f"odds_state {state} must not block"


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


# --- the clock ------------------------------------------------------------
#
# There was no gate on start times at all until UFC 331 shipped 4h early and
# Paris 3h early on the same weekend. Both were invisible: bouts, odds and
# records were all healthy, so every existing check was green.

def test_missing_start_time_on_imminent_card_warns_only():
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])],
                   time="TBD", prelim="TBD")
    findings, summary = health.check(text, now=NOW)
    assert "start-time-missing" in kinds(findings, "WARN")
    # Never blocks — a wrong clock must not freeze live results mid-card.
    assert summary["block"] == 0


def test_missing_start_time_on_a_distant_card_is_silent():
    # A card 12 weeks out has legitimately not been scheduled to the hour yet.
    text = data_js([("UFC 340: A vs. B", "2026-11-01", [fight("A", "B")])],
                   time="TBD", prelim="TBD")
    findings, _ = health.check(text, now=NOW)
    assert "start-time-missing" not in kinds(findings)


def test_unanchored_venue_warns_that_the_time_is_unverified():
    """The UFC 331 hole: a host city in no region has nothing cross-checking
    whatever ESPN returned, and stayed silent until read by hand."""
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])],
                   loc="Atlantis")
    findings, summary = health.check(text, now=NOW)
    assert "start-time-unanchored" in kinds(findings, "WARN")
    assert summary["block"] == 0


def test_known_venue_does_not_warn_as_unanchored():
    for loc in ("Las Vegas", "Los Angeles", "Paris", "Abu Dhabi"):
        findings, _ = health.check(
            data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])],
                    loc=loc), now=NOW)
        assert "start-time-unanchored" not in kinds(findings), loc


def test_start_time_change_against_the_baseline_warns():
    before = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])],
                     time="20:00", prelim="17:00")
    after = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])],
                    time="15:00", prelim="12:00")
    findings, summary = health.check(after, baseline_text=before, now=NOW)
    msgs = [f["message"] for f in findings if f["check"] == "start-time-changed"]
    assert any("20:00 → 15:00" in m for m in msgs), msgs
    assert any("17:00 → 12:00" in m for m in msgs), msgs
    assert summary["block"] == 0


def test_unchanged_start_time_is_silent():
    text = data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])])
    findings, _ = health.check(text, baseline_text=text, now=NOW)
    assert "start-time-changed" not in kinds(findings)


def test_region_lookup_degrades_to_no_opinion_without_scrape(monkeypatch):
    """health.py is otherwise dependency-free; an unimportable scrape must
    disable this one check rather than crash the gate."""
    monkeypatch.setattr(health, "_REGION_FN", None)
    findings, summary = health.check(
        data_js([("UFC Fight Night: A vs. B", "2026-08-08", [fight("A", "B")])],
                loc="Atlantis"), now=NOW)
    assert "start-time-unanchored" not in kinds(findings)
    assert summary["block"] == 0


# --- a cached profile that belongs to somebody else ------------------------
#
# UFCStats files several fighters under one name. When the scraper picks the
# wrong one nothing errors: the card shows a plausible record, the stats modal
# shows plausible numbers, and they are another man's. Petr Yan sat on a live
# card as 11-13-0 born 1980, and Jean Silva as a 48-year-old with one UFC bout —
# both ranked, both fighting that month, both feeding the fight model.
#
# These tests pin the two tells a real roster member cannot produce, and — just
# as importantly — the legitimate profiles that must NOT be flagged, since a
# noisy check is one nobody reads.

TODAY = NOW.date()


def profile(**over):
    base = {"slpm": 4.0, "acc": 50, "td": 1.0, "tdd": 60, "ko": 5, "sub": 2,
            "rec": "15-2-0", "dob": "Jan 01, 1996",
            "form": [{"r": "W", "m": "Dec"}], "opp": ["A Fighter", "B Fighter"]}
    base.update(over)
    return base


def test_a_profile_too_old_to_be_fighting_is_flagged():
    why = health.profile_mismatch(
        "Jean Silva", profile(dob="Oct 08, 1977", rec="19-12-3", opp=["Takanori Gomi"]),
        6, TODAY)
    assert "different Jean Silva" in why and "49 years old" in why


def test_a_ranked_fighter_with_no_ufc_history_is_flagged():
    why = health.profile_mismatch(
        "Petr Yan", profile(rec="11-13-0", opp=[], dob="Jan 01, 1996"), 3, TODAY)
    assert "ranked #3" in why and "0 UFC opponent" in why


def test_a_real_ranked_fighter_is_not_flagged():
    assert health.profile_mismatch("Real Contender", profile(), 3, TODAY) == ""


def test_a_debutant_with_no_ufc_record_is_not_flagged():
    # The whole reason the second tell needs the ranking: an unranked signing
    # legitimately has no UFC opponents.
    assert health.profile_mismatch("New Signing", profile(opp=[]), None, TODAY) == ""


def test_a_veteran_still_inside_the_age_bound_is_not_flagged():
    assert health.profile_mismatch(
        "Old Hand", profile(dob="Jan 01, 1985"), 8, TODAY) == ""


def test_an_empty_or_failed_profile_is_left_to_the_other_checks():
    # stats-missing / stats-fetch-failed own these; claiming "wrong fighter" on
    # a profile with no data in it would be a guess.
    assert health.profile_mismatch("Nobody", None, 3, TODAY) == ""
    assert health.profile_mismatch(
        "Nobody", {"fetch_failed": "2026-08-01", "opp": []}, 3, TODAY) == ""


def test_unreadable_dob_never_crashes_the_gate():
    assert health.profile_age("not a date", TODAY) is None
    assert health.profile_age(None, TODAY) is None
    assert health.profile_mismatch("X", profile(dob="???"), None, TODAY) == ""


def test_the_mismatch_warns_and_never_blocks():
    # A false positive must never stop the pipeline publishing a card.
    stats = json.dumps({"Jean Silva": profile(dob="Oct 08, 1977", opp=["Takanori Gomi"]),
                        "Jose Delgado": profile()})
    text = data_js([("UFC Fight Night: Silva vs. Delgado", "2026-08-13",
                     [fight("Jean Silva", "Jose Delgado", lbl="Main Event")])],
                   stats=stats, rankings=json.dumps({"Jean Silva": 6}))
    findings, summary = health.check(text, now=NOW)
    assert "profile-mismatch" in kinds(findings, "WARN")
    assert summary["block"] == 0
    assert any("Jean Silva" in f["message"] for f in findings
               if f["check"] == "profile-mismatch")
