"""
Unit tests for the per-fighter odds time-series + closing-line-value builder.

These guard the product math behind odds-series.json: that a bout's history is
turned into a fighter-aligned, change-only series, and that closing-line value is
frozen only once an event has concluded (an upcoming line is still moving). Pure
functions over in-memory snapshot history — no network or filesystem, so they run
in CI alongside the status tests.

Run with:  python -m pytest -q
"""
from datetime import date

import odds_series as osr


def _fight(o1, o2, f1="Manel Kape", f2="Kyoji Horiguchi"):
    return {"f1": f1, "f2": f2, "f1_odds": o1, "f2_odds": o2}


# --- per-bout series --------------------------------------------------------

def test_series_records_one_point_per_line_change():
    history = [("t1", [_fight(-157, 131)]),
               ("t2", [_fight(-150, 127)]),
               ("t3", [_fight(-150, 127)])]   # unchanged — must be collapsed
    bouts = osr.build_bout_series(history)
    assert len(bouts) == 1
    assert bouts[0]["points"] == 2
    assert [p["f1_odds"] for p in bouts[0]["series"]] == [-157, -150]


def test_series_is_fighter_aligned_when_a_snapshot_swaps_order():
    # Second snapshot serialises the fighters the other way round; the series must
    # still track each fighter, not each slot.
    history = [("t1", [_fight(-157, 131)]),
               ("t2", [_fight(127, -150, f1="Kyoji Horiguchi", f2="Manel Kape")])]
    bouts = osr.build_bout_series(history)
    assert bouts[0]["f1"] == "Manel Kape"
    assert [p["f1_odds"] for p in bouts[0]["series"]] == [-157, -150]


def test_series_preserves_first_seen_card_order():
    a = _fight(-200, 170, f1="A", f2="B")
    b = _fight(150, -180, f1="C", f2="D")
    bouts = osr.build_bout_series([("t1", [a, b])])
    assert [(x["f1"], x["f2"]) for x in bouts] == [("A", "B"), ("C", "D")]


# --- closing line / CLV -----------------------------------------------------

def test_closing_line_deferred_until_event_concludes():
    bout = osr.build_bout_series([("t1", [_fight(-157, 131)]),
                                  ("t2", [_fight(-150, 127)])])[0]
    open_, close, clv = osr.closing_line(bout, concluded=False)
    assert open_["f1_odds"] == -157
    assert close is None and clv is None


def test_closing_line_value_is_close_minus_open_per_fighter():
    bout = osr.build_bout_series([("t1", [_fight(-157, 131)]),
                                  ("t2", [_fight(-150, 127)])])[0]
    open_, close, clv = osr.closing_line(bout, concluded=True)
    assert open_["f1_odds"] == -157 and close["f1_odds"] == -150
    assert clv == {"f1_odds": 7, "f2_odds": -4}


def test_event_date_parses_id_prefix():
    assert osr.event_date("2026-07-11:ufc-329-mcgregor-vs-holloway-2") == date(2026, 7, 11)
    assert osr.event_date("not-a-date:x") is None


# --- whole-log assembly -----------------------------------------------------

def test_build_series_freezes_clv_for_past_events_only():
    history = {
        "2026-06-01:past":     [("t1", [_fight(-157, 131)]), ("t2", [_fight(-150, 127)])],
        "2026-09-01:upcoming": [("t1", [_fight(-157, 131)]), ("t2", [_fight(-150, 127)])],
    }
    out = osr.build_series(history, date(2026, 6, 22))
    by_id = {e["event_id"]: e for e in out["events"]}
    assert by_id["2026-06-01:past"]["concluded"] is True
    assert by_id["2026-06-01:past"]["bouts"][0]["clv"] == {"f1_odds": 7, "f2_odds": -4}
    assert by_id["2026-09-01:upcoming"]["concluded"] is False
    assert by_id["2026-09-01:upcoming"]["bouts"][0]["clv"] is None


def test_build_series_indexes_both_fighters():
    history = {"2026-06-01:past": [("t1", [_fight(-157, 131)]),
                                   ("t2", [_fight(-150, 127)])]}
    out = osr.build_series(history, date(2026, 6, 22))
    assert out["fighters"]["Manel Kape"][0]["clv"] == 7
    assert out["fighters"]["Manel Kape"][0]["opponent"] == "Kyoji Horiguchi"
    # Underdog side is indexed from its own perspective.
    assert out["fighters"]["Kyoji Horiguchi"][0]["clv"] == -4
    assert out["fighters"]["Kyoji Horiguchi"][0]["side"] == "f2"


# --- card label carried through for alert tiering ---------------------------

def _labelled(o1, o2, lbl, f1="Manel Kape", f2="Kyoji Horiguchi"):
    return {"f1": f1, "f2": f2, "f1_odds": o1, "f2_odds": o2, "lbl": lbl}


def test_a_promoted_bout_is_filed_under_where_it_actually_fought():
    # Cards get reshuffled — a headliner withdraws and the co-main moves up. The
    # placement that matters for alert tiering is the one it was FOUGHT at, so
    # the latest label wins; keeping the first filed a promoted bout's drift
    # under the tier it left.
    history = [("t1", [_labelled(-110, -110, "Prelim")]),
               ("t2", [_labelled(-160, 140, "Main Card")]),
               ("t3", [_labelled(-200, 170, "Main Event")])]
    assert osr.build_bout_series(history)[0]["lbl"] == "Main Event"


def test_a_later_snapshot_without_a_label_never_erases_one():
    # Only non-empty labels replace: a snapshot written before the label existed
    # must not blank a placement already recorded.
    history = [("t1", [_labelled(-110, -110, "Main Event")]),
               ("t2", [_fight(-160, 140)])]
    assert osr.build_bout_series(history)[0]["lbl"] == "Main Event"


def test_a_bout_from_before_labels_existed_carries_an_empty_one():
    # Pre-label history keeps the positional fallback in alert_calibration.
    history = [("t1", [_fight(-110, -110)])]
    assert osr.build_bout_series(history)[0]["lbl"] == ""
