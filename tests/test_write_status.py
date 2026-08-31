"""
Unit tests for the pure odds-movement / empty-payload helpers in write_status.py.

These guard the two failure modes the status file exists to catch: a frozen feed
(line movement read back from snapshots) and a silently-empty extraction that
must not read as fresh (#14). No network or filesystem, so they run in CI.

Run with:  python -m pytest -q
"""
import pytest
import hashlib
import json

import write_status as ws


# --- empty-payload detection (#14) -----------------------------------------

def test_empty_fights_hash_is_the_empty_string_sha():
    # The tell from #14: zero parsed bouts fingerprints to SHA-256("").
    assert ws.fingerprint([]) == ws.EMPTY_SHA == hashlib.sha256(b"").hexdigest()


def test_has_data_false_for_empty_payload():
    assert ws.has_data([]) is False
    assert ws.has_data([{"f1": "A", "f2": "B", "f1_odds": -150, "f2_odds": 130}]) is True


# --- status disambiguation: awaiting-card vs parse-failure (#14) ------------

def _empty_event(date):
    # An announced card with fighters but no odds parses to zero odds-bearing
    # fights — exactly the medic-vs-rodriguez shape behind #14.
    return {"date": date, "bout_count": 9, "fights": []}


def test_classify_ok_when_odds_present():
    ev = {"date": "2026-08-01", "bout_count": 9,
          "fights": [{"f1": "A", "f2": "B", "f1_odds": -150, "f2_odds": 130}]}
    assert ws.classify_event(ev, [], "2026-06-22") == "ok"


def test_classify_awaiting_card_for_far_out_unpriced_event():
    # 40 days out, never carried odds → legitimately not priced yet, not an error.
    assert ws.classify_event(_empty_event("2026-08-01"), [], "2026-06-22") == "awaiting-card"


def test_classify_parse_failure_when_odds_expected_soon():
    # Inside the window books should already have priced → real failure.
    assert ws.classify_event(_empty_event("2026-06-28"), [], "2026-06-22") == "parse-failure"


def test_classify_parse_failure_on_regression():
    # Odds were present in history and have now vanished → regression, any date.
    hist = [("t1", [{"f1": "A", "f2": "B", "f1_odds": -150, "f2_odds": 130}])]
    assert ws.classify_event(_empty_event("2026-08-01"), hist, "2026-06-22") == "parse-failure"


def test_classify_awaiting_card_for_past_unpriced_event():
    # A past event that never carried odds won't be priced retroactively — benign.
    assert ws.classify_event(_empty_event("2026-06-01"), [], "2026-06-22") == "awaiting-card"


# --- exhausted odds budget is not a parse failure ---------------------------

def test_classify_odds_unavailable_when_budget_is_spent():
    # THE REGRESSION TEST for the 2026-08-14 red-every-5-minutes run. Same event
    # shape as the parse-failure case above, but no request could be made, so
    # there was nothing to parse and nothing is broken on our side.
    assert ws.classify_event(
        _empty_event("2026-06-28"), [], "2026-06-22", budget_exhausted=True
    ) == "odds-unavailable"


def test_classify_still_parse_failure_when_budget_is_healthy():
    # The carve-out must be narrow: with budget available, an unpriced imminent
    # card is still a real failure that has to turn the run red.
    assert ws.classify_event(
        _empty_event("2026-06-28"), [], "2026-06-22", budget_exhausted=False
    ) == "parse-failure"


def test_exhausted_budget_does_not_excuse_vanished_odds():
    # A dead quota can't explain odds DISAPPEARING: get_odds_with_fallback keeps
    # the lines already in data.js even when the API never answers. So this stays
    # a regression that must fail the run.
    hist = [("t1", [{"f1": "A", "f2": "B", "f1_odds": -150, "f2_odds": 130}])]
    assert ws.classify_event(
        _empty_event("2026-08-01"), hist, "2026-06-22", budget_exhausted=True
    ) == "parse-failure"


def test_exhausted_budget_does_not_reclassify_a_far_out_card():
    # Still awaiting-card, not odds-unavailable — books haven't priced it yet
    # either way, and mislabelling it would inflate the unpriced count.
    assert ws.classify_event(
        _empty_event("2026-08-01"), [], "2026-06-22", budget_exhausted=True
    ) == "awaiting-card"


def test_odds_unavailable_is_not_reported_as_an_error():
    # The whole point: it must not reach failure_errors, which is what
    # parse_failure_events (and the run's red/green) is computed from.
    assert ws.failure_errors([_ev("a", "odds-unavailable", 8)]) == []


# --- odds_budget_exhausted: quota spent vs key rejected ---------------------

@pytest.mark.parametrize("state,expected", [
    ({"last_status": 401, "requests_remaining": 0},    True),   # quota spent
    ({"last_status": 403, "requests_remaining": 0},    True),
    ({"last_status": 401, "requests_remaining": 480},  False),  # key rejected
    ({"last_status": 401},                             False),  # unknown quota
    ({"last_status": 200, "requests_remaining": 0},    False),
    ({},                                               False),
])
def test_odds_budget_exhausted_distinguishes_quota_from_a_dead_key(
        tmp_path, state, expected):
    # A rejected key never self-heals and must keep failing the run; only the
    # spent-quota case is excused. x-requests-remaining is the only thing that
    # tells the two 401s apart.
    p = tmp_path / "odds-state.json"
    p.write_text(json.dumps(state), encoding="utf-8")
    assert ws.odds_budget_exhausted(p) is expected


def test_odds_budget_exhausted_is_false_when_state_is_missing_or_corrupt(tmp_path):
    # Conservative default: with no readable state we can't prove the budget was
    # spent, so genuine parse failures stay loud.
    assert ws.odds_budget_exhausted(tmp_path / "nope.json") is False
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    assert ws.odds_budget_exhausted(bad) is False


def test_parse_events_counts_announced_bouts_without_odds():
    # Two bouts, neither with odds (odds:null) → zero odds-fights but bout_count 2,
    # so the event reads as awaiting-card rather than a zero-bout parse failure.
    data = (
        'var EVENTS=[\n'
        '  {\n    name:"UFC Fight Night: Test",\n    date:"2026-09-01",\n'
        '    fights:[\n'
        '      {lbl:"Main Event",odds:null,winner:"",f1:{n:"Alice Aaa",r:""},f2:{n:"Bob Bbb",r:""}},\n'
        '      {lbl:"Co-Main",odds:null,winner:"",f1:{n:"Cara Ccc",r:""},f2:{n:"Dana Ddd",r:""}}\n'
        '    ]\n  }\n]\n'
    )
    evs = ws.parse_events(data)
    assert len(evs) == 1
    assert evs[0]["fights"] == []
    assert evs[0]["bout_count"] == 2


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


# --- line-movement alerts (#17) --------------------------------------------

def test_event_movers_flags_bout_past_threshold():
    # Headliner drifted -22 from open (-157 -> -179); a 10-point threshold trips.
    opens  = {ws.matchup_key(_fight(-157, 131)): _fight(-157, 131)}
    movers = ws.event_movers([_fight(-179, 150)], opens, 10)
    assert len(movers) == 1
    m = movers[0]
    assert m["f1_movement"] == -22 and m["magnitude"] == 22 and m["main_event"] is True


def test_event_movers_ignores_bouts_under_threshold():
    opens = {ws.matchup_key(_fight(-157, 131)): _fight(-157, 131)}
    # Only a 3-point drift on each side — below a 10-point threshold.
    assert ws.event_movers([_fight(-160, 134)], opens, 10) == []


def test_event_movers_alerts_when_only_underdog_side_moves():
    # f1 barely moves but the f2 side blows out past threshold — still a steam move.
    opens  = {ws.matchup_key(_fight(-157, 131)): _fight(-157, 131)}
    movers = ws.event_movers([_fight(-159, 175)], opens, 10)
    assert len(movers) == 1 and movers[0]["f2_movement"] == 44


def test_event_movers_no_alert_without_opener():
    # First time a bout is seen there's no opener, so movement is zero, no alert.
    assert ws.event_movers([_fight(-300, 240)], {}, 10) == []


def test_event_movers_marks_only_first_bout_as_main_event():
    a = _fight(-179, 150)
    b = {"f1": "X", "f2": "Y", "f1_odds": 200, "f2_odds": -250}
    opens = {
        ws.matchup_key(_fight(-157, 131)): _fight(-157, 131),
        ws.matchup_key(b): {"f1": "X", "f2": "Y", "f1_odds": 100, "f2_odds": -120},
    }
    movers = ws.event_movers([a, b], opens, 10)
    assert [m["main_event"] for m in movers] == [True, False]


def test_post_alerts_noop_without_webhook(monkeypatch):
    # No webhook configured → never touches the network.
    monkeypatch.setattr(ws, "ALERT_WEBHOOK_URL", "")
    called = []
    monkeypatch.setattr(ws.urllib.request, "urlopen", lambda *a, **k: called.append(1))
    ws.post_alerts([{"event_id": "e", "magnitude": 22}])
    assert called == []


# --- error messages must name the real gap (#66) ---------------------------

def _ev(event_id, status, bout_count):
    return {"event_id": event_id, "status": status, "bout_count": bout_count}


def test_odds_missing_is_not_reported_as_a_bout_parse_failure():
    # THE REGRESSION TEST for #66. This is the real 2026-08-22 payload shape:
    # 8 bouts parsed, every one unpriced. Reporting that as "expected bouts, got
    # none" contradicts bout_count in the same file and sent the investigation
    # after a bout-parser bug that did not exist.
    errs = ws.failure_errors(
        [_ev("2026-08-22:ufc-fight-night-hernandez-vs-rodrigues", "parse-failure", 8)])
    assert len(errs) == 1
    assert "odds missing" in errs[0]
    assert "expected bouts, got none" not in errs[0]


def test_true_zero_bout_failure_keeps_the_original_wording():
    errs = ws.failure_errors([_ev("2026-08-22:x", "parse-failure", 0)])
    assert len(errs) == 1
    assert "expected bouts, got none" in errs[0]


def test_both_failure_kinds_reported_separately():
    errs = ws.failure_errors([_ev("a", "parse-failure", 0),
                              _ev("b", "parse-failure", 5)])
    assert len(errs) == 2
    assert any("expected bouts" in e and "a" in e for e in errs)
    assert any("odds missing" in e and "b" in e for e in errs)


def test_healthy_and_awaiting_events_produce_no_errors():
    assert ws.failure_errors([_ev("a", "ok", 12), _ev("b", "awaiting-card", 9)]) == []


# --- alert dedup (#67) ------------------------------------------------------

def _alert(event_id="2026-08-22:e", f1="A", f2="B", magnitude=20):
    return {"event_id": event_id, "f1": f1, "f2": f2, "magnitude": magnitude,
            "f1_movement": magnitude, "f2_movement": -magnitude, "main_event": False}


def test_first_sighting_of_a_mover_is_sent():
    send, seen = ws.new_alerts([_alert()], {})
    assert len(send) == 1
    assert seen[ws.alert_key(_alert())] == 20


def test_standing_mover_is_not_reannounced():
    # THE POINT OF #67. A steam move doesn't un-happen, so every later run
    # re-detects it. At the 5-minute card-night cadence that is ~288 posts a day
    # for one move — which is how a useful alert becomes one you mute.
    _, seen = ws.new_alerts([_alert()], {})
    send, _ = ws.new_alerts([_alert()], seen)
    assert send == []


def test_a_move_that_keeps_steaming_is_news_again():
    _, seen = ws.new_alerts([_alert(magnitude=20)], {})
    send, _ = ws.new_alerts([_alert(magnitude=25)], seen)   # +25% → re-alert
    assert len(send) == 1


def test_marginal_growth_stays_quiet():
    _, seen = ws.new_alerts([_alert(magnitude=20)], {})
    send, _ = ws.new_alerts([_alert(magnitude=21)], seen)   # +5% → noise
    assert send == []


def test_oscillation_across_the_threshold_cannot_re_alert():
    # A line drifting back down and up again must not re-fire: the high-water
    # mark is kept, so only genuine new extension counts.
    _, seen = ws.new_alerts([_alert(magnitude=30)], {})
    _, seen = ws.new_alerts([_alert(magnitude=12)], seen)
    send, _ = ws.new_alerts([_alert(magnitude=30)], seen)
    assert send == []


def test_alert_key_is_order_independent():
    assert ws.alert_key(_alert(f1="A", f2="B")) == ws.alert_key(_alert(f1="B", f2="A"))


def test_different_bouts_and_events_are_tracked_separately():
    _, seen = ws.new_alerts([_alert(f1="A", f2="B")], {})
    send, _ = ws.new_alerts([_alert(f1="C", f2="D"),
                             _alert(event_id="2026-09-05:x", f1="A", f2="B")], seen)
    assert len(send) == 2


def test_new_alerts_does_not_mutate_the_state_it_was_given():
    # The caller only persists on a successful post; mutating in place would
    # mark an alert as sent even when the webhook failed.
    original = {}
    ws.new_alerts([_alert()], original)
    assert original == {}


# --- implied probability + alert ranking (#26, #52) -------------------------

def test_implied_prob_matches_the_standard_moneyline_formula():
    assert ws.implied_prob(-150) == pytest.approx(0.6)
    assert ws.implied_prob(100) == pytest.approx(0.5)
    assert ws.implied_prob(300) == pytest.approx(0.25)
    assert ws.implied_prob(None) is None


def test_prob_shift_reveals_what_moneyline_points_hide():
    # THE POINT OF #26. Both moves are 40 points of American odds, but the
    # favourite's is more than twice the probability swing. Ranking on raw
    # points treats them as equal, which they plainly are not.
    fav = ws.prob_shift(-110, -150)
    dog = ws.prob_shift(400, 340)
    assert fav > 6 and dog < 4
    assert fav > 2 * dog


def test_prob_shift_is_none_without_both_sides():
    assert ws.prob_shift(None, -150) is None
    assert ws.prob_shift(-150, None) is None


def test_main_event_outranks_a_louder_undercard_move():
    # THE POINT OF #52. The headliner is what people actually have money on, so
    # a smaller move on it can still be the more actionable alert.
    main = {"magnitude": 20, "main_event": True}
    prelim = {"magnitude": 40, "main_event": False}
    assert ws.alert_priority(main, 2) > ws.alert_priority(prelim, 2)


def test_main_event_weighting_has_a_deliberate_ceiling():
    # The weight is 2.5x, not infinite: a genuinely enormous undercard swing
    # should still beat a small headliner twitch. Pinning the crossover keeps
    # that a design decision rather than an accident of tuning.
    main = {"magnitude": 10, "main_event": True}
    assert ws.alert_priority(main, 2) < ws.alert_priority(
        {"magnitude": 26, "main_event": False}, 2)
    assert ws.alert_priority(main, 2) > ws.alert_priority(
        {"magnitude": 24, "main_event": False}, 2)


def test_imminent_cards_outrank_distant_ones():
    soon = {"magnitude": 20, "main_event": False}
    far = {"magnitude": 20, "main_event": False}
    assert ws.alert_priority(soon, 1) > ws.alert_priority(far, 30)


def test_imminence_weight_boundaries():
    assert ws.imminence_weight(2) == 2.0
    assert ws.imminence_weight(3) == 1.4
    assert ws.imminence_weight(30) == 1.0
    assert ws.imminence_weight(None) == 1.0
    assert ws.imminence_weight(-1) == 1.0


def test_magnitude_still_breaks_ties_within_a_tier():
    big = {"magnitude": 50, "main_event": False}
    small = {"magnitude": 10, "main_event": False}
    assert ws.alert_priority(big, 5) > ws.alert_priority(small, 5)


def test_movers_carry_probability_shifts():
    opens = {("A", "B"): {"f1": "A", "f2": "B", "f1_odds": -110, "f2_odds": -110}}
    fights = [{"f1": "A", "f2": "B", "f1_odds": -150, "f2_odds": 130}]
    mover = ws.event_movers(fights, opens, threshold=10)[0]
    assert mover["f1_prob_shift"] > 0     # A shortened → more likely to win
    assert mover["f2_prob_shift"] < 0


# --- odds budget exhaustion: telling someone (issue #76) --------------------
#
# The flag was true and surfaced nowhere but the raw JSON. A card whose lines
# quietly stop refreshing looks exactly like a quiet market, so the failure was
# invisible for weeks. These pin the telling, and — just as important — pin that
# it does not become the thing you mute.

def test_budget_alert_fires_on_the_flip_then_once_a_day():
    from datetime import date
    day1, day2 = date(2026, 8, 31), date(2026, 9, 1)

    alert, seen = ws.budget_alert(True, {}, day1)
    assert alert and alert["kind"] == "odds_budget_exhausted"

    # The 5-minute fight-window cadence would otherwise post this ~288x/day.
    again, seen = ws.budget_alert(True, seen, day1)
    assert again is None

    tomorrow, seen = ws.budget_alert(True, seen, day2)
    assert tomorrow, "a standing outage should still be mentioned once a day"


def test_recovery_re_arms_the_alert():
    from datetime import date
    day = date(2026, 8, 31)
    _, seen = ws.budget_alert(True, {}, day)
    _, seen = ws.budget_alert(False, seen, day)
    assert ws.BUDGET_ALERT_KEY not in seen
    # Exhausted again the same day must alert again — it is a new outage.
    again, _ = ws.budget_alert(True, seen, day)
    assert again


def test_days_until_reset_crosses_the_month_end():
    from datetime import date
    assert ws.days_until_reset(date(2026, 8, 31), reset_day=1) == 1
    assert ws.days_until_reset(date(2026, 8, 1), reset_day=1) == 31   # today isn't "0 days"
    assert ws.days_until_reset(date(2026, 8, 20), reset_day=25) == 5
    assert ws.days_until_reset(date(2026, 12, 31), reset_day=1) == 1  # year rolls over
    # A reset day past the shortest month still lands on a real date.
    assert ws.days_until_reset(date(2026, 2, 1), reset_day=31) >= 1


def test_most_affected_is_the_card_about_to_happen():
    from datetime import date
    today = date(2026, 8, 31)
    events = [
        {"event_id": "2026-08-01:past-card", "status": "ok"},
        {"event_id": "2026-09-20:far-card", "status": "awaiting-card"},
        {"event_id": "2026-09-02:next-card", "status": "awaiting-card"},
        {"event_id": "not-a-date", "status": "ok"},
    ]
    out = ws.most_affected_events(events, today)
    assert [e["event_id"] for e in out] == ["2026-09-02:next-card", "2026-09-20:far-card"]
    assert out[0]["days_out"] == 2


def test_the_banner_renders_what_python_computed():
    # No JS test runner for index.html, so pin the seam: the banner must read the
    # fields write_status publishes rather than deriving a countdown of its own,
    # or the banner and the webhook alert can disagree about the same outage.
    from pathlib import Path
    page = (Path(__file__).resolve().parent.parent / "index.html").read_text(encoding="utf-8")
    assert 'id="oddsBudgetBanner"' in page
    assert "overseer-status.json" in page
    for field in ("odds_budget", "resets_in_days", "most_affected", "exhausted"):
        assert field in page, f"the banner ignores {field}"


def test_the_banner_is_not_a_flex_container():
    # It is one sentence with a <b> countdown inside it. As a flex container each
    # text run and the <b> become separate flex ITEMS, and the countdown broke out
    # into its own column mid-sentence on a 420px screen. Caught by rendering the
    # page in Chromium; it had passed review by eye.
    from pathlib import Path
    page = (Path(__file__).resolve().parent.parent / "index.html").read_text(encoding="utf-8")
    rule = page.split(".odds-budget-banner.show{")[1].split("}")[0]
    assert "flex" not in rule, "the banner is a flex container again"
