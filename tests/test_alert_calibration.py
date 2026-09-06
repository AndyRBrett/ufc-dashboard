"""
Unit tests for the per-tier movement-alert calibration (#93).

The behaviour being protected is narrow and easy to break in the wrong
direction: prelim noise must stop flooding the feed WITHOUT the calibration ever
muting a tier it has too little history to judge, and without raising a bar onto
moves that historically retraced.

Run with:  python -m pytest -q
"""
import alert_calibration as calib


DEFAULT = 10


# --- tiering ---------------------------------------------------------------

def test_bout_tier_prefers_the_card_label_over_the_position():
    # A prelim listed first in a partially-announced card is still a prelim.
    assert calib.bout_tier(0, "Prelim") == "prelim"
    assert calib.bout_tier(7, "Main Event") == "main-event"
    assert calib.bout_tier(3, "Co-Main") == "main-card"
    assert calib.bout_tier(9, "Early Prelim") == "prelim"


def test_bout_tier_falls_back_to_card_position():
    # The snapshot history carries no labels, so position has to answer alone.
    assert calib.bout_tier(0) == "main-event"
    assert calib.bout_tier(4) == "main-card"
    assert calib.bout_tier(5) == "prelim"
    assert calib.bout_tier(2, "") == "main-card"


# --- sample extraction -----------------------------------------------------

def _bout(points, concluded=True):
    series = [{"at": f"t{i}", "f1_odds": a, "f2_odds": b}
              for i, (a, b) in enumerate(points)]
    bout = {"f1": "A", "f2": "B", "points": len(series), "series": series}
    if concluded:
        bout["close"] = series[-1]
    return bout


def test_an_unclosed_bout_contributes_nothing():
    # An upcoming card's line is still moving; scoring it would be provisional.
    drift, moves = calib.bout_samples(_bout([(-110, -110), (-160, 140)],
                                            concluded=False), "prelim")
    assert drift is None and moves == []


def test_drift_is_the_larger_side_of_the_open_to_close_move():
    drift, _ = calib.bout_samples(_bout([(-110, -110), (-150, 125), (-200, 170)]),
                                  "main-card")
    assert drift == 280        # f2: -110 → 170


def test_a_retraced_move_is_recorded_as_not_persisted():
    # Steams out to -200 mid-window, comes all the way back: that is the noise
    # the calibration exists to price out.
    _, moves = calib.bout_samples(_bout([(-110, -110), (-200, 170), (-115, -105)]),
                                  "prelim")
    assert moves and all(persisted is False for _, persisted in moves)


def test_a_move_that_holds_to_the_close_is_persisted():
    _, moves = calib.bout_samples(_bout([(-110, -110), (-200, 170), (-260, 220)]),
                                  "prelim")
    assert moves and all(persisted for _, persisted in moves)


# --- threshold selection ---------------------------------------------------

def _series_doc(drift_by_tier):
    """A concluded-event series doc whose bouts drift by the given magnitudes.

    One event per bout, padded so the bout sits at a card position its tier owns
    (the series file carries no labels, so position is what tiering reads).
    """
    first_slot = {"main-event": 0, "main-card": 1, "prelim": calib.MAIN_CARD_SLOTS}
    events = []
    for tier, drifts in drift_by_tier.items():
        idx = first_slot[tier]
        for d in drifts:
            # Padding bouts are left unclosed so they contribute no samples of
            # their own — only the bout under test is scored.
            card = [_bout([(-110, -110)], concluded=False) for _ in range(idx)]
            card.append(_bout([(-110, -110), (-110, -110 - d // 2),
                               (-110, -110 - d)]))
            events.append({"event_id": "2026-01-01:e", "concluded": True,
                           "bouts": card})
    return {"events": events}


def test_a_thin_tier_keeps_the_global_default():
    # Under MIN_SAMPLES the percentile is a coin flip — never quieter than before.
    doc = _series_doc({"main-event": [200] * 3})
    out = calib.calibrate(doc, DEFAULT)
    assert out["thresholds"]["main-event"] == DEFAULT
    meta = next(t for t in out["tiers"] if t["tier"] == "main-event")
    assert meta["source"] == "default" and "need" in meta["reason"]


def test_a_noisy_tier_is_calibrated_up_from_its_own_distribution():
    # 40 prelim bouts drifting 100-300 points: alerting at 10 fires on all of
    # them, which is the flood #93 describes.
    doc = _series_doc({"prelim": [100 + 5 * i for i in range(40)]})
    out = calib.calibrate(doc, DEFAULT)
    prelim = out["thresholds"]["prelim"]
    assert prelim > DEFAULT
    meta = next(t for t in out["tiers"] if t["tier"] == "prelim")
    assert meta["source"] == "calibrated"
    # It targets that tier's own top slice, not an absolute number.
    assert meta["target_alert_rate"] == calib.TIER_ALERT_RATES["prelim"]


def test_the_threshold_never_leaves_the_sane_band():
    huge = calib.calibrate(_series_doc({"prelim": [5000] * 40}), DEFAULT)
    assert huge["thresholds"]["prelim"] <= calib.MAX_THRESHOLD
    tiny = calib.calibrate(_series_doc({"prelim": [1] * 40}), DEFAULT)
    assert tiny["thresholds"]["prelim"] >= calib.MIN_THRESHOLD


def test_calibration_is_a_no_op_on_an_empty_or_broken_series_file():
    for doc in ({}, None, {"events": []}, {"events": [{"bouts": []}]}):
        out = calib.calibrate(doc, DEFAULT)
        assert out["thresholds"] == {t: DEFAULT for t in calib.TIERS}


def test_threshold_for_falls_back_on_junk():
    assert calib.threshold_for({"prelim": 45}, "prelim", DEFAULT) == 45
    assert calib.threshold_for({"prelim": "45"}, "prelim", DEFAULT) == DEFAULT
    assert calib.threshold_for(None, "prelim", DEFAULT) == DEFAULT
    assert calib.threshold_for({}, "main-event", DEFAULT) == DEFAULT


def test_quantile_by_nearest_rank():
    assert calib.quantile([10, 20, 30, 40], 0) == 10
    assert calib.quantile([10, 20, 30, 40], 1) == 40
    assert calib.quantile([10, 20, 30, 40], 0.5) == 30
    assert calib.quantile([], 0.5) is None


def test_persistence_rate_counts_only_moves_at_or_above_the_bar():
    moves = [(5, False), (20, True), (40, True), (60, False)]
    rate, n = calib.persistence_rate(moves, 20)
    assert n == 3 and round(rate, 2) == 0.67
    assert calib.persistence_rate(moves, 500) == (None, 0)
