# Fighter/odds enhancements — work log & handoff

Branch: `claude/fighter-odds-enhancements-7eylbg`. Four issues, worked in
dependency-free order so each one commits and ships on its own:

| Issue | Enhancement | Status |
| ----- | ----------- | ------ |
| #94 | Secondary odds provider fallback when the primary budget runs out | ✅ shipped (M1) |
| #93 | Movement alerts calibrated per weight class / card position | ✅ shipped (M2) |
| #74 | Fighter-history + style-matchup model probability alongside odds | ✅ shipped (M3) |
| #90 | Parlay risk calculator with correlation warnings | ✅ shipped (M4) |

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

---

## M3 — #74 model vs market probability (`index.html`, `tests/fight-model.mjs`)

**Problem.** The dashboard read the market well but had no independent view of
who should win, so a line move looked the same whether it carried information or
just public money.

**Where it lives — and why client-side.** Everything the model needs is already
in `data.js` (`RESULTS_ARCHIVE`, `FIGHTER_STATS` with reach/stance/dob/form,
`RANKINGS`). Computing it in the browser means no scraper change, no new data
file, no `health.py` surface to keep green, and it works offline in the PWA. The
block is delimited by `// model:start` … `// model:end` in `index.html`, is pure
(reads globals, touches no DOM), and is lifted straight out of the file by the
test.

**The model.**

- **Seed** per fighter: win *rate* (not win margin — a 12-0 prospect and a
  24-12 journeyman have the same +12 margin and the market treats them nothing
  alike), a small margin tiebreaker, divisional ranking, and decayed recent form.
- **Elo replay** over `RESULTS_ARCHIVE` in date order, K=24, ×1.2 for finishes.
  Every fighter in the stats cache is seeded up front — seeding lazily inside the
  replay left anyone who hadn't fought since the archive began at the 1500
  baseline, which rated a #2-ranked 23-3 lightweight as an unknown.
- **Style matchup** in Elo points, each term clamped and each one *named* so the
  tooltip explains the number: reach, age, striking volume×accuracy, takedowns,
  finish rate, southpaw-vs-orthodox.
- **Confidence shrink**: the whole gap is scaled by how much of both profiles we
  actually have (0.35–1) and capped at 400 Elo (~91%). Without it a fighter with
  no record and no stats came out a 79% model favourite against a 20% market
  underdog.
- **Comparison is de-vigged**: the market's two implied probabilities are
  normalised to sum to 1, or the model reads low on both fighters and every bout
  looks like an edge.

**UI.** A `.model-row` under the moneyline: `model% / market%` per fighter,
shown for unpriced bouts too (that's when a second opinion has nothing to compete
with) and hidden once a bout has a winner. The gap badge is **comparative, not
absolute**: only the widest gaps on a card, at most `MODEL_FLAG_MAX` (3) and none
under `MODEL_EDGE_MIN` (12 points). Typical model-vs-market disagreement is ~11
points, so a fixed bar would badge half the card and mean nothing.

**Accuracy — read this before quoting a number.** A backtest over the archived
results scores the model at 81% straight-up against the closing line's 66%, and
that number is **not trustworthy**: `FIGHTER_STATS` is fetched today, so a
fighter's record and `form` already contain the result being predicted. That is
look-ahead leakage, and it inflates every accuracy figure available today. Do not
put an accuracy claim in the UI. A clean walk-forward backtest needs per-fighter
stat snapshots as of each card, which the pipeline does not keep yet —
**that is the natural follow-up**: persist a dated `FIGHTER_STATS` digest per
scrape, then score the model on cards that closed after that snapshot.

**Tests.** `npm run check:model` (`tests/fight-model.mjs`, wired into `verify`
and `validate-web.yml`): seeding, the thin-data shrink, no-stats → no model,
de-vigging, symmetry, named factors, archive replay incl. a result naming
neither corner, and the flag cap. `SW_VERSION` bumped so installed PWAs pick the
new page up.

---

## M4 — #90 parlay risk calculator (`index.html`, `tests/parlay-risk.mjs`)

**Problem.** The parlay modal only had AI *suggestions*. Nothing priced the
ticket you actually built, and the two things a bettor can't check by eye are
exactly the two the market hides: the margin baked into every leg, and the fact
that same-card outcomes aren't independent.

**What shipped.** A deterministic calculator (`// parlay:start … // parlay:end`,
pure, no network) plus a builder UI at the top of the existing parlay modal —
tap a corner per bout, or hit **Use my picks** to seed it from your own picks.
It renders instantly and never waits on the AI suggestions below it.

- `parlayLeg` prices a selection and carries **both** probabilities: the raw
  implied one and the de-vigged one.
- `parlayCombine` gives payout (product of decimals), *true* chance (product of
  the **de-vigged** legs — a naive product inherits the book's margin on every
  leg) and `ev`, the expected return per unit staked.
- `parlayWarnings` names the dependencies visible in the data:
  - the **compounding margin**, quantified ("one leg gives up ~5c per $1;
    stacked 3 deep this ticket gives up ~14c");
  - **correlated legs** — two or more picks who win mostly by finish share a
    dependency on a finish-heavy night, so they are not the independent bets the
    combined probability assumes;
  - an all-favourites ticket, and the chance at least one leg goes down;
  - longshot legs, named with their real chance;
  - legs where the **#74 model** rates the pick ≥12 points below its price.

**Same-camp correlation: not implemented, on purpose.** The issue floats it as an
example, but nothing in `data.js` carries a fighter's camp or team —
`FIGHTER_STATS` has stats, physicals, form and opponents, no affiliation — so the
heuristic would have to be invented rather than derived. If it's wanted, the
honest route is to scrape a team/camp field first (UFCStats doesn't expose one;
Sherdog and Tapology do), then add a warning keyed on it.

**Tests.** `npm run check:parlay` (`tests/parlay-risk.mjs`, in `verify` and
`validate-web.yml`): odds conversion and rejection of impossible prices, the
de-vigged leg, product math, EV worsening per leg, and each warning — including
the negative cases (a single leg isn't lectured about compounding; a
decision-heavy fighter isn't called a finisher). `SW_VERSION` bumped again.

---

## Where to pick this up

All four issues are shipped on `claude/fighter-odds-enhancements-7eylbg` as four
self-contained commits. Nothing is half-finished; the open follow-ups are the
ones named above, in rough value order:

1. **#94** — watch the first live scrape for `Odds source espn: +N new fights`.
   ESPN's egress is blocked from the dev sandbox, so the payload shape was
   written from ESPN's documented scoreboard schema and fixture-tested. If it
   comes back empty, the fix is confined to `_espn_competitor_names` /
   `_espn_moneyline` in `scrape.py`.
2. **#74** — persist a dated `FIGHTER_STATS` digest per scrape so the model can
   be backtested without look-ahead leakage. Until that exists, do not publish an
   accuracy number.
3. **#93** — once a few months of snapshots carry `wc`, extend the calibration to
   tier × weight band behind the existing `MIN_SAMPLES` guard.
4. **#90** — same-camp correlation needs a camp/team field scraped first.

---

## M5 — follow-up: wrong fighter behind a name (`scrape.py`, `health.py`)

Found by looking at the #74 model row on the live card: the main event showed
`MODEL 28% / MARKET 77%` with a +49 gap on the underdog. The model wasn't
disagreeing with the market — it was reading a different man's profile.

**What was wrong.** UFCStats files several fighters under the same name, and
`_search_ufcstats` disambiguated by *most total fights*, on the theory that the
busiest record is the active roster member. It isn't, and the failure is silent —
a plausible record for the wrong person goes onto the card and into the model:

| card name | profile the scraper cached | reality |
| --- | --- | --- |
| Jean Silva (ranked #6, main event) | 19-12-3, born **1977**, one UFC opponent (Takanori Gomi) | a 48-year-old namesake |
| Petr Yan (champion, title co-main) | 11-13-0, born **1980**, one UFC opponent | a 46-year-old namesake |

Both were the *more experienced* row, which is exactly why the old rule picked
them. This is also what produced the two widest "model vs market" gaps on the
card — the model was working correctly on wrong inputs.

**Fix — recency, not volume.** `order_ufcstats_matches` (pure) now orders
same-name candidates by *who fought most recently*, with total fights kept only
as the tie-break for candidates whose page couldn't be read. `_search_ufcstats`
fetches the last-fight date for up to `_UFCSTATS_DISAMBIG_MAX` (4) candidates —
a cost paid only on the rare ambiguous name — and logs each candidate's record
and last-fight date so the choice is auditable in the scrape log.

**Detection — `profile-mismatch` (WARN) in `health.py`.** The fix stops new bad
matches; this catches ones already cached, on *all* upcoming cards rather than
only imminent ones (a wrong profile is wrong the day it lands). Two tells a real
roster member cannot produce:

- the profile is `PROFILE_MAX_AGE` (44) or older — nobody on a UFC card is;
- the fighter is **ranked** but the profile lists ≤1 UFC opponent — a ranked
  fighter has a UFC record by definition.

The ranking is load-bearing in the second one: a debutant legitimately has no UFC
history, so without it the check would flag every new signing. Empty and failed
profiles are left to `stats-missing` / `stats-fetch-failed` — claiming "wrong
fighter" on a profile with no data would be a guess. WARN only: a false positive
must never block a card from publishing.

Run over the current cache (142 fighters on upcoming cards) it flags exactly
those two and nothing else.

**Cache purge.** Both poisoned entries were removed from `FIGHTER_STATS` and
their serialised card records blanked, so the next scrape re-resolves them from
scratch with the new logic instead of re-hitting the cached wrong URL. Blank for
a few hours beats confidently wrong. (Without the purge they would have healed
anyway at the next `STATS_REFRESH_DAYS` re-validation, up to 14 days out.)

**Tests.** `tests/test_parsers.py` — date parsing in both formats UFCStats uses,
recency beating the bigger record, an undateable candidate never outranking a
dated one, and the no-dates fallback to the old behaviour.
`tests/test_health.py` — both real mismatch shapes, plus the profiles that must
NOT flag (a real ranked fighter, a debutant with no UFC opponents, a veteran
inside the age bound, an empty/failed entry, an unreadable DOB) and the
warn-never-block guarantee.

---

## M6 — what the first live run showed (and the second half of the name bug)

Run [#4027](https://github.com/AndyRBrett/ufc-dashboard/actions/runs/34063887222)
(manual dispatch on the merge of M5) was the first execution of both #94 and the
name fix. Results:

**Jean Silva — fixed.** The disambiguation worked exactly as designed:

```
UFCStats: 2 fighters match 'Jean Silva' — picking the most recently active
UFCStats: 17-3-0 last 2026-01-24, 19-12-3 last 2005-07-17
Stats Jean Silva: slpm=4.82 acc=51 td=1.2 tdd=78 ko=4 sub=1 rec=17-3-0
```

**Petr Yan — not fixed, and the log said why by omission**: no "N fighters match"
line at all, so only ONE candidate was ever seen and the tie-break never ran.

M5 fixed how candidates are *ranked*; this fixes how they are *gathered*.
`_search_ufcstats` searched one letter page per name token and **returned from
the first page with a hit**. UFCStats lists the wrong namesake surname-first
("Yan Petr"), filing him under **P** — searched before **Y**, so the real Yan's
page was never loaded. Candidates are now collected from every letter page and
de-duplicated before ranking, and the empty-page retry only fires when a page
actually came back empty (it used to be reachable whenever a name simply wasn't
found, costing a pointless second pass).

**ESPN (#94) — reached, parsed nothing.**

```
Odds source the-odds-api:primary:    +49 new fights (49 total)
Odds source the-odds-api:secondary:  +2 new fights (51 total)
Odds source the-odds-api:backup-key: +0 new fights (51 total)
Odds source espn:                    +0 new fights (51 total)
```

No `ESPN scoreboard: HTTP nnn` and no `ESPN error:` — the requests succeeded and
the parser found no moneylines. Three different causes need three different
fixes (no events in the window / events whose competitions carry no `odds` /
odds present but read wrongly), and nothing in the log could tell them apart, so
`espn_payload_shape` now counts each layer and `fetch_odds_espn` logs it:

```
ESPN: N event(s), M bout(s), K with an odds block, P priced
```

**Do not "fix" the ESPN parser until that line has been seen.** If K is 0 the
scoreboard endpoint simply doesn't carry MMA moneylines and the provider should
be repointed or dropped — editing `_espn_moneyline` would be guessing. ESPN is
unreachable from the dev sandbox, so this line is the only evidence available.

---

## M7 — the second live run: two definitive answers

Run [#4029](https://github.com/AndyRBrett/ufc-dashboard/actions/runs/34076063168),
on the merge of M6.

**ESPN carries no MMA odds at all.** The diagnostic added in M6 settled it in one
line:

```
ESPN: 16 event(s), 113 bout(s), 0 with an odds block, 0 priced
```

Events and bouts came back fine; not one competition carried an `odds` block. So
`_espn_moneyline` / `_espn_competitor_names` were never the problem — there is
nothing on that endpoint to parse. **Do not patch the parser.** The provider needs
to be repointed at a source that actually publishes prices, or dropped; #94's
only other backstop is `ODDS_API_KEY_SECONDARY`, which is unset.

**Petr Yan was never re-fetched** — `Fetching stats for 2 fighters (0 new)` listed
only Rong Zhu and Thomas Gantt. The 22:28 run had rewritten his entry (wrong
profile, via the letter-page bug) and stamped `fetched_at`, so the fix that
merged hours later was locked out for the full `STATS_REFRESH_DAYS`.

That is the trap worth closing: **a wrong entry looks exactly as fresh as a right
one**, so the freshness cadence can never repair the entries that most need it,
and M5's `profile-mismatch` warning could only describe the problem for two
weeks. `profile_is_implausible` + `_needs_stats_fetch` now force a fresh *search*
(not a cached-URL re-hit) for any profile whose DOB implies an age of
`STATS_MAX_PLAUSIBLE_AGE` (44) or more, bounded to once per
`STATS_MISMATCH_RECHECK_H` (24h) so a genuine 45-year-old costs one search a day
rather than one per run. Yan's entry is purged again so the merged gathering fix
resolves him on the next run instead of waiting for that recheck.

Detection now triggers correction; before this, they were in different files and
only one of them ran.

---

## M8 — ESPN removed; the second API key is the backstop

Decision taken on the M7 evidence (`0 with an odds block` across 113 bouts): the
ESPN provider is **deleted**, not patched. Its parser, window-builder, payload
diagnostic and tests are gone, and the `ODDS_ESPN*` env vars with them. The
config comment records what was measured so nobody re-adds it hopefully.

`ODDS_API_KEY_SECONDARY` is now #94's only backstop, and it needed one more thing
to actually work: **`update.yml` never passed the secret to the scrape step.**
Without that line the key could be added to the repo and change nothing, which is
the worst kind of fix — one that looks applied. It is wired through now, and
unset remains harmless (the provider no-ops).

**To finish #94** (owner action, ~2 minutes):

1. Create a second free account at the-odds-api.com (500 calls/month).
2. Add its key as repo secret **`ODDS_API_KEY_SECONDARY`**.

That doubles the monthly budget and gives the chain a source that survives
primary exhaustion. Until then the fallback chain is real but empty, and
`odds_budget_exhausted` still degrades exactly as it did before #94.

The `metered=False` capability stays in `OddsProvider` (and stays tested): it is
what lets an unmetered source, if one is ever found, keep pricing cards when the
paid budget is gone. Any candidate should be added as a provider and proven with
one live run before being trusted — that loop is now cheap, which is the durable
outcome of the ESPN experiment.
