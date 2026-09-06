# Fighter/odds enhancements — work log & handoff

Branch: `claude/fighter-odds-enhancements-7eylbg`. Four issues, worked in
dependency-free order so each one commits and ships on its own:

| Issue | Enhancement | Status |
| ----- | ----------- | ------ |
| #94 | Secondary odds provider fallback when the primary budget runs out | ✅ shipped (M1) |
| #93 | Movement alerts calibrated per weight class / card position | ✅ shipped (M2) |
| #74 | Fighter-history + style-matchup model probability alongside odds | ⏳ not started |
| #90 | Parlay risk calculator with correlation warnings | ⏳ not started |

Every milestone below is committed separately and passes `npm run verify` plus
`python -m pytest -q`. Anyone picking this up mid-stream: run both first, then
read the milestone marked ⏳ next.

---

## M1 — #94 odds provider failover (`scrape.py`)

**Problem.** The two existing "sources" (`fetch_odds_primary`,
`fetch_odds_secondary`) are the same Odds API key with different region sets, so
they share one monthly quota. When it ran out, every metered call 401'd and
announced cards with 12–14 parsed bouts sat odds-unavailable until the monthly
reset.

**What shipped.**

- `OddsProvider` — a source in the chain, tagged with the *quota bucket* it
  spends (`quota=`) and whether it has a budget at all (`metered=`). Providers
  sharing a key share an exhaustion state. `ODDS_PROVIDERS` is the priority list;
  `ODDS_SOURCES` stays as an alias so existing callers/tests keep working.
- Two backstops that survive exhaustion:
  - `fetch_odds_backup_key()` — same API, `ODDS_API_KEY_SECONDARY` (a second
    account = an independent quota). No-op when the env var is unset.
  - `fetch_odds_espn()` — the ESPN MMA scoreboard already fetched for start
    times also carries a moneyline per bout. Keyless, unmetered, last in the
    chain, so it only fills pairs no metered source priced. Disable with
    `ODDS_ESPN=0`.
- Per-provider quota state persisted in `odds-state.json` under `providers.<bucket>`
  (`last_status`, `requests_remaining`, `bouts`, `last_fetch_at`, `last_ok_at`,
  `exhausted_at`). `select_odds_providers()` skips a bucket whose budget is spent,
  so the run stops burning time on calls that can only 401 and the unmetered
  fallback gets its turn. `quota_blocked()` re-opens the bucket on the UTC month
  rollover or after `ODDS_QUOTA_RETRY_HOURS` (12), whichever is first — a skip
  must never be permanent.
- Top-level `odds-state.json` fields (`last_status`, `requests_remaining`) still
  describe the **primary key only**, because `health.py` and
  `write_status.odds_budget_exhausted` read them. Backup-key/ESPN results go to
  the `providers` map instead. Don't repoint those fields without updating both
  readers.

**Deliberate constraints.**

- ESPN's payload shape is read defensively (`_espn_moneyline` handles
  `moneyLine`, `current.moneyLine.american`, and string prices) and every pair
  goes through `_valid_odds`. A shape change degrades to "no lines", never to an
  exception that takes the fallback down.
- ESPN's egress is blocked from the dev sandbox, so `_index_espn_odds` was
  written against ESPN's documented scoreboard shape and unit-tested on fixtures.
  **First live run is the real check**: watch the scraper log for
  `Odds source espn: +N new fights`. If ESPN nests its MMA odds differently, the
  fix is confined to `_espn_competitor_names` / `_espn_moneyline`.

**Tests.** `tests/test_parsers.py` → "odds provider failover + per-provider quota
(#94)": ESPN parsing incl. alternate shapes and junk rejection, quota
exhausted/blocked semantics (spent budget vs. rejected key), provider selection,
`record_provider_state` stamping and clearing `exhausted_at`, and the end-to-end
case — budget spent, paid provider never called, card still priced from ESPN.

---

## M2 — #93 per-tier movement alert thresholds (`alert_calibration.py`, `write_status.py`)

**Problem.** Every bout was judged against one `MOVEMENT_ALERT_THRESHOLD=10`.
Points of American moneyline aren't comparable across tiers — a big favourite's
line moves in much larger steps for the same change of mind — so prelim noise
filed at the same sensitivity as a headliner's steam move. On the live status
file that was 46 alerts, prelim movers at 670/650 sitting beside main events at
202/295.

**What shipped.**

- `alert_calibration.py` — pure, no I/O. Per tier (`main-event` / `main-card` /
  `prelim`), the threshold is the movement magnitude at the top `rate` of *that
  tier's own* historical open→close drift, from `odds-series.json`.
  `TIER_ALERT_RATES` is deliberately uneven (0.50 / 0.35 / 0.20): sensitivity
  tracks what's at stake, not the size of the price tag.
- Two guards. A tier under `MIN_SAMPLES` (20 scored bouts) keeps the global
  default — never quieter than before. And a *raised* bar is only accepted if
  moves at that size historically **persisted** to the close more often than
  moves at the default (`PERSISTENCE_KEEP` = kept half the move, same side).
  That's the "sharp money vs noise" backtest #93 asks for; it stops the
  calibration muting a tier whose big swings are churn.
- `write_status.py` calibrates once per run from the committed series file
  (no new artifact), judges each bout by `bout_tier(index, lbl)`, and tags every
  alert with `tier`, `threshold` and `wc`. The status file gains
  `movement_alert_thresholds` and `movement_alert_calibration` (the evidence
  behind each number).
- `parse_events` now captures `lbl` and `wc` per bout, so the tier comes from the
  card itself and the **snapshot log starts accumulating weight class**.

**Live effect** (measured against the committed history): thresholds came out
main-event 10 / main-card 45 / prelim 110, cutting the feed 46 → 20 alerts with
every main-event mover retained and persistence at the chosen bars of 0.95/0.97
against 0.77/0.89 at the old global 10.

**Weight-class axis: deliberately deferred.** `odds-snapshots.jsonl` has never
carried `wc`, so there is no history to segment by division — a per-division
percentile today would be fitted to a handful of bouts. This milestone starts
recording it. Once a few months of snapshots carry `wc`, extend
`collect_samples`/`bout_tier` to a compound key (tier × weight band) behind the
same `MIN_SAMPLES` guard; nothing else has to change.

**Tests.** `tests/test_alert_calibration.py` (tiering, sample extraction,
retraced-vs-persisted moves, thin-tier fallback, the sane band, empty/broken
series file) and new cases in `tests/test_write_status.py` (label/wc parsing,
a prelim needing a bigger move than a main event, cold-start parity).
