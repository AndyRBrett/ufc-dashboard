# History: the incidents behind CLAUDE.md's rules

CLAUDE.md is read at the start of every session, so it keeps the rules and
this file keeps the stories: the dates, the measurements and the outages each
rule came from. These sections are CLAUDE.md as it stood on 2026-11-16, moved
here whole. Read the matching section here before loosening a rule there.

## The data pipeline fails loudly now — don't re-add silent fallbacks

`scrape.py` degrades gracefully everywhere (a failed source keeps the previous
value). That keeps the site up, but it used to mean a broken pull and a good pull
were indistinguishable — the commit landed either way. Three pieces fix that:

| piece | what it does |
| ----- | ------------ |
| `health.py` | reads the built `data.js` and reports what's wrong, weighted by how close the card is |
| `odds-state.json` | last Odds API pull time, HTTP status, remaining quota, and what the feed listed/priced per card date |
| `health-report.json` / `.md` | findings for the run; the `.md` is the tracking-issue body |

`update.yml` runs `python health.py --gate --baseline /tmp/data-before.js`
**between the scrape and the commit**. The severity split is load-bearing:

- **BLOCK** — structural breakage (unparseable data, empty `EVENTS`, a card that
  *collapsed*). The job fails, nothing is committed, the last-good `data.js`
  stays live, and GitHub emails the failure.
- **WARN** — data gaps (blank record, missing line, TBD fighter). Reported to a
  single auto-updating GitHub issue, but **never blocks** — a blocked commit
  during a card also blocks the live results everyone is watching.

**A card losing a bout is a withdrawal, not breakage — don't re-tighten that.**
Both layers used to treat *any* shrink as a bad parse: `scrape.py`'s regression
guard reverted to the fuller card and `health.py` BLOCKed the publish. The
failure they were built for (an over event's article flips to a results table,
the parse collapses, and the title-regex fallback synthesises a one-bout stub
that would wipe a card and its injected results) does produce that shape — but so
does a fighter pulling out, and pull-outs are routine. Ortega/Moicano came off
UFC 331 four days out, the scraper parsed the correct 12-bout card on every run
for the rest of fight week, and both layers put the cancelled bout back every
time; users kept picking a fight that no longer existed.
`health.believable_shrink` is now the single test for "is this churn or a
collapse" (bounded by `CARD_SHRINK_MAX_DROP` and `CARD_SHRINK_MIN_RATIO`), and
`scrape.py` imports it rather than keeping its own copy: if the two disagree the
stricter one wins silently and the change can never publish at all. A collapse
still BLOCKs, and a card with results already injected is never shrunk.

**What actually runs the scraper is `kick-scraper`, not `schedule:`.** GitHub
delivers this repo's cron events best-effort and throttles them hard — measured
2026-09-15/16, one `update.yml` run per day, both ~5h late, zero in the 23h
between; in a Saturday fight window it once delivered ~6 of ~96. The real driver
is cron-job.org → the `kick-scraper` edge function → `workflow_dispatch`, which
isn't throttled. So when reasoning about "how fresh is the card", read
`supabase/functions/kick-scraper/`'s cadence gate, not the `schedule:` block in
`update.yml` — and remember an edge-function change needs a Supabase deploy, not
just a push. Its three modes (`live` every ping, `fight-week` hourly, `idle`
never) are held by `npm run check:kick`; widening `idle` is what let a cancelled
bout sit on UFC 331 for days.

**Non-UFC cards get the same fight mode.** A PFL / RIZIN / DWCS card in
`events-extra.json` dated today or yesterday (UTC) with a bout still missing its
`winner` makes `kick-scraper` live (`extraLive`) and opens `extra.py`'s cadence
gate on every run (`live_card`, `EXTRA_LIVE_MIN`), the same rule both sides.
Before it, those results waited on the 4-hour fight-week pull: DWCS 94
(2026-09-29) had none two hours after its last bout. The feed only ever adds
dispatches: unreadable is not live, and data.js's gate stays the one that
fails open.

**The scraper's result pushes go out after the commit, never from inside the
scrape.** `send-push` rebuilds an anon-key result push from the committed
`data.js` on `main` and 409s one it can't find there, so a push sent before
`git push` is always refused. `update.yml` sets `PUSH_DEFER_FILE`, the scrape
writes its new results there, and a step after the commit runs
`scrape.py --send-pending` (a 409 is retried briefly, `PUSH_409_RETRY_WAITS_S`).
The queue is the **committed** `pending-pushes.json`, never runner temp: the
next dispatch cancels a run, and one cancelled between its commit and its send
would lose the push for good (the next run sees the result as already in
`data.js`). So every run first replays the committed queue and empties it
(`--send-pending … --clear`); `notif_log` makes a repeat a no-op. Pushing from
inside the scrape made two UFC 332 main-card results 12-15 minutes late.
`tests/test_result_push_defer.py` holds it.

**`scrape.py` edits a document, never `data.js` text.** It used to treat the
published file as its database and edit it as text: results spliced in by
brace counting, cards read back by a regex that depended on field order, whole
vars swapped with `var NAME=.*?;` (which stops at the first semicolon inside a
value). Now `datafile.loads` reads the file once into plain values, every step
edits those (`doc`), and `datafile.checked_dumps` writes it once, refusing a
document that would not read back as itself. A `data.js` the parser can't read
fails the run with the file left alone: no fallback. The renderer reproduces
the file byte for byte, so the readers that still match its text (`health.py`,
`write_status.py`, the edge functions) see what they always did; **a new card
field goes into `datafile.py`'s reader, renderer and key lists together**, or
the next run refuses the file. `tests/test_datafile.py` holds it, including
that no pattern in `scrape.py` matches `data.js` text again. Before merging it
was run against `main`'s scraper on 2,232 scenarios built from a month of real
`data.js` history, same stubs and clock: every written file was identical.

**`FIGHTER_STATS` lives in `fighter-stats.js`, not `data.js`** (since
2026-11-16). It was ~73 KB of `data.js`'s ~88 KB gzipped, and `data.js` changes
on every scraper commit while the stats change in about one commit in twenty
(1,960 commits measured), so every open re-downloaded every fighter's stats.
`datafile.read_files` / `checked_dump_files` merge and split it, so `scrape.py`
still sees one document: `data.js` is the old file minus that one line,
`fighter-stats.js` is the stats sorted (its bytes, and ETag, move only when a
fighter's do), and the scraper's own bookkeeping (`STATS_BOOKKEEPING`:
`fetch_failed`, which churned on every run through the 2026-11-07..13 UFCStats
outage) goes to `stats-state.json`, which the app never downloads. **Every
reader takes either layout**: the page and the Lab load `fighter-stats.js`
after `data.js` (so it wins) and self-heal if neither defines `FIGHTER_STATS`;
FightBot runs it after `data.js`; `send-reminders` reads it with `parseDataJs`
(never runs it); `health.py`'s `with_split_stats` merges it and the state back
in. A `data.js` still carrying its own copy is read first by the scraper, which
is how the first run after the change performed the split. **A new stats field
the app doesn't read goes in `STATS_BOOKKEEPING`**, or its churn reaches the
file every phone downloads. `tests/test_stats_split.py` and `check:brief` hold
it; before merging, 282 versions of real `data.js` history split and read back
identically.

**A Wikipedia results page has one reading, and two result senders.**
`results.js` (`ResultsParse`) is the parser the open app's live poll loads and
`check-results` imports (bundled into `_shared/results-bundle.js` by `npm run
build:fn`; `check:bundle` fails if stale). scrape.py's Python parser can't share
code, so the two share an answer key, `tests/fixtures/results/expected.json`:
`tests/test_results_golden.py` holds scrape.py to it and `check:results` holds
results.js to it. **A parsing rule changes in scrape.py and results.js
together**, then `python tests/test_results_golden.py --update`, with the diff
called out; never regenerate it to make one side pass. Before this, the app's
copy disagreed with scrape.py on 36% of random pages and check-results' on 50%,
and check-results asked for "UFC 334: Gane vs. Hokit" (a redirect stub with no
results), so the server backup never fired for a numbered PPV. **The live poll
stays**: it shows a result ~1 minute after Wikipedia, `data.js` ~8 minutes
later (scrape plus Pages deploy, measured on UFC 334). **It sends no pushes**:
the scraper sent every UFC 334 result push 4-10 s after its commit and
send-push refuses a browser's before that commit, so `check:dedup` now fails on
a third sender. The table round is the first lone digit after the method (a
bare digit in a notes cell used to overwrite it).

**A finished bout's method and round follow Wikipedia's corrections; its
winner doesn't.** `inject_results` never re-reads a bout once it is
`state:"post"`, so UFC 333's main event went in as Submission R1 from an early
edit and stayed there after the page was fixed (TKO R2), scoring every KO/TKO
pick as a method miss. `correct_results` now re-reads method and round inside
the same results window, only when the reading names the same winner, never
blanking a known value, and pushes nothing. A result fixed by hand goes in
`_RESULT_PINS`, or the next run puts a still-wrong reading back.
`tests/test_result_corrections.py` holds it.

**Every server function reads the COMMITTED `data.js` (raw.githubusercontent,
`main`), never the Pages copy:** kick-scraper's gate, send-push and
send-reminders (whose `lockRows` writes the pick lock times; reading Pages, a
blocked deploy hid every finished pick for an hour on 2026-10-10, and
`check:picklock` now holds its URL). **The gate reads the COMMITTED `data.js`, never
the Pages copy.** Reading Pages made a loop: a blocked deploy left Pages showing
a card still mid-fight, the gate read it as `live`, and every ping dispatched
another run that failed the same gate. On 2026-09-27 a broken test blocked
deploys from 03:15 UTC and the scraper ran, and emailed a failure, every 5
minutes all morning instead of hourly. Don't point `DATA_URL` back at Pages.

**A test must never anchor on the live data files.** `data.js`,
`odds-series.json` and `intel.json` change every few minutes, and `verify` gates
every Pages deploy, so a test that reads a real card from them breaks the moment
that card's results land or it ages out, and it freezes the live site mid-card.
That is what happened with `check:brief` above. Tests that need a real card read
the frozen snapshot in `tests/fixtures/fight-week/` (the 2026-09-26 card before
its first bell). Only checks that validate the data itself (`check:web`,
`fighter-rename`'s collision scan, `check:intel`'s advisory block) read the live
files.

**Nor on the wall clock.** A test that pairs a real date with `Date.now()` /
`datetime.now()` is a countdown to a red deploy. `check:recap`'s "in-progress"
card was dated 2026-09-26 and became a finished card at 00:00 UTC on 09-28,
blocking every Pages deploy hourly. The same sweep found `test_extra` would fail
`update.yml`'s pytest guard, stopping every data update, once its 2026-10-16
fixture card passed, and that `etOffset()` read DST off today instead of the
card's date, so `check:brief` and `check:picklock` would have gone red at the
November change. Pin the clock (`load(nowMs)`, `runAt(iso)`, `main(now)`) or date
fixtures relative to it. **Nor on "no card is live".** `smoke`'s FN Mode check
took the first card with an open bout; once Allen vs. Duncan started that card
opened in Live mode, the check threw, and every Pages deploy failed for an hour
mid-card (2026-10-10): no results, no pick reveals, no fixes. So `npm run smoke`
now runs twice, the second time with `--card-day`, the page's clock pinned 90
minutes into the next unfinished card in data.js. A check that only holds
between cards fails there the week before, not on fight night. To audit: rerun the suite with `Date` / `datetime`
shifted forward by 3, 30, 60 and 365 days (a `--require` shim for Node,
`time-machine` for pytest). Browser tests need the page's clock shifted too, so
a Node-only shim reports false failures there.

**Eastern offsets come from the card's date.** `etOffset(date)` in the app and
`etOffset(y, mo, d)` in `send-reminders` both apply the rule to the date passed
in; `send-push` uses `Intl` with `America/New_York`, and `scrape.py` uses
`ZoneInfo`. Never derive a card's clock from today's offset.

Two budgets to respect when changing cadence:

- **Odds API calls are quota-metered.** `should_fetch_odds` gates them on elapsed
  time (3h–24h depending on how near the next card is). Do not call `fetch_odds`
  unconditionally — the 5-minute fight-window cadence used to, which burned
  ~1,200 calls/month against a 500/month tier and froze every line for six days.
- **Fighters on a card within `STATS_URGENT_DAYS` bypass the failure cooldown**
  (`_needs_stats_fetch(..., urgent=True)`). The flat 3-day cooldown guaranteed a
  blank record through any card that landed inside it.
- **A run must finish inside the 5-minute dispatch.** `update.yml` used to
  cancel an in-progress run when the next one arrived, so a run that outlasted
  it committed nothing and the next started the same work over: a loop. The stats loop is
  capped at `STATS_FETCH_BUDGET_S` (60s); gaps (`stats_gap`: nothing cached, or
  an imminent card's missing record / failed fetch) go first and get
  `STATS_GAP_BUDGET_S` (120s), still a hard stop for a UFCStats outage, and
  the rest of a backlog drains across runs. Fight day stays urgent past UTC
  midnight (`stats_days_out` counts calendar days; -1 covers a US night card). Without it, #258's one-time `res`
  backfill froze every data update, the UFC card's included, for 7 hours on
  2026-10-03. Any new per-run backfill needs the same kind of cap. Since
  2026-10-04 `update-main` also queues instead of cancelling
  (`cancel-in-progress: false`), so a run over budget still commits; the cap
  is what keeps the cadence at 5 minutes. A queued run checks out `main`'s
  tip, not its dispatch SHA, or it would push over the results the run ahead
  of it just committed; a forced run queues in `update-main-forced` so a
  routine dispatch can't replace it in the one pending slot.
- **A rebuild never re-fetches what it already knows.** Every run that injects
  no result rebuilds every listed card, and the rematch check's Layer 4 fetched
  both fighters' Wikipedia pages for each bout every time: 171 fetches, 175s of a
  207s scrape on 2026-10-04, enough with the stats budget to pass 5 minutes. Its
  own verdict is now cached in the committed `rematch-cache.json`
  (`REMATCH_CACHE_TTL_H`, 24h; never data.js's final `rematch`, which other
  layers set; never a verdict resting on a failed fetch), and `fetch_wikitext`
  takes the API's `missingtitle` as final instead of a raw 404 and two sleeps.
  Layer 4 (only) asks the API to follow redirects, so a name like "Jiri
  Prochazka" reads "Jiří Procházka" instead of a `#REDIRECT` stub that was never
  read and re-fetched every run, and `_fighter_wiki_past_fight` accent-folds the
  record text as well as the name it searches for. Event, list, rankings and
  record fetches still don't follow redirects. Layer 4 counts only a meeting
  dated at least two days before the bout's own card (`_record_row_date`; an
  undated row only for a card still to come): once a card is over both records
  list THAT bout, and every finished first meeting read as a rematch (UFC 331's
  Tsarukyan vs Ruffy, the whole Hooker vs Parnasse card). Its cache key carries
  the card date; the UFCStats layer already needs two meetings for a concluded
  bout. The row's date is its `{{dts}}` cell (numeric or named month), read
  after references are stripped, and a card the regression guard restores has
  every bout re-asked, since its saved `rematch:true` would otherwise stand. Bump `REMATCH_CACHE_VER` whenever Layer 4's matching changes, or old
  verdicts stand for a day.
  `tests/test_rematch_cache.py` holds all of it.

**"No odds" has two causes and only one of them is a bug.** `write_status.py`
files an unpriced card as `parse-failure` (which fails the run) or
`awaiting-card` (which doesn't), and for years it guessed between them on the
event's distance alone — `ODDS_EXPECTED_WITHIN_DAYS`. A threshold can't
separate "no book has opened this card" from "a market exists and we failed to
read it", so every value is wrong for one of them: on 2026-09-12 the Sep 26
card crossed the 14-day default unpriced and went red every run until the
threshold was narrowed to 7 days, which would have broken again on the next
card priced late. The scraper now records the fact instead of inferring it —
`note_market_dates` folds each odds payload into `odds-state.json`'s `markets`
block (per **ET** card date: bouts `listed`, bouts `priced`, and the priced
bouts' surnames), and `write_status.market_priced` reads it. Only `priced` can
make a card our failure.

Three properties of that signal are load-bearing, and each one is a way it
could quietly stop working:

- **It is read from the RAW payload, never from our own index**
  (`_raw_h2h_priced`, not `_index_odds_api`). The failure it exists to catch is
  our parser missing a market that exists, so deriving it from the parser would
  make it blind to exactly that: an upstream shape change, or every line
  rejected by `_valid_odds`, would read as "no market posted" and excuse the
  parse failure.
- **A priced bout must be one of OURS.** The endpoint is the umbrella
  `mma_mixed_martial_arts` feed, so a priced PFL bout on the same Saturday as
  an unpriced UFC card would otherwise prove the card had lines and turn the
  run red for a market nobody posted. `market_priced` intersects the snapshot's
  surnames with the card's roster; one hit is enough, which is why it is far
  more robust than the per-bout matching it polices (UFC 331 matched ten of
  twelve).
- **A partial view is never published as a complete one.** The providers cover
  deliberately different book sets, so if one fails or is skipped on a spent
  budget, a card priced only in its regions is absent from the survivor's
  payload. Publishing that would read as "no market" and hide the gap for the
  whole staleness window, so `record_market_state` refuses both a partial run
  and an empty one and keeps the last good snapshot instead.

The signal ages out (`MARKET_SIGNAL_MAX_AGE_H`, 72h) back to the day threshold,
which errs loud.

**Except while the primary key's quota is spent.** That lasts until the monthly
reset, so no complete snapshot can be written and the old one always ages out.
A partial run is therefore kept as `markets_partial` (never as `markets`), and
`write_status.partial_market_priced` reads it only when the primary is spent. If
the backup priced a bout of ours, an empty card is still a parse failure. If it
priced nothing of ours, the card is `odds-unavailable` (a warning): its regions
could not be asked. Without this, a one-bout card 13 days out failed every run
from 2026-09-27 06:08 UTC until the reset.

## The roast runs on Grok; everything else runs on Claude

`ai-breakdown` serves seven actions. Six of them — `breakdown`, `chat`,
`parlay`, the Fight Lab's `fight-iq` scouting report, FightBot's `guide` and
FightBot's `verdict` — make
claims about real fights, real people's picks or the app itself, and those stay on Claude. The fourth, `trash-talk`, is a joke between five friends, and
Claude would not stop sanding the edges off it: the burn came back PG no matter
how the prompt was phrased, which is the one thing the feature cannot be. So the
roast calls xAI's Grok instead.

**The split is per-action, not per-deployment, and `check:provider` holds it.**
A breakdown quietly routed to Grok is a different model answering a question
about a real fight; the gloves-off rule leaking into a parlay prompt is worse.
The test asserts `trashTalkProvider` and `unfilteredRule` are each referenced
exactly once in the handler, inside the roast branch.

| env | default | what it does |
| --- | ------- | ------------ |
| `GROK_API_KEY` (or `XAI_API_KEY`) | unset | the xAI key. **Unset = the roast stays on Claude and nothing changes** |
| `TRASH_TALK_PROVIDER` | `grok` | set to `claude` to force the roast back, without touching the key |
| `GROK_MODEL` | `grok-4.20-0309-non-reasoning` | **non-reasoning on purpose — see below.** Moves without a redeploy, same as `MODEL` |
| `GROK_MAX_TOKENS` | `1000` | Grok's ceiling. Not a length control — see below |
| `GROK_TIMEOUT_MS` | `8000` | how long the roast waits on Grok before Claude writes it instead |
| `ROAST_RETRY_BUDGET_MS` | `6000` | a first call slower than this buys no angle retry |
| `RETRY_BACKOFF_MS` | `1500` | spacing between retries; squashed in tests, never in production |
| `GROK_API_URL` | xAI chat-completions | only for pointing at a proxy |

**Two ways this feature fails silently, both ending in a roast that isn't
there.** Neither raises an error, and both look identical from the app — which
is why `provider`, `model` and `fellBack` come back in the response.

1. **A wrong `GROK_MODEL` is a 400**, and a 400 is deliberately not retried. The
   roast falls back to Claude and comes back *polite*, which reads like a prompt
   regression rather than a config typo. Always verify against
   `GET https://api.x.ai/v1/models` rather than typing an id from memory — the
   first default committed here (`grok-4-fast-non-reasoning`) turned out not to
   exist on this account at all, and would have shipped as exactly that silent
   fallback. The display name sometimes matches the id ("Grok 4.6" →
   `grok-4.6`) and sometimes doesn't (the 4.20 family ships as
   `grok-4.20-0309-reasoning` / `-non-reasoning`), so don't infer it.
2. **A reasoning model returns HTTP 200 with empty content** if the token budget
   is tight, because on the OpenAI-shaped API that budget covers the model's
   internal reasoning, not just the reply. The roast's prompt-level cap (~70
   words) makes 250 tokens a natural ceiling, and 250 is nowhere near enough for
   a model that thinks first. Hence `GROK_MAX_TOKENS` at 1000, separate from the
   250 the Claude path still uses: **it buys reasoning room, it does not permit a
   longer roast** — length is the prompt's job. A loose ceiling costs nothing
   when the model doesn't reason, since billing is per token produced.

   A blank-but-successful reply is therefore treated as a *failure* and falls
   back, rather than being returned as an empty roast the client renders as
   "No trash talk generated." with nothing logged. `check:provider` holds this.

**The roast is generated while someone watches a spinner, so latency is a
correctness property here.** The shipped default,
`grok-4.20-0309-non-reasoning`, is the only Grok model that has actually served
a roast on this workload: **1.7s** end to end, against roughly 2s for the Claude
path it replaced. A burn of a few sentences has nothing to reason about, so a
thinking budget buys latency and no quality. Three things hold that, and
`check:provider` holds all three:

1. **The default model does not reason.** The 4.20 family is the one that ships
   an explicit `-non-reasoning` variant, which is why the default crosses
   families rather than staying on 4.6.

   **A correction worth keeping, because the wrong version of it was committed
   here first:** an early roast took **23.4 seconds**, and this file briefly
   blamed `grok-4.6` for it. That call never reached xAI — `GROK_API_KEY` wasn't
   named what the function reads, so `trashTalkProvider("")` returned `claude`
   and Claude served it, evidently retrying under load. **`grok-4.6`'s real
   latency on this workload has never been measured.** Don't cite 23.4s as
   evidence against it; measure it if you want it.
2. **`GROK_TIMEOUT_MS` bounds the wait**, via `AbortController`, after which
   Claude writes the roast instead. A timeout is **never retried** — retrying it
   three times multiplies the very latency it exists to bound, which is worse
   than having no timeout at all. It is deliberately *not* applied to the Claude
   call: Claude is the fallback of last resort and aborting it leaves nothing to
   return.
3. **The angle retry is a second full model call**, so it is skipped when the
   first one already spent `ROAST_RETRY_BUDGET_MS`. That was half of the 23
   seconds. It also only fires when the roast carries *none* of the angle's
   content words — see "The typed angle is a springboard" below. A roast that drops the typed angle is worse; a roast that takes half
   a minute is a worse *feature*, and the sender can retype and regenerate.

`RETRY_BACKOFF_MS` exists so the gate can exercise the retry paths without
sleeping through real backoffs — three of those tests at production spacing put
~13s of pure waiting into `npm run verify`. The test squashes it to 1ms and
asserts the *shipped* default is still ≥500ms, so production spacing can't be
squashed along with it.

**Deploying this function before the secret exists is a no-op.** That ordering is
deliberate — `trashTalkProvider("")` returns `claude`, so the code can ship and
sit inert until `GROK_API_KEY` is set in the Supabase dashboard. Remember an edge
function only goes live on a Supabase deploy, not on a git push.

**The gloves-off rule is a SUFFIX on the system prompt, never a flag through
`buildTrashTalk`.** `buildTrashTalk` rolls a random angle, a random rhetorical
form and a freshness seed; if Grok fails mid-request the handler falls back to
Claude by re-sending *the same user turn* with `unfilteredRule(...)` stripped off
the system prompt. Threading a flag in would mean rebuilding, which re-rolls all
three and throws away the framing the first attempt was given. `check:provider`
asserts the unfiltered prompt is byte-for-byte the filtered one plus the rule.

**The fallback is deliberate: a tamer burn beats no burn.** Roasts are generated
while someone watches a spinner on a live card, so a Grok outage degrades to
Claude rather than erroring. The response carries `provider`, `model` and
`fellBack` so a roast that reads oddly polite can be traced to that instead of
being debugged as a prompt problem — the client only reads `breakdown`.

**The floor is one line — no slurs — and it is about words, not topics.** No
subject is off-limits; the rule names specific words and nothing else. Two
earlier bans came out because they were confiscating ordinary roast material: a
blanket "don't touch race, religion, sex, gender, disability or sexuality"
(which caught jokes about someone's looks and any joke about AB and Tristin
being married), and "no threat meant literally" (which contradicted the comedic-menace
shape this same prompt offers as a rhetorical form). `check:provider` asserts
the slur line survives *and* that neither ban has crept back — a prompt tweak
aimed at making roasts rawer should not silently re-tighten the floor either.
Worth knowing when weighing where it sits: the sender reads the roast on screen
and taps send, so this governs what gets **generated**, not what reaches a phone.

**The typed angle is a springboard, not a script — and the roast is a riff,
not a one-liner.** Both used to be clamped hard because of Claude: it kept
trading a typed angle for its own tamer burn, so the prompt demanded the
sender's words back near-verbatim and `usesAngle` retried unless ~60% of them
survived; and the cap was one or two sentences under 30 words. On Grok neither
fight exists, and both clamps made the roast read like the sender's line
parroted back. Now the angle must be what the roast is *about* — the model may
reword, exaggerate and build on it — and the cap is two to four sentences under
70 words. `usesAngle` passes on a single content word, so it only retries a roast
that walked away from the angle entirely; raising that threshold again would
reject exactly the reworded riffs the prompt asks for. `check:prompt` holds all
of this, including that the verbatim wording hasn't crept back.

**What the rule does NOT relax.** The length cap, `FACTS ARE STRICT` and the
signature rule are untouched by it, and `check:provider` asserts all three
survive.

**The roast's length has a hard bound in code, not just in the prompt
(`ROAST_MAX_CHARS`, 900).** It used to be safe to lean on the prompt, because
120 max_tokens could not produce more than ~480 characters and `send-push`
rejects a body over `MAX_BODY` (1600) — the headroom made the question moot.
`GROK_MAX_TOKENS` at 1000 ends that: ~4000 characters of prose clears `MAX_BODY`
easily, and the resulting failure splits the feature in half — `ai-breakdown`
returns 200, the sender reads a roast on screen, taps send, and gets a 400 they
can do nothing about. So the clamp runs server-side, **before** `enforceSignature`
so the trailing `— Persona` the client parses always survives the cut. 900 never
fires on a compliant roast (70 words is ~420 chars) and always leaves room for
the signature. `check:provider` reads `MAX_BODY` out of `send-push` and asserts
clamp + longest-possible signature still fits, so the two files can't drift.

**Never let an exception escape `callGrok` / `callAnthropic`.** A DNS failure,
TLS error or connection reset makes `fetch` *reject* rather than resolve with a
status, and a throw skips `callModel`'s fallback entirely — the fallback would
miss the exact shape a real provider outage takes. `fetchWithRetry` converts
transport errors into an ordinary failed `ModelReply` with `status: 0`, and
`readJson` does the same for a 200 whose body isn't the JSON expected.

**The reported `provider` describes the returned text, not the last call made.**
The angle retry can fail over to Claude and still have its output rejected,
leaving Grok's original text in hand — reporting `claude` there would point
debugging at the wrong model in precisely the fallback case this metadata
exists to diagnose. `textProvider` / `textFellBack` are snapshotted with the
accepted text and move only when `text` itself is replaced.

**The two APIs differ in exactly one structural way.** xAI is OpenAI-shaped:
bearer auth, the system prompt as a `role: "system"` message rather than a
top-level field, and the answer at `choices[0].message.content` instead of
`content[0].text`. Reading one with the other's accessor yields an *empty
roast*, not an error, which is why `check:provider` exercises both callers
against a stubbed `fetch` rather than trusting the shape.

## A picks read is paged, and a blind result sender fails loudly

UFC Fight Night: Prochazka vs. Stirling, 2026-11-21. Four players picked the
card. Of the first seven results, two sent no result push at all and four
reached only one side: the minority pick on four of them got none all card.
Every send-push call answered HTTP 200; nothing was red anywhere.

Two bugs, either one survivable alone:

- **scrape.py's result push read `picks` unpaged and unfiltered** (every UFC
  pick in one request). The table held 1,254 UFC picks; PostgREST returned an
  arbitrary 1,000. send-push rebuilds an anon caller's audience itself, so the
  scraper's read only decided which win/loss groups to ask for, and a group
  absent from its 1,000 rows was never asked for.
- **check-results was blind on any accented card.** It built the article
  title from the picks' `event_name`, which data.js stores ASCII-folded;
  "UFC Fight Night: Prochazka vs. Stirling" isn't a redirect to the real
  "Procházka" article, so it answered `{"events":1,"parsed":0,…}` at 16:14
  with four results already in data.js. scrape.py wasn't affected: it reads
  data.js's `slug`, which keeps the diacritics, and falls back to a search.

Found by comparing `notif_log` with the card's picks. The seven missed groups
(12 notifications) were sent at 18:34 through send-push's anon path, which
rebuilds each message from the committed data.js and reads its audience with
the service key. Fixed in #349 (paged scraper read, check-results search
fallback); the follow-up paged check-results' and the brief's reads, added the
`check:pickstore` gate on unpaged server reads, and made `scheduled-push.yml`
fail on a card check-results can't read.
