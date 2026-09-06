#!/usr/bin/env python3
"""
Per-tier calibration of the line-movement alert threshold (#93).

Every bout was measured against one global MOVEMENT_ALERT_THRESHOLD=10, and the
alert feed showed what that costs: prelim movers scoring 670 and 650 sat next to
main-card and main-event movers at 202 and 295. Prelim line noise trips the same
tripwire as a headliner's steam move, so the feed is mostly the tier nobody is
betting, and #52's priority weighting can only re-order that flood — it cannot
stop it being filed in the first place.

Points of American moneyline are not comparable across tiers. A big favourite's
line moves in far larger point steps than a pick'em for the same change of mind,
and prelims carry both the bigger prices and the thinner markets. So calibrate
each tier against ITS OWN historical distribution, from the persisted odds
time-series (odds-series.json, built by odds_series.py from the snapshot log):

    threshold(tier) = the movement magnitude at the top `rate` of that tier's
                      historically observed per-bout drift

with `rate` set per tier on purpose (TIER_ALERT_RATES) rather than shared: a main
event is where a move is most worth hearing about, so half its distribution
qualifies, against a fifth of a prelim's. Sensitivity therefore rises with what
is at stake instead of with the size of the price tag.

Two guards keep a thin or misleading history from making things worse:

  * a tier with fewer than MIN_SAMPLES bouts keeps the global default — an
    under-sampled percentile is a coin flip, not a calibration;
  * the derived threshold is only accepted if bigger moves in that tier really
    are more meaningful — measured as PERSISTENCE: the share of mid-window moves
    that were still there at the close rather than retraced. If raising the bar
    does not raise persistence, the bar stays where it was. That is the
    "sharp money vs noise" backtest #93 asks for, and it is what stops the
    calibration quietly muting a tier whose big moves are pure churn.

Thresholds are recomputed each run from the committed series file (small, and
one fewer artifact to keep in sync) and reported in overseer-status.json
alongside the evidence for each one.
"""

TIERS = ("main-event", "main-card", "prelim")

# Bouts 2..5 of a card are the rest of the main card; everything below is prelims.
MAIN_CARD_SLOTS = 5

# What share of each tier's own movement distribution should reach the feed.
TIER_ALERT_RATES = {"main-event": 0.50, "main-card": 0.35, "prelim": 0.20}

MIN_SAMPLES   = 20    # bouts needed before a tier's own history is trusted
MIN_THRESHOLD = 10    # never more sensitive than the old global default
MAX_THRESHOLD = 120   # never so blunt that a tier goes silent
ROUND_TO      = 5     # thresholds are read by humans; 45 beats 43.6

# A move counts as persisted when the close kept at least this much of it, on the
# same side. Retraced moves are the noise the calibration is trying to price out.
PERSISTENCE_KEEP = 0.5
MIN_MOVE         = 5     # smaller drifts are quote jitter, not a move
MIN_PERSIST_OBS  = 10    # persistence measured on fewer than this proves nothing

_LABEL_TIERS = {
    "main event": "main-event",
    "co-main":    "main-card",
    "main card":  "main-card",
    "prelim":     "prelim",
    "early prelim": "prelim",
}


def bout_tier(index, label=""):
    """Which alert tier a bout belongs to.

    The card label is authoritative when data.js carries one ("Main Event",
    "Prelim", ...); position on the card is the fallback, and is all the snapshot
    history has, so both paths have to agree on the same three tiers.
    """
    key = (label or "").strip().lower()
    for prefix, tier in _LABEL_TIERS.items():
        if key.startswith(prefix):
            return tier
    if index == 0:
        return "main-event"
    return "main-card" if index < MAIN_CARD_SLOTS else "prelim"


def quantile(values, q):
    """The q-quantile (0..1) of `values` by nearest rank. None when empty."""
    if not values:
        return None
    ordered = sorted(values)
    if q <= 0:
        return ordered[0]
    if q >= 1:
        return ordered[-1]
    idx = int(round(q * (len(ordered) - 1)))
    return ordered[idx]


def _magnitude(point, open_point):
    """The larger of the two sides' drift from the opening line."""
    return max(abs(point["f1_odds"] - open_point["f1_odds"]),
               abs(point["f2_odds"] - open_point["f2_odds"]))


def bout_samples(bout, tier):
    """(drift, mid-window moves) observed for one bout of the series file.

    `drift` is the bout's total open→close movement — the distribution the
    threshold percentile is taken from. The moves are (magnitude, persisted)
    pairs, one per intermediate reading, which is what persistence is measured
    on. A bout that never closed (an upcoming card) contributes neither: its
    line is still moving, so both answers would be provisional.
    """
    series = bout.get("series") or []
    close  = bout.get("close")
    if len(series) < 2 or not close:
        return None, []
    open_ = series[0]
    drift = _magnitude(close, open_)
    moves = []
    for point in series[1:-1]:
        for side in ("f1_odds", "f2_odds"):
            mag = abs(point[side] - open_[side])
            if mag < MIN_MOVE:
                continue
            moved = point[side] - open_[side]
            final = close[side] - open_[side]
            persisted = (final * moved > 0) and abs(final) >= PERSISTENCE_KEEP * mag
            moves.append((mag, persisted))
    return drift, moves


def collect_samples(series_doc):
    """{tier: {"drifts": [...], "moves": [(magnitude, persisted), ...]}} from
    odds-series.json. Only concluded events are used — an unfinished card has no
    close to measure a move against."""
    out = {t: {"drifts": [], "moves": []} for t in TIERS}
    for event in (series_doc or {}).get("events", []):
        if not event.get("concluded"):
            continue
        for i, bout in enumerate(event.get("bouts", [])):
            tier = bout_tier(i)
            drift, moves = bout_samples(bout, tier)
            if drift is None:
                continue
            out[tier]["drifts"].append(drift)
            out[tier]["moves"].extend(moves)
    return out


def persistence_rate(moves, threshold):
    """(share of moves at/above `threshold` that stuck, sample size)."""
    kept = [p for m, p in moves if m >= threshold]
    if not kept:
        return None, 0
    return sum(1 for p in kept if p) / len(kept), len(kept)


def _round_to(value, step=ROUND_TO):
    return int(step * round(value / step))


def calibrate_tier(tier, samples, default_threshold):
    """(threshold, evidence) for one tier.

    Falls back to `default_threshold` — never to something more sensitive —
    whenever the history can't support a decision, so a cold start behaves
    exactly like the old global constant.
    """
    drifts = samples.get("drifts", [])
    moves  = samples.get("moves", [])
    rate   = TIER_ALERT_RATES.get(tier, TIER_ALERT_RATES["prelim"])
    meta   = {"tier": tier, "bouts": len(drifts), "target_alert_rate": rate,
              "source": "default"}
    if len(drifts) < MIN_SAMPLES:
        meta["reason"] = f"only {len(drifts)} scored bouts (need {MIN_SAMPLES})"
        return default_threshold, meta

    raw = quantile(drifts, 1 - rate)
    threshold = max(MIN_THRESHOLD, min(MAX_THRESHOLD, _round_to(raw)))
    meta["observed_p"] = raw

    # The backtest guard: a higher bar has to buy a cleaner signal. If moves at
    # the calibrated threshold are no more likely to survive to the close than
    # moves at the default, the tier's big swings are churn and raising the bar
    # would only hide bouts without sharpening anything.
    base_rate, base_n = persistence_rate(moves, default_threshold)
    cal_rate,  cal_n  = persistence_rate(moves, threshold)
    meta["persistence_at_default"]   = None if base_rate is None else round(base_rate, 3)
    meta["persistence_at_threshold"] = None if cal_rate is None else round(cal_rate, 3)
    meta["persistence_samples"]      = cal_n
    if threshold <= default_threshold:
        meta["source"] = "calibrated"
        return max(threshold, MIN_THRESHOLD), meta
    if cal_n < MIN_PERSIST_OBS or cal_rate is None or base_rate is None:
        meta["reason"] = "not enough closed moves to test the higher bar"
        return default_threshold, meta
    if cal_rate < base_rate:
        meta["reason"] = ("bigger moves in this tier retrace more often than "
                          "smaller ones — keeping the default")
        return default_threshold, meta
    meta["source"] = "calibrated"
    return threshold, meta


def calibrate(series_doc, default_threshold):
    """{"thresholds": {tier: points}, "tiers": [evidence, ...]} for a run.

    Pure: hand it a parsed odds-series.json (or {}) and it decides. Every
    threshold is explained by its entry in "tiers" — how many bouts backed it,
    what alert rate it targets, and whether moves at that size historically held
    to the close.
    """
    samples = collect_samples(series_doc)
    thresholds, evidence = {}, []
    for tier in TIERS:
        value, meta = calibrate_tier(tier, samples[tier], default_threshold)
        thresholds[tier] = value
        evidence.append(meta)
    return {"thresholds": thresholds, "tiers": evidence}


def threshold_for(thresholds, tier, default_threshold):
    """The threshold to judge a bout in `tier` by, defaulting safely."""
    value = (thresholds or {}).get(tier)
    return default_threshold if not isinstance(value, (int, float)) else value
