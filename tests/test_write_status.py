"""
Unit tests for the pure odds-movement / empty-payload helpers in write_status.py.

These guard the two failure modes the status file exists to catch: a frozen feed
(line movement read back from snapshots) and a silently-empty extraction that
must not read as fresh (#14). No network or filesystem, so they run in CI.

Run with:  python -m pytest -q
"""
import hashlib

import write_status as ws


# --- empty-payload detection (#14) -----------------------------------------

def test_empty_fights_hash_is_the_empty_string_sha():
    # The tell from #14: zero parsed bouts fingerprints to SHA-256("").
    assert ws.fingerprint([]) == ws.EMPTY_SHA == hashlib.sha256(b"").hexdigest()


def test_has_data_false_for_empty_payload():
    assert ws.has_data([]) is False
    assert ws.has_data([{"f1": "A", "f2": "B", "f1_odds": -150, "f2_odds": 130}]) is True


# --- matchup keying --------------------------------------------------------

def test_matchup_key_is_order_independent():
    a = {"f1": "Manel Kape", "f2": "Kyoji Horiguchi", "f1_odds": -157, "f2_odds": 131}
    b = {"f1": "Kyoji Horiguchi", "f2": "Manel Kape", "f1_odds": 131, "f2_odds": -157}
    assert ws.matchup_key(a) == ws.matchup_key(b)


# --- line movement ---------------------------------------------------------

def test_delta_is_current_minus_open():
    opener = {"f1": "Manel Kape", "f2": "Kyoji Horiguchi", "f1_odds": -157, "f2_odds": 131}
    cur    = {"f1": "Manel Kape", "f2": "Kyoji Horiguchi", "f1_odds": -150, "f2_odds": 127}
    assert ws.delta(opener, cur) == {
        "f1": "Manel Kape", "f2": "Kyoji Horiguchi", "f1_odds": 7, "f2_odds": -4}


def test_delta_realigns_when_open_lists_fighters_swapped():
    # Opener recorded the bout in the opposite f1/f2 order; movement must still be
    # computed per fighter, not per slot.
    opener = {"f1": "Kyoji Horiguchi", "f2": "Manel Kape", "f1_odds": 131, "f2_odds": -157}
    cur    = {"f1": "Manel Kape", "f2": "Kyoji Horiguchi", "f1_odds": -150, "f2_odds": 127}
    assert ws.delta(opener, cur) == {
        "f1": "Manel Kape", "f2": "Kyoji Horiguchi", "f1_odds": 7, "f2_odds": -4}


def test_delta_is_zero_when_no_opener_recorded_yet():
    cur = {"f1": "A", "f2": "B", "f1_odds": -150, "f2_odds": 130}
    assert ws.delta(None, cur) == {"f1": "A", "f2": "B", "f1_odds": 0, "f2_odds": 0}


def test_realign_falls_back_to_current_when_no_opener():
    cur = {"f1": "A", "f2": "B", "f1_odds": -150, "f2_odds": 130}
    assert ws.realign(None, cur) == cur


# --- opening line & last-changed reconstructed from snapshot history --------

def _fight(o1, o2):
    return {"f1": "Manel Kape", "f2": "Kyoji Horiguchi", "f1_odds": o1, "f2_odds": o2}


def test_open_fights_takes_the_first_time_a_bout_appears():
    history = [("t1", [_fight(-157, 131)]), ("t2", [_fight(-150, 127)])]
    opens = ws.open_fights(history)
    assert opens[ws.matchup_key(_fight(0, 0))]["f1_odds"] == -157


def test_last_changed_at_is_when_current_odds_first_appeared():
    # Odds moved at t2 and have held since; last change is t2, not t1 or now.
    history = [("t1", [_fight(-157, 131)]), ("t2", [_fight(-150, 127)])]
    assert ws.last_changed_at(history, [_fight(-150, 127)], "now") == "t2"


def test_last_changed_at_walks_back_through_unchanged_runs():
    # Same line across every snapshot — last change is the oldest, not the newest.
    history = [("t1", [_fight(-150, 127)]), ("t2", [_fight(-150, 127)])]
    assert ws.last_changed_at(history, [_fight(-150, 127)], "now") == "t1"


def test_last_changed_at_is_now_when_latest_snapshot_differs():
    # Current odds differ from the newest snapshot → moved this run.
    history = [("t1", [_fight(-157, 131)])]
    assert ws.last_changed_at(history, [_fight(-150, 127)], "now") == "now"


def test_last_changed_at_is_now_without_history():
    assert ws.last_changed_at([], [_fight(-150, 127)], "now") == "now"
