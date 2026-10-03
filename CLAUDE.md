# UFC Dashboard — working notes for Claude / contributors

A vanilla PWA: the app is **`index.html`** (HTML + inline CSS + ~5,600 lines
of inline JS) plus **`scoring.js`** (every function that decides a score — see
"One scoring rulebook" below), fed by **`data.js`** (the generated `EVENTS` array) and
served **raw from the repo root** to GitHub Pages. Backend logic lives in
**`supabase/functions/*/index.ts`** (Deno edge functions; `ai-breakdown` calls
the paid Anthropic API). Python (`scrape.py`) generates the data.

## ⛔ Before you commit or push ANY change, run `npm run verify`

Because everything is one inline-JS file, a single typo turns the whole app
into a blank white page for every user. Once, a break shipped mid-fight-card
and stayed live while people were using it. Don't let that happen again.

```
npm run verify
```

runs the full gate set (all fast, all local):

| script                | catches                                                        |
| --------------------- | ------------------------------------------------------------- |
| `npm run check:web`   | syntax errors in inline scripts / `sw.js`; broken/empty `data.js` |
| `npm run check:functions` | syntax errors in any Supabase edge function (incl. the paid one) |
| `npm run smoke`       | the app failing to **boot** — loads it headlessly and opens the leaderboard |
| `npm run check:tap`   | a tapped push notification not surfacing its message            |
| `npm run check:audience` | trash talk reaching the wrong people (roast targets vs. push recipients) |
| `npm run check:prompt` | a typed roast angle losing its place as the roast's subject, or the length cap drifting |
| `npm run check:provider` | the roast losing its unfiltered model, or analysis drifting onto it |
| `npm run check:dedup` | the three result senders drifting apart and double-pushing a fight |
| `npm run check:model` | the fight model posting a confident number off missing data |
| `npm run check:parlay` | a parlay priced with the vig left in, or a correlated ticket read as independent |
| `npm run check:names` | a fighter renamed mid-card silently unscoring picks made under the old name |
| `npm run check:intel` | a curated fight-week link landing under the wrong card |
| `npm run check:whatsnew` | the what's-new popup losing a backfill announcement or growing unbounded |
| `npm run check:prefs` | a restored notification pref lighting the bell with nothing subscribed |
| `npm run check:picks` | an account's picks not coming back to a device that lost them (or a stale row overwriting one) |
| `npm run check:kick`  | the scraper not being dispatched on a card day or in fight week |
| `npm run check:lock`  | a bout still pickable after the fight before it ended or its segment's opener started (or locked before then) |
| `npm run check:recap` | the post-card recap crediting a title, rank or score the board and belt don't |
| `npm run check:wrapped` | Year Wrapped reporting a rank, score, upset or reign the year-scoped board and belt don't |
| `npm run check:locks` | a 🔒 lock scoring differently on the board, belt or challenges, legacy stars scoring, or a third lock on a card |
| `npm run check:lab`   | the Fight Lab scoring differently from the board, reading a result it claims to predict, or failing to boot |
| `npm run check:fightbot` | FightBot's MCP stream corrupted by stray stdout, a tool crashing the session, or its standings drifting from the board |
| `npm run check:brief` | the Friday Fight Week Brief push firing at the wrong time, twice, after the bell, off the Lab's numbers, or not at all |
| `npm run check:swap` | a pulled bout's pickers not told, told twice or after it locks, a rename announced as a replacement, or the alert reaching anyone else |
| `npm run check:iq` | the AI Fight IQ write-up stating a number it wasn't given, drifting onto Grok, repeating one voice, or escaping its daily cap |
| `npm run check:guide` | FightBot's app guide stating a scoring rule scoring.js doesn't, sending people to a button that's gone, drifting onto Grok, or taking unbounded input |
| `npm run check:verdict` | FightBot's call on a Tale of the Tape or Fight Night Report stating a number it wasn't given, spending AI without a tap, or the tape poster failing to draw or share |
| `npm run check:parity` | any score moving during the engine migration: board, main-card board, per-card, Belt lineage, recaps, Year Wrapped |
| `npm run check:promotion` | a picks query without `promotion=eq.ufc`, letting another sport's picks onto the UFC board, Belt, restore or result pushes |
| `npm run check:sports` | the sport switcher showing with nothing to pick, a PFL pick saved untagged or after its lock, another sport scored on the UFC board, or its board drifting from `pickPts` (method, 🔒, underdog) |
| `npm run check:rooms` | a room's board scoring differently from the main board, an anonymous device joining a room, or an invite link re-joining / re-prompting |
| `npm run check:bundle` | send-reminders running last release's Lab code (a stale `_shared/lab-bundle.js`), or `parseDataJs` reading data.js differently from running it |
| `npm run check:picklock` | the database accepting a pick, a changed pick or a deleted pick after its bout locked, or from an anonymous session; send-reminders writing lock times off the app's rule; anyone else's pick readable before its bout locks |
| `npm run check:pushauth` | a push sent with text or an audience the server didn't build, a user sending as someone else, or the anon key sending anything but the rebuilt backups |
| `npm run check:html` | scraped, user or other-process text (a card name, a nickname, a status file) reaching `innerHTML` instead of `textContent` |
| `npm run check:photos` | a fighter photo lookup missing a disambiguated page, showing a same-named non-fighter's face, caching a miss forever, or a view without photos |
| `npm run check:safety` | a report readable or filed as someone else, a block the blocked person can see or undo, a blocked pair able to challenge each other, the app showing a blocked player's challenges, or the privacy policy unlinked |
| `npm run check:delete` | Delete my account leaving the login, a challenge or any other row of the caller's behind, or touching anyone else's |

**Never push a change that fails `verify`.** If you touched `index.html`,
`data.js`, `sw.js`, or a function, verify is mandatory — not optional.

First run needs dev deps: `npm install` (browser download is skipped if
`PLAYWRIGHT_BROWSERS_PATH` is set; otherwise `npx playwright install chromium`).

## Deploys are gated on the same checks

Pushing to `main` deploys automatically, so the gates also run in CI and
**block the deploy on failure** — a broken build can't reach production:

- `.github/workflows/pages.yml` → GitHub Pages. `deploy` **needs** the
  `validate` job (the `validate-web.yml` reusable workflow = the checks above).
- `.github/workflows/deploy-functions.yml` → Supabase. `deploy` **needs** a
  `check:functions` + `check:provider` gate. Every deploy line carries
  `--use-api` (server-side bundling): without it the runner pulls Supabase's
  build image from ghcr.io, whose shared rate limit failed four deploys in a
  row on 2026-09-23. Keep it on any new function's deploy line.
- `.github/workflows/ci.yml` runs everything on every push/PR for visibility.

CI is a backstop, not a substitute: run `verify` locally first so you never
spend a debug cycle discovering a break in CI (or worse, in prod).

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

**The gate reads the COMMITTED `data.js` (raw.githubusercontent, `main`), never
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
fixtures relative to it. To audit: rerun the suite with `Date` / `datetime`
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
- **A run must finish inside the 5-minute dispatch.** `update.yml` cancels an
  in-progress run when the next one arrives, so a run that outlasts it commits
  nothing and the next starts the same work over: a loop. The stats loop is
  capped at `STATS_FETCH_BUDGET_S` (60s); gaps (`stats_gap`: nothing cached, or
  an imminent card's missing record / failed fetch) go first and get
  `STATS_GAP_BUDGET_S` (120s), still a hard stop for a UFCStats outage, and
  the rest of a backlog drains across runs. Fight day stays urgent past UTC
  midnight (`stats_days_out` counts calendar days; -1 covers a US night card). Without it, #258's one-time `res`
  backfill froze every data update, the UFC card's included, for 7 hours on
  2026-10-03. Any new per-run backfill needs the same kind of cap.

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

## Fight Week Intel costs nothing — keep it that way

`intel.py` builds `intel.json`: curated interviews, breakdowns and camp pieces
for the upcoming card, rendered as a collapsible section under each event.

The whole feature rests on one premise — **it spends no metered budget**:

- sources are free public RSS/Atom feeds (no key, no quota), parsed with the
  stdlib, matched to fighters by string comparison. No model call, no Odds API
  call, no new pip dependency.
- the output is a **static JSON file committed to the repo**, not a Supabase
  table. A table would charge a DB read on every page load, forever, for content
  that changes twice a week and is identical for every user. A committed file is
  free to serve, free to cache, survives Supabase being down, and shows up in a
  diff. Don't "upgrade" it to a table without a reason that beats all four.
- it runs inside the existing `update.yml` job. No new workflow, no new schedule.
- `should_fetch` gates it the way `should_fetch_odds` gates odds — nothing
  outside `INTEL_WINDOW_DAYS` of a card, then every 8h (3h inside fight week).
  Feeds are free, but a pull on every 5-minute fight-night run would add a commit
  to each one. `INTEL_FORCE=1` bypasses it.
- **A card stays eligible through its own fight night.** `today` is UTC and US
  prime-time cards run past UTC midnight — a Saturday 21:00 ET main card is
  01:00 UTC Sunday — so the window runs from `-WINDOW_PAST_DAYS` (2), not 0. The
  app-side cutoff in `makeEventBlock` uses the same `2*DAY_MS` as `render()`'s
  event-visibility filter. Both bounds are one decision: a shorter one deletes
  the section an hour before the main card while the event block stays on
  screen. `check:intel` asserts they match — anchored inside `render()` and
  `makeEventBlock()`, because `index.html` carries four copies of that filter
  line and an unanchored search reads the wrong one.
  Expiry is an **exact timestamp** (`not_expired`), not `days_out >= -2`:
  whole-calendar-day arithmetic kept a card a full day longer than the client
  showed it, and since `curate()` dedupes URLs across events in date order, a
  card nobody could see would claim a shared article and leave the upcoming
  card — the one being read — empty.
- **A changed card outranks the interval.** `card_fingerprint` (slug + date +
  roster) is stored in `intel-state.json`; when it moves, the interval is
  bypassed and the set is rebuilt now. A late replacement is exactly the thing
  that lands mid-window, and waiting 8h for it means showing intel about someone
  who has withdrawn, during the days people actually read it.

Two rules that aren't stylistic:

- **Link out; never rehost.** `blurb` is capped at `BLURB_MAX` (220) characters of
  the feed's own summary, in the curator *and* again at render. The section is a
  pointer to the publisher's page.
- **The app treats `intel.json` as untrusted.** `intelItemsFor()` re-validates
  every item against the card being rendered: off-card fighter tags are dropped,
  a bucket whose date doesn't match its event is dropped whole, and only absolute
  `https://` links become an href. String matching's failure mode is
  mis-attribution, and an interview about a different Silva shown under tonight's
  main event is the app stating something false about a fight people are picking.
  `npm run check:intel` holds that contract.

**`check:intel`'s cross-check against `data.js` is advisory — keep it that way.**
The fixture assertions fail the build; the block comparing the committed
`intel.json` to the committed `data.js` only reports. It runs in
`validate-web.yml`, and `pages.yml`'s `deploy` **needs** `validate`, so a failure
there stops the site from publishing — live results included. Drift between those
two files is normal and self-healing: `scrape.py` rewrites `data.js` every five
minutes while the curator is cadence-gated, so any replacement or date move
leaves the file briefly stale. Failing on it would block a deploy for a data gap,
which is the WARN/BLOCK rule above, violated. Nothing is lost by reporting
instead: the app drops those items at render anyway. The test asserts against its
own source that no `fail()` creeps back into that block.

A dead feed is reported, not swallowed: per-feed HTTP status lands in
`intel.json`'s `sources` block and a `::warning::` in the run log.

## What's New popup — add an entry per shipped feature

`index.html`'s `WHATS_NEW` array (inside the `whats-new:start`/`:end` marker
block) drives a short highlights popup, shown once per browser when there are
entries it hasn't checkpointed.

**When you ship a user-facing feature, append ONE entry** — `{id, emoji,
title, desc}`, `id` as `YYYY-MM-DD-slug`, appended at the end so ids stay
ascending. Never edit or remove a past entry: its `id` may already be the
checkpoint a browser's `localStorage` (`ufc_whatsnew_seen`) is holding.

**A checkpoint-less browser is shown everything, not baselined silently.**
`seen===null` covers two different browsers — a brand-new install, and an
existing user whose browser simply predates a given entry — and both get the
same (capped) list. Baselining silently would mean nobody who already had the
app installed before a feature shipped ever hears about it. Only once a real
checkpoint exists do the older entries stop showing. Always capped at
`WHATS_NEW_MAX` (5), so neither a long-dormant browser nor, eventually, a
large array shows an unbounded backlog — dismissing checkpoints the newest
entry currently defined, not just the newest one shown, so entries the cap
pushes out of view still clear.

Fires once per boot, ~1.2s after the initial `render()`, and **waits** while
a real overlay is open or a notification tap is on its way — a tap-driven deep
link (trash talk, challenge inbox) always goes first, and the popup follows
once it's closed. It used to skip outright, which is half of how a user lost a
roast to it: a tap that landed *after* the popup was already up got buried.
Now `_routeTap` steps an open popup aside **without checkpointing** and
`checkWhatsNew` re-checks every 1.5s until the way is clear, so the user gets
both.

**A tapped roast survives a reload.** The other half: opening the app from a
push right after a deploy installs the new service worker, whose
`controllerchange` reloads the page — and the `ufc-tap` stash was already
consumed by the first load, so the reload came back empty with What's New in
the roast's place. `pagehide` now hands a still-live tap (not yet shown, or
its sheet still open) to the next page through `sessionStorage`
(`ufc_tap_replay`); a fresh tap in the stash or URL always wins over it, and a
roast the user closed is never replayed. `npm run check:tap` holds all of
this, mutation-tested. "Real overlay" means listed in `_escClosers`
(the same array Escape-to-close trusts), checked by `_anyOverlayOpen()` —
**never** a blanket `.open[id]` DOM query. Several ordinary, persisted UI
states (`#activityFeed`, restored `.open` from `localStorage` on every boot
once a user has ever expanded it once; a per-card "N more fights" body) also
carry both an id and an `open` class without covering anything, and a
blanket match silently blocked the popup forever for anyone who'd triggered
one. `npm run check:whatsnew` holds the backfill and cap invariants above,
`WHATS_NEW`'s own shape, and this exact regression.

**Only "Got it" or the X dismiss it — no backdrop-click, no Escape.** A user
reported it closing on an outside tap before they'd read it, which defeats
the entire point of a feature-announcement popup. `#wn-overlay` carries no
`onclick` handler and is deliberately absent from `_escClosers`. Don't add
either back without a way to guarantee the checkpoint still only advances on
an explicit dismissal.

**That means focus management is load-bearing, not cosmetic.** `#wn-overlay`
sits at the very end of the DOM, after every fight card's buttons. With
Escape and backdrop-click both gone, a keyboard/screen-reader user whose
focus was still on the underlying page when this auto-opens would have to
tab through the entire app body to reach either control — effectively
stranded. `renderWhatsNew` moves focus onto "Got it" on open; `_wnTrapFocus`
(wired to `#wn-panel`'s `onkeydown`) keeps Tab/Shift+Tab cycling between the
X and "Got it" instead of escaping into the page; `closeWhatsNew` restores
focus to wherever it was. `npm run check:whatsnew` holds all three,
mutation-tested individually.

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

## A PPV runs three segments, and each one is a lock clock

A numbered PPV airs early prelims 5pm / prelims 7pm / main card 9pm ET; a Fight
Night airs two segments. `index.html` locks a bout when **its own** segment
starts, so the segment label is not cosmetic — it decides when picks close.

The event model carried only `time` and `prelimTime`, so early-prelim bouts
answered to the 7pm prelim gate: from their own 5pm opening bell until their
result landed in `data.js` they stayed pickable, and you could back a fight you
were watching. UFC 331 shipped three bouts that way. `earlyPrelimTime` is now
the third clock, derived from the *resolved* prelim time (`_EARLY_PRELIM_LEAD_H`)
so a card whose prelims move takes its early prelims along, and written only for
PPVs — inventing one for a Fight Night would lock its prelims two hours early,
the same bug pointing the other way.

**The opposite error is the older one.** Locking every bout the moment the first
segment starts made the main event unpickable hours before it ran, beside a
countdown still counting down to it. `npm run check:lock` asserts both
directions at all three boundaries, and is mutation-tested against each half.

Which bouts sit in which segment is first inferred from **bout order**
(`parse_upcoming_card` throws Wikipedia's section headings away;
`_MAIN_CARD_SIZE` and `_PRELIM_CARD_SIZE` pin the 5 / 4 / rest shape), then
corrected from UFC.com's own split when a fresh reading exists: see the next
section.

## One fight at a time, and nobody sees a pick before it locks

Since 2026-10-04 a segment's bell locks only its **opener**; every later bout in
the segment locks when the fight before it has a result (`fightLocked`). Locking
the whole segment at its bell closed a fight three bouts away while the opener
was still walking out (Jordan, UFC 332). Running order is `scoring.js`'s
`segmentRunOrder` (a segment runs in **reverse** array order, since `ev.fights`
is main event first) and "over" is `boutDecided` (a winner, or `state:"post"`
for a draw / NC); `send-reminders` uses the same functions from the bundle.

Results reach `data.js` minutes after a fight ends, so the app can never lock
at the real bell; it locks at the previous result instead. Backstops, all held
by `check:lock` / `check:picklock`:
- **`lockRows` writes the server's time**: the first run that saw the previous
  result (kept from what it wrote last run, `prior`, so it never drifts to
  "now"), and never later than `LOCK_CHAIN_MS` (45 min: a five-round fight plus
  walkouts) after the bout before it locked. The app reads those times
  (`_loadServerLocks`, `pick_locks` readable since 0017) and honours them.
- **The next segment's bell** locks everything before it.
- **A later bout already decided** locks every bout before it, so a fight that
  never gets its result can't hold the rest of the segment open.
- A bout a card doesn't list answers to its segment's bell, as before.

**Because picks stay open longer, nobody else's pick is readable until that
bout locks** (`0017_picks_hidden_until_lock.sql`): the owner always reads their
own rows; anyone else only once `pick_lock_for(...) + LOCK_GRACE` has passed
(the grace, or someone could read the room and still write within it), or for a
card more than 2 days old. Our functions read with the service key; that is
why the fight change alert's picks read moved off the anon key. The nickname
check reads through `nickname_taken()` instead of other players' picks. In the
app: Ranks shows 🙈 for someone's main-card pick that hasn't locked, and the
group-split bar shows only once a bout locks. **Any new feature that shows
other players' picks before a fight locks will come back empty**; that is the
point, not a bug. The migration is applied by hand, before the app ships.

## Card clocks and segments come from UFC.com

scrape.py's own clock is a guess: slot tables (`_default_main_time`,
`_INTL_REGION_SLOTS`), ESPN's event `date` for international cards (sometimes
the main card, sometimes the first prelim), and hand-written `_TIME_OVERRIDES`
pins. Its segment split is a guess too: bout order against `_MAIN_CARD_SIZE` /
`_PRELIM_CARD_SIZE`. UFC 332 went to CBS at 20:00 ET while the PPV slot said
21:00, and two Fight Nights ran six-bout main cards the split cut to five, so a
main-card bout would have locked at the 5pm prelim bell.

`official_times.py` reads each card's UFC.com event page (every segment's start
timestamp, the bouts listed under each) into `official-times.json`. It runs in
`update.yml` **before** `scrape.py` (free, no quota, `continue-on-error`,
re-read every 1h within 2 days, 3h within a week, 12h out to 21 days;
`OFFICIAL_TIMES_FORCE=1` bypasses that). A failed read keeps the last good
reading; an empty segment block beside populated ones (a Fight Night's
early-prelims placeholder) is dropped.

`scrape.apply_official_times` then overrides the guess when the reading is
fresh (`OFFICIAL_MAX_AGE_H`, 48h): its clocks replace main / prelim / early, but
only a clock on the card's own ET date (the app pins every clock to `ev.date`),
and its split relabels any bout in the wrong segment, but only when it names
`OFFICIAL_MIN_MATCH` (60%) of our bouts, and never the Main Event or Co-Main.
Bouts match on full names, then on a surname pair only if it is two different
surnames naming one bout (`health.bout_segments` / `segment_of`, shared by the
scraper and the checks). With no fresh reading the guess stands, unchanged.

`health.py` still compares the published card with the reading, as WARNs on
the data-health issue (never BLOCK: a wrong clock is a data gap, and blocking
would freeze live results):

- `time-mismatch`: a segment clock differs (whole instants, date and clock),
  saying whether picks lock late or early
- `segment-mismatch`: a bout's label disagrees with UFC.com's split
- `time-unconfirmed`: a card within 7 days with no reading, or a reading
  missing a segment the card runs
- `time-stale`: a card within 2 days last confirmed more than 24h ago

After a fresh reading these should be quiet; one that persists means the
scraper refused the reading (stale, wrong date, too few names matched). The
guess tables and `_TIME_OVERRIDES` stay as the fallback for a card UFC.com
hasn't published yet or a run where it can't be read; don't add new pins for
a card UFC.com lists. `tests/test_official_times.py` holds the parser, the
scraper's use of it and the checks (mutation-tested, clock pinned).

## The database enforces the pick lock too

The app's `fightLocked` only stops the app. `0010_picks_lock.sql` adds the
`picks_enforce_lock` trigger, so a direct REST call can't do it either. For
anon/authenticated callers, once a bout's lock time plus `LOCK_GRACE`
(5 minutes) has passed (since `0012_sport_pick_locks.sql` **every promotion is
held to it**, each against its own lock times: see below):

- **INSERT is skipped** (returns NULL), never an error: `syncPick` upserts, and
  one late row must not fail the rest of a batch. An upsert on a locked bout
  therefore never reaches its UPDATE half.
- **UPDATE keeps** the pick, method, 🔒, bout and owner as they were; anything
  else (the nickname rename across every row) still applies.
- **DELETE is skipped**, so a losing 🔒 can't be deleted to dodge its −1.
  "Delete account" goes through the `delete_my_picks()` RPC, which runs as the
  owner and so is let through.
- `bonus_pick` freezes at the card's first bell.

**The lock times come from send-reminders**, because the card lives in
`data.js`: every run, `lockRows` writes each nearby card's per-bout times to
`pick_locks` (names lower-cased and sorted) and its bells to `card_bells`, by
the app's own rule (one fight at a time: see above) and the bundled
`isMainCardBout` / `isEarlyPrelimBout` / `segmentRunOrder` / `boutDecided`. A
bout with no row falls back to its card's **first** bell; a card with no row at
all locks at midnight ET after its date. So a broken sync fails open only until
the card is over, and a past card is always locked. First, not last: rows match
on lower-cased trimmed names, but `nmKey` also forgives accents, hyphens,
suffixes and inner spacing, so a respelled name finds no row yet still scores.
The app always writes `data.js`'s exact names, so real picks match their row.
An UPDATE moving a row to another promotion is judged against **both**
promotions' lock times, so a locked pick can't be moved and then deleted. Our
own functions (service_role) and the SQL editor bypass the trigger. A phone that was offline
through the bell loses the picks it never uploaded: that trade was accepted
when this shipped (2026-09-27). `check:picklock` runs the real migration in
PGlite (Postgres in WASM), mutation-tested.

**PFL, RIZIN and DWCS are policed the same way, from their own tables.** Until
2026-09-29 the trigger skipped every non-UFC row ("other sports keep their own
client-side lock"), which was tolerable while they scored one point a win and
stopped being once method and 🔒 scored (Codex on #228: a direct REST call after
a result could rewrite the board). `0012` adds `sport_pick_locks` and
`sport_card_bells`, keyed by promotion, and `pick_lock_for(promotion, …)` picks
UFC's function or `sport_pick_lock_at`, with UFC's fallbacks (the card's bell for
an unmatched name; midnight ET after the date for a card with no row; `-infinity`
for a date it can't read). **They are new tables, not a promotion column on
`pick_locks` / `card_bells`**: those primary keys are the `ON CONFLICT` targets
the live UFC upsert uses, and changing them breaks it until the function is
redeployed. The times come from `send-reminders`' `sportLockRows`, which reads
`events-extra.json` (JSON only, validated by the bundled
`PickEngine.validateFeed`, the app's own validator) and computes each card's
instant with `sportLockAt`, the app's `sportLockMs`: the feed's `time` in ET, else
`SPORT_LOCK_UTC_H_BY`. **That table of hours lives in `index.html` and in
`send-reminders`; `check:picklock` lifts the app's and fails if they differ**, over
every promotion, both DST offsets and with or without a `time`. A feed card has one
segment, so all its bouts lock together. Two promotions can hold the same two
names on one date independently; `bonus_pick` stays UFC-only. Deploy order doesn't
matter (no rows yet means the fallback; a function deployed first just gets a 404 on
the new tables and reports it in `sportLocks`), but **the migration is applied to
Supabase by hand and the function needs a Supabase deploy**, not just a push.

## Picks are for email accounts

Anyone can browse, but only an email-linked account can write a pick
(`0015_picks_require_account.sql`: `picks_insert` / `picks_update` need
`is_account()`, the same test rooms use). Anonymous sign-up stays open, since
the app needs a uid to read with, so before this a stranger could put a nickname
and a pick on everyone's board in two taps (one did on 2026-09-30, from a VPN).
In the app, `checkName` calls `_pickNeedsAccount` first, so a pick tap without
an email opens "Sign In to Pick" and `_postSignIn` finishes the tapped pick
(asking for a name first on a new account). Lock, method, bonus and the sport
view's lock/method are gated the same way, since an anonymous device may still
hold picks from before the rule. Linking keeps the `user_id`, so an anonymous
player's old rows still score and become editable again once linked. A token
minted before the link still says anonymous, so `_accountToken` refreshes it
before a pick write. DELETE of your own row stays open. `check:picklock` holds
the policy and the gates, `check:sports` the anonymous tap. The migration is
applied by hand.

## Locks 🔒 ride in the old `confidence` column — and only count from `LOCKS_START`

A lock is +1 on a winner, −1 on a loser, on top of whatever the pick earns;
two per card, closing with the bout's own segment. It is stored as
`picks.confidence > 0`, the column the retired 1–3 "confidence stars" wrote to.
Those stars never scored, and old cards are full of them (one player starred
seven bouts on a card), so `isLockPick` ignores anything dated before
`LOCKS_START` — drop that gate and every past standing and the belt's
history rewrite themselves. Every per-pick scorer goes through `pickPts`;
the board sums `u.lockPts` into `userPts`. The cap lives in two places, never in
scoring: `toggleLock` in the app, and the `picks_cap_locks` trigger
(`supabase/migrations/0005_picks_lock_cap.sql`) for two phones on one account.
The trigger **clamps** a third lock to 0 rather than rejecting the row —
`syncPick` upserts pick, method and lock together, so a rejection would drop
the pick over a lock that was never going to count. Its date must match
`LOCKS_START`. `npm run check:locks` holds all of this.

## Fight Lab, the pick engine and FightBot are readers — keep them that way

`lab.html`, `lab/*.js` and `fightbot/` never write a pick, a lock or a pref. They
score through `PickEngine.loadKernel`, which runs **`scoring.js` whole** and lifts
only the fight model and the two intel filters out of `index.html` by their
`// name:start … :end` markers, so **renaming a scoring function or one of those
markers breaks the Lab and FightBot** — `check:lab` / `check:fightbot` will say
so. Never paste a copy of scoring into them to "fix" that; the whole point is
that they can't drift from the board. Architecture, the curated-feed format for other
promotions, and the analytics' leak guards: `docs/PICK-ENGINE.md`.

**The Lab wears the app's theme the same way: lifted, not copied.** `lab.html`'s
`appThemeCss` takes the colour variables from index.html's `:root` and
`body[data-theme|data-season="…"]` rules at load (caching them so the next visit
paints themed before the fetch), so a new or recoloured theme reaches the Lab
by itself. Keep themes as plain `body[data-theme="x"]{--var:…}` rules for that
to keep working; `check:lab` compares the resolved colours app-vs-Lab for every
theme.

**Since migration stage 2, `lab/engine.js` also runs inside the app itself**:
`index.html` loads it and answers every bout lookup through it
(`_boutLookup` → `_appEngine`). A change to `lab/engine.js` is an app change:
run `verify`, bump `SW_VERSION`. The app never *depends* on it, though: if it
fails to load, `_boutLookup` falls back to the original loops, `check:parity`
proves both paths produce identical scores, and `check:lab` boots the app with
the file 404ing.

## The Friday Fight Week Brief push

`send-reminders` (already on the 5-minute `scheduled-push.yml` cadence) sends one
`brief` push per card, **Friday 19:00 ET** before it (`BRIEF_HOUR_ET`), within a
4-hour window because GitHub's scheduler runs late (`BRIEF_WINDOW_MS`), and never
after the card's first bell. Audience is everyone with the 🔔 bell on — on by
default, no separate toggle. `notif_log` dedups it on `(event_date, "brief")`.
It taps through to `./lab.html#week`: `send-push`'s link allow-list admits
exactly that page by tab, and `sw.js` navigates to it instead of stashing an
empty tap for `index.html`. The copy is composed by the Lab's own code; if that
fails it still sends a plain teaser — never nothing. `check:brief` holds all of
it, mutation-tested.

**send-reminders never runs code it fetched.** It holds the service-role key,
so it used to be one Pages change away from handing it out: it fetched
`lab/*.js`, `scoring.js` and `index.html` and ran them with `new Function`, and
ran `data.js` the same way. Now the Lab code is **bundled**
(`supabase/functions/_shared/lab-bundle.js`, generated by `npm run build:fn`
from the same sources and the same `loadKernel` slicing), and `data.js` is read
by `_shared/datajs.js`'s `parseDataJs`, which accepts only the literals
`scrape.py` writes and throws on anything else. Only JSON (`odds-series.json`,
`intel.json`) is fetched besides `data.js`. **After changing `lab/engine.js`,
`lab/analytics.js`, `scoring.js` or a lifted `index.html` block, run
`npm run build:fn` and commit the bundle**: `check:bundle` fails until you do,
and the change reaches the brief only on a Supabase deploy.

## send-push sends only what it can vouch for

The anon key ships in `index.html`, so it proves nothing, and it used to be
enough to push any title and body to every subscriber. Now each caller is one of:

- **service**: our own functions (`check-results`, `send-reminders`) send
  `X-Service-Key: <SB_SERVICE_ROLE_KEY>` and are trusted as given. The key rides
  in its own header so `Authorization` keeps the anon key the gateway expects.
  `brief` and `swap-*` are service-only: their copy can't be rebuilt.
- **user**: a session JWT checked against GoTrue. Social pushes (`pick-*`,
  `nudge-*`, `chal-*`, `chal-resp-*`, `trash-talk-*`) are sent **as the verified
  sender only**, with server-written text: a challenge is read from its row
  (only its challenger announces it, only its target accepts it), a nudge must
  name its sender and one target (≤3 a day), and a roast's text is the
  sender's but its title names them. Per-sender cap `SENDER_LIMIT`/hour.
  **And only from an established player**: UFC picks on `SOCIAL_MIN_CARDS` (2)
  real cards (dates `data.js` lists) dated ≥2 days ago, else 403 (503 if
  `picks` or `data.js` can't be read: fail closed). Only real dates: a pick on
  a made-up date isn't refused, just locked at midnight after it. Anonymous sign-up is open, so a JWT alone lets a stranger mint an
  account and put their own text (a roast, a nickname, a stake) on every
  phone. The pick lock makes that history impossible to backfill. Don't
  loosen it to "has any pick": a pick on tonight's card is free.
- **anon**: may only trigger `main`, `prelim` and `result:*`, the app's backups
  for the cron senders. The server rebuilds them from the committed `data.js`
  (read with patterns in `parseCards`, never executed) and reads a result's
  audience from `picks` itself; a result `data.js` doesn't have yet is a 409
  (check-results sends it once it lands).

The app sends through `_pushPost`: session JWT first, one retry with the anon
key on a 401 (a Pages deploy running ahead of the function deploy, or an
expired token). `check:pushauth` runs the real handler and holds all of it.

## Fight change alerts: a vanished bout tells exactly who picked it

Picks are stored by fighter name, so a withdrawal leaves every pick on the old
bout matching nothing: it silently never scores. `send-reminders` (5-minute
cadence) now compares each upcoming card's UFC picks with `data.js` and sends
one `swap-<old bout>` push per vanished bout (`notif_log` dedups it), **targeted
with `include_user_ids`** at the people who picked it and haven't already
re-picked the new bout. It names who is out and who now faces whom, or says the
bout was cancelled. Three guards, all held by `npm run check:swap` (mutation-tested):

- **Name matching is `scoring.js`'s `nmEq`/`nmBout`**, from the bundle, plus
  `looksLikeRename` (one name inside the other with ≥2 shared tokens, or same
  surname + first initial), so a rename is never announced. One shared token is
  NOT a rename: "John Smith" → "John Doe" is a real replacement.
- **A bad parse takes most of the card**: more than `SWAP_MAX_PER_CARD` (3)
  vanished bouts that also outnumber the picked bouts still on it sends nothing
  for that card. Never a bare count: old picks on a vanished bout never go away,
  so every past change would count against the next real one.
- **The picks read is paged** (1,000-row PostgREST cap). A partial audience is
  unrecoverable: `notif_log` then dedups every later run away from the missed.
- **Nothing after the new bout's own segment locks** (a cancellation: after the
  card's first bell). A card is watched until its last segment starts.

**Never send a swap push with an empty `include_user_ids`**: `send-push` treats
an untargeted push as a broadcast to every subscriber.

## The Fight IQ write-up states only numbers it was given

The Lab's ✍️ scouting report (`ai-breakdown` action `fight-iq`) is prose around
the deterministic Fight IQ the browser already computed — the model never does
arithmetic. `numbersInvented` rejects any figure in the reply that isn't in the
facts sent (bare 1–3 excepted, for "top 3"); one retry names the strays, then
it fails with a 502 rather than ship a made-up record. The voice is picked at
random from `IQ_TONES` per request. Cost is bounded three ways: 3 per device per
day in the Lab (`IQ_WRITEUPS_PER_DAY`), `IQ_DAILY_CAP` per account per day on the
server (lasting, see below), and the existing per-IP / global rate limits;
inputs are capped (`MAX_IQ_LINES`, `MAX_IQ_LINE`).

**Every ai-breakdown call is a signed-in account spending its own budget.**
The anon key identifies nobody, so the function requires the caller's session
JWT (checked with GoTrue; `REQUIRE_SESSION=0` is the outage escape hatch) and
takes from `ai_quota_take` (`0009_ai_quota.sql`): one atomic row per account,
UTC day and bucket, `all` (`AI_DAILY_CAP`, every action) and `fight-iq`
(`IQ_DAILY_CAP`). **An account is not a limit on its own**: anonymous sign-in
is open, so a fresh uid (and budget) is one signup call away. Every call also
takes from a lasting per-IP bucket (`AI_IP_DAILY_CAP`, right-most
X-Forwarded-For) and one global ceiling (`AI_GLOBAL_DAILY_CAP`), which no new
account resets. If that table can't answer, the in-memory caps decide: fail
to memory, never open. With `REQUIRE_SESSION=0` a session bearer is accepted
unverified (GoTrue may be what's down), and the IP and global buckets still
apply. A client-sent `viewerId` is ignored. The app sends
through `_aiFetch` (fresh token first); the Lab borrows the app's saved token
but never refreshes it (refresh tokens rotate, so that would sign the app out)
and asks the user to open the app once if it has expired.
It runs on `MODEL`, like the other analysis actions. `check:iq` holds all of it.

## FightBot the guide answers from APP_GUIDE, and APP_GUIDE is tested

⋯ More → FightBot Help (and Ranks → ℹ) is a chat that explains how the app
works: `ai-breakdown`'s `guide` action, on Claude, spending the same daily AI
budget as every other action. The description of the app it answers from,
`APP_GUIDE`, is written **server-side** in that function; the client sends only
the question, the screen and up to `GUIDE_MAX_TURNS` short earlier turns, each
bounded. The prompt forbids inventing a button, number or rule.

`APP_GUIDE` is a second copy of facts the app holds, so it can go stale, and a
stale guide misleads people about their own points. `check:guide` compares its
scoring numbers with `scoring.js`'s constants and the Ranks ℹ panel, and checks
every name in `GUIDE_UI_LABELS` appears both in the guide and in `index.html` /
`lab.html`. **When you ship a user-facing feature or rename a button, update
`APP_GUIDE`** (and `GUIDE_UI_LABELS` if FightBot should send people to it), the
same way you add a What's New entry. It is `ai-breakdown` code, so it goes live
on the Supabase deploy.

(Not to be confused with `fightbot/`, the MCP server; both answer as FightBot.)

**It talks fights too, from cached app data and cited web research.** Each question carries
`_botFightData()`: the next unfinished card (bouts, records, ranks as
`_fnRankLbl` shows them, odds, UFCStats lines), the last finished card's
results, then later cards, built from `EVENTS` / `FIGHTER_STATS` and filled in
priority order under the server's `MAX_CARD` (main-card stats outrank last
week's results). The server treats it as data, never instructions, and every
guide answer goes through `numbersInvented` against the guide, that data, the
user's picks and what the user said: one retry, then a 502. A fighter with no
rank is left without one, never called "unranked", and one with no fight data
gets no stats line, never a claimed 0. A failure building the data never stops
an app question.

`_aiFightContext()` now supplies query-focused completed UFC opponent lists from
all of FIGHTER_STATS, including fighters off the selected card, to Ask Claude,
FightBot Help and the lightning breakdown. Unique first/surnames are resolved;
ambiguous names are not guessed. Ask Claude sends bounded earlier turns too.
These lists are UFC-only and cached: absence is never proof of no MMA meeting.
The backend offers Anthropic `web_search_20250305` for fight chat, breakdown and
open-ended MMA guide requests (existing key and daily budgets, up to
`RESEARCH_MAX_SEARCHES` (3) searches per model attempt, one pause continuation).
**Those requests run on `RESEARCH_MODEL` (default `claude-sonnet-5-5`), not
`MODEL`**: on Haiku, "who has Natalia Silva lost to" came back as "the app data
doesn't specify, see UFCStats" with search available. An unknown research model
(404, or a 400 naming the model) falls back to `MODEL` with search kept and a
logged error; everything without search stays on `MODEL`. The rules require a
search whenever the supplied data doesn't fully answer, and forbid pointing the
user elsewhere instead. **The code enforces it too**: a search-enabled reply
that never searched and matches `puntsInsteadOfAnswering` ("the data doesn't
specify", "check UFCStats", "I can't verify") is re-run once with
`FORCE_RESEARCH_NOTE` in the user turn. Forced `tool_choice` would be cleaner
but is a 400 on the research model, so don't switch to it. Not retried when
search is unavailable on the key (the honest answer then *is* "can't verify"),
and a failed retry keeps the first answer. The research model always thinks and
thinking counts against `max_tokens`, so it gets `RESEARCH_MAX_TOKENS` (8000)
and `RESEARCH_EFFORT` (`medium`); 1600 would truncate into a 502. `FIGHTER_STATS[n].res` (scraper) holds each UFC bout's
result aligned with `opp` ("L KO/TKO R2 2025"), so who-beat-whom is answerable
from the cache; the app sends it only when the two arrays line up. It looks up missing historical facts and
returns citation links, rendered with textContent. Clearly app-only guide requests,
roasts, IQ and verdicts do not get search. Guide number checks include cited
source excerpts; unsourced invented and misattributed figures still fail. An
unfinished/truncated research response fails rather than displaying narration.
A search-specific invalid-tool/disabled-search error retries once without the
tool, answering from cached facts with the research limitation stated; unrelated
API errors do not trigger that fallback.
FightBot Help is a general MMA assistant: all promotions, unfamiliar fighters,
history, rules, judging, techniques and news are in scope, whether or not the
selected card or APP_GUIDE mentions them. Stable concepts use MMA knowledge;
missing/current factual claims use cited research. App facts still come only
from APP_GUIDE and supplied app data.
**Answers lead with the answer and stop.** "Recommend my main-card picks"
renders one line per bout (`renderMainCardSelections`: fighter, method,
confidence) and a closing "Ask why"; it used to append each pick's record, odds
and fight-by-fight history, which read as a stats dump. Reasons and numbers are
for the follow-up. The prompts say the same (`PICK_RECOMMENDATION_RULES`, the
guide's "Short and plain" rule, `FIGHT_RESEARCH_RULES`); `check:history` holds
the line shape and the rules.
FightBot MCP also exposes `get_fighter_history` with the same UFC-only caveat.
`npm run check:history` tests these paths with frozen fixtures and stubbed search.

**FightBot's call** (`ai-breakdown` action `verdict`) adds one AI line under a
room's Tale of the Tape and a Card Recap's Fight Night Report, only when tapped,
kept per session (`ufc_bot_calls`). It is told only the lines already on screen
(`tapeFacts`, the recap's title and stories) and gets the scouting report's
guard: `numbersInvented`, one retry, then a 502. **🖼️ Share poster**
(`drawTapePoster`) draws the tape as a 1080×1350 image in the browser, like the
Wrapped card: no AI, nothing uploaded. Both live outside the rooms block's
logic; `taleEl` calls them only if they exist, so the tape never depends on
them. `check:verdict` holds all of it (`check:verdict:fn` gates the function
deploy).

## One scoring rulebook: `scoring.js`

Every function that decides a number — name matching (`nmEq`), nickname identity
(`splitNick`), segment labels, `pickPts` / `userPts` / locks / the dog bonus /
method matching, the bout lookup, `_eventFinished` and the board scorer
`_lbScoreUsers` — lives **once**, in `scoring.js` (engine-migration stage 3),
along with the Belt (`computeBeltLineage`) and the one scoped entry point every
standings view uses, `boardStandings(rows, scope)` (stage 4; scopes `date`,
`through`, `before`, `year`, `mainCard`, `users`). Add a scope there rather than
passing `_lbScoreUsers` a new predicate. **Never name a local after a
`scoring.js` function**: it shadows the global inside that function (the first
name tried, `standings`, broke every card recap that way), and `check:lab`
fails on it. The
app, the Fight Lab, FightBot, the Friday brief and the tests all run that file;
nothing slices scoring out of HTML any more, and `check:lab` fails if any of
those functions is defined in `index.html` again.

**It is required, like `data.js`.** `index.html` loads it right after `data.js`;
`sw.js` precaches it and serves it **network-first** (it must always match the
`index.html` it shipped with, so it's treated as part of the page, not an
asset); and if it fails to load, both self-heal checks (the early one and the
render-failure one) run the same one-shot purge-and-reload as a missing
`data.js`. `check:lab` boots the app with `scoring.js` 404ing to prove it.
**The page and its rulebook are version-pinned.** `scoring.js` declares
`SCORING_VERSION`; `index.html` requests `scoring.js?v=<it>` and checks
`SCORING_EXPECT` against it (`_scoringOk`); `sw.js` precaches that versioned URL
and caches it under the full URL. A previous release's `scoring.js` — an old
cached copy, a network drop mid-upgrade — is refused and self-heals instead of
quietly scoring with old rules. **On any change to `scoring.js`, bump the
version in all four places**; `check:lab` fails if they disagree and proves a
stale copy is refused.

A scoring change is an app change: `verify`, bump `SW_VERSION` and
`SCORING_VERSION`, and expect `check:parity` to fail until the golden is
regenerated **on purpose**.

## The picks table holds every sport; UFC readers say so

`picks.promotion` (`0007_picks_promotion.sql`, default `'ufc'`) is what lets
the sport switcher store PFL (then ONE, boxing, …) picks beside UFC ones. The
rule that keeps the UFC board exactly as it was: **every UFC read or
UFC-scoped delete of `picks` carries `promotion=eq.ufc`** (`PICKS_UFC` in
`index.html`), in the app, the Lab, FightBot, the edge functions and
`scrape.py`; and `scoring.js` skips any other row (`_isUfcRow`) on the board and
the Belt as a second guard. `check:promotion` walks every call site against a
short allow-list of account-wide calls (account delete, nickname rename, name
checks, the upsert that names its promotion in the body); `check:parity` proves
PFL rows leave every UFC output byte-identical. A new picks query needs the
filter, or an allow-list entry that says why it spans every sport.

## The sport switcher sits beside UFC, never inside it

`// sports:start … :end` in `index.html` adds a UFC | PFL | … switcher (on the
home page and on Ranks). It appears **only** when the validated feed
(`events-extra.json` → `PickEngine.validateFeed`) has a card with ≥2 bouts in
the window, so it vanishes by itself when a promotion has nothing to pick. Another sport never
touches the UFC path: its own view (`#sportApp`), its own local picks
(`ufc_sport_picks`), rows tagged with its promotion, and its own board
(`sportStandings` in `scoring.js`). `loadLeaderboard` hands off to
`renderSportBoard` before reading any UFC rows.

**Every MMA promotion scores by the UFC rules, through the UFC function.**
`sportStandings` sends each pick through `pickPts`, the same one the UFC board,
Belt and recaps use: winner 1, method +0.5, underdog bonus off the bout's line
(`sportOdds`: the feed's `{a,b}` becomes `{f1,f2}`), 🔒 +1 / -1 from
`LOCKS_START`. It was its own 1-point rule until 2026-09-29; the boards are
still separate (a row counts only on its own promotion's board), but the
arithmetic can't drift, and `check:sports` asserts equality with `pickPts` for
every pick / method / lock combination. The sport view is built like the UFC card
(`sportEventBlock` / `sportFightRow` mirror `makeEventBlock` / `makeFightRow`: same
classes, `makeFighter`, `makeOddsRow`, `.pick-btn` surname buttons, "N more fights"),
with `fighter.other` so it never borrows a UFC record, form or rank; both UFC and
sport cards carry `N/M picked` and `n/2 locks` badges. It has the UFC card's own
controls (`method-pick-row`, `lock-btn`): method and 🔒 live in
`ufc_sport_meta` beside `ufc_sport_picks` (whose shape is unchanged), save in
the row's `method` / `confidence`, cap at `LOCKS_PER_CARD` per card in the app
and in `picks_cap_locks` (0007 already counts per promotion), close with the
pick, and a lock the server clamps is dropped locally, as on UFC. Picks close at the feed's `time` (ET) if given,
else `SPORT_LOCK_UTC_H` on the card's date. Feed text is rendered with
`textContent` only. `check:sports` holds all of it.

## Fighter photos: one lookup, and never someone else's face

**UFC rows try ESPN first.** Most UFC fighters' Wikipedia articles have no
photo at all (16 of 76 fighters on the next three cards, probed 2026-10-01;
Wikidata added none), so the Wikipedia lookup alone left most cards as initials.
`scrape.py`'s `update_espn_ids` reads competitor ids off the ESPN scoreboard it
already fetches (free, no quota), matches them to our exact names (case, accents
and punctuation folded, only on that card's own date), HEAD-checks the headshot
(a missing one is a 404, which would also block the fallback) and stores verified
ids in data.js's `FIGHTER_ESPN`, which only ever grows. The app draws ESPN's
resized headshot (`a.espncdn.com/combiner`, ~18 KB) and falls back to Wikipedia
if it fails to load. Only UFC rows use it (`_photoInto(…, !fighter.other)`): the
map is keyed by UFC names. A name whose title lookup finds no fighter page at all
gets one Wikipedia search, accepted only on an exact folded-name title match
("Natalia Silva" → "Natália Silva (fighter)"). `tests/test_espn_photos.py` and
`check:photos` hold it.

`// fighter-photos:start … :end` in `index.html` is the only code that turns a
name into a photo, shared by the UFC rows and the sport view. It asks Wikipedia
for the name **and** its `(fighter)` / `(mixed martial artist)` / … titles in
one request (`redirects=1`), because a common name is a disambiguation page
with no image ("Chris Curtis", "Makoto Takahashi"), and uses a page only if its
short description says fighter, martial artist, kickboxer, boxer …: a bare
name that belongs to an actor shows initials. Misses are stored with a time
(`ufc_photo_miss`, retried after 7 days), never as a permanent `"none"`; a
network error records nothing, so the next visit retries. Its old `ufc_photos`
key persisted misses forever and in-flight lookups as `null`, which a reload
read as "still loading" and never fetched; it is deleted, not migrated, since
its hits were never checked against the page and could be the wrong face.

**The images come from `thumb.wikimedia.org`, not `upload.wikimedia.org`, and
the page's CSP `img-src` must allow that host.** It did not, so for a while the
lookup succeeded, the URL passed `_safeImgUrl` (any `*.wikimedia.org`), and the
browser silently refused to draw every photo: no error in the app, just
initials, and a headless test that served its fake images from the allowed host
could not see it. `check:photos` now feeds the real URL shape through and
asserts every host `_safeImgUrl` accepts is one `img-src` allows. Requests are
also queued (`PHOTO_MAX_INFLIGHT`): ~100 at once got 12 rejected. `npm run
check:photos` holds all of it, mutation-tested.

## Non-UFC cards: checked in shadow mode, now published

`extra.py` builds PFL cards from Wikipedia (free, same parsers as `scrape.py`)
for the sport switcher and the Fight Lab hub. It was written without being able
to see PFL's real pages, so it ran in shadow mode first; its first real run's
PFL Chicago card was checked against the published card (12 of 14 bouts
independently confirmed, none contradicted) and `EXTRA_PUBLISH=1` was set on
its `update.yml` step on 2026-09-24. Remove that to drop back to shadow mode
(output to `events-extra.candidate.json` only). **A new promotion added to
`PROMOTIONS` gets the same treatment**: publish its cards only after a real
candidate has been compared to the actual card, since the engine's rule is
that nothing may state a card that isn't happening. The switch is **per
promotion** (`publish` on its `PROMOTIONS` entry; add it as `False`):
`EXTRA_PUBLISH=1` turns the live file on, the live file carries only the
published promotions (their cards and their `promotions` entries), and the
candidate file always carries every promotion so a shadowed one can be
checked. Before that split, adding a promotion published it on its first run.
RIZIN and DWCS were checked and published on 2026-09-28 (DWCS week 8: 5 of 5
bouts matched UFC.com; RIZIN Landmark 16: 8 of 13 confirmed, none
contradicted). Their pages are unlike PFL's: RIZIN's year page is both the
events list (rows link to in-page `[[#anchor|…]]`, read only under
`list_section`) and every card's section; DWCS has no article per card, so
`seasons` reads the main article's season table and one card per
`== Week N – Month D ==` section of the season page, dated by that section's
own infobox. **Each promotion's lock hour is a fact about where it fights**:
`SPORT_LOCK_UTC_H_BY` in `index.html` (RIZIN 02:00 UTC, since Japan's first
bell is ~04:00 UTC and the 10:00 default would leave five hours pickable;
DWCS 22:00 UTC, an hour before its 19:00 ET bell). A new promotion that fights
before 10:00 UTC needs an entry before it is published; `check:sports` holds
both. **The underdog bonus needs a line per bout, and today there are none:**
the Odds API's umbrella MMA feed lists essentially only UFC (`odds-state.json`'s
`markets` has no PFL / RIZIN / DWCS date; the primary key is also out of quota).
So `scrape.record_odds_lines` leaves every priced bout of the pull it already
makes in `odds-lines.json` (no call, no quota; kept 3 days after the bout
began; a spent key's empty pull never empties it) and `extra.apply_odds` gives a
bout the line whose two fighters both match, within a day of the card. Until the
books list these promotions nothing matches and every bout scores no bonus,
which is correct. A line is never replaced by nothing (the market vanishes when
a fight ends, and a bonus that vanished with it would rewrite a settled score)
and stops moving once the bout has started. Title fights are read from
a champion's "(c)" or the bout's own text ("championship", "for the … title";
not eliminators), since an inaugural belt has no champion. A card needs `MIN_BOUTS` real
bouts to be listed, and a failed fetch keeps the previous version, never an
empty one.

## Rooms are for accounts, and a room's board is the main board filtered

Watch Party rooms (`// rooms:start … :end` in `index.html`,
`supabase/migrations/0006_rooms.sql`) give a group its own board and 🏆 belt.
Two rules hold it together:

- **A room never scores anything itself.** Its board is `boardStandings(rows,
  roomScope(scope))`, i.e. the main board's own scope plus `users:` the members,
  and its belt is `computeBeltLineage(rows, {users})`. Don't add a room-specific
  scorer; add a scope. `check:rooms` asserts members score exactly what the
  main board gives them.
- **Only email-linked accounts can create, join or even see a room**, enforced
  in the database (`is_account()`: a missing `is_anonymous` claim fails
  closed), not just in the app. An anonymous `user_id` dies with the phone's
  storage and would leave a ghost member behind; an account's comes back on any
  phone. The app sends an account-less invite tap to "Link an email" first
  (linking keeps the same `user_id`), holds the code in `ufc_room_join`, and
  `_postSignIn` resumes it. A token minted before the link still says
  anonymous, so a refusal of exactly that kind gets one refresh + retry.

Inserts happen only through the `create_room` / `join_room` RPCs (caps: 10 owned
rooms, 50 members). Since `0008_rooms_codes_throttle.sql`, new invite codes are
10 characters of Crockford base32 (the old 6-hex codes still work), and each
account gets 10 wrong codes an hour. **`join_room` returns NULL for a wrong code
rather than raising**: an exception would roll back the row that records the
miss, so the throttle would never count anything. The app reads an empty reply
as "no such room"; `check:rooms` holds both halves. **Temporary passwords**
(`0018_room_passwords.sql`): an invite link opens in the phone's browser, and on
iOS that is always Safari, never the Home Screen app (separate storage, usually
no account). So any member can make a 6-character password (`set_room_pass`,
same alphabet, 24 hours, never equal to a live code or password) that is typed
into the same Join box; `join_room` tries the code, then a live password, and a
miss counts against the same throttle. The columns change only through the
RPCs. Opened from a link in iOS Safari, the app asks before joining there. Room names are other people's input: render them with
`textContent`, never `innerHTML` (`check:rooms` holds that too).

## The engine migration moves code, never numbers

`index.html` is being moved onto the Pick Engine in stages (`docs/MIGRATION.md`).
`check:parity` pins every scoring output to a golden taken before it started,
on frozen data (`tests/fixtures/parity-data.json`) and seeded synthetic picks:
real picks never go in the repo. **Never regenerate the golden
(`--update`) to make a migration stage pass**; only for an intended scoring
change, called out in the PR. Nothing in the migration merges on a card day.
If a stage goes wrong: `docs/ROLLBACK.md` (known-good branch
`backup/pre-engine-migration-2026-09-24`, picks snapshot
`picks_backup_2026_09_24`).

## Report, block and the privacy policy (App Store groundwork)

Apple's guideline 1.2 requires an app with user content (roasts, challenges,
nudges, nicknames, room names) to let people **report** it and **block** abusive
users, and every app needs a **privacy policy** URL. `0013_safety.sql` adds
`user_blocks` (only the blocker sees, adds or removes a row; the blocked person
is never told) and `content_reports` (insert-only, as yourself, 20 a day; read
them in the Supabase dashboard). A block is enforced by the server: `send-push`'s
`blockedWith` drops every **social** push across it in both directions (a missing
table is "no blocks", any other read failure is a 503: fail closed), and
the `challenges_block_guard` trigger refuses a challenge between a blocked pair
(a trigger, never an app-executable SECURITY DEFINER helper: that would be an
RPC anyone could call to learn who blocked them). The app's
`// safety:start … :end` block adds 🚩 Report / 🚫 Block under a received roast,
an incoming challenge, a player's expanded Ranks row and (Report only) a room
you don't own, hides a blocked player's
challenges and roast targets, and lists blocks under ⋯ More → Privacy & Safety.
Blocking by name blocks every uid the board holds under it (anonymous uids
rotate). `privacy.html` is static and script-free: **when the app starts
collecting something new (a table, a third-party call), update it in the same
change.** The migration is applied by hand and send-push needs a Supabase deploy.
`check:safety` and `check:pushauth` hold it.

**Delete my account deletes the account** (Apple 5.1.1(v)): `0014_delete_account.sql`'s
`delete_my_account()` RPC (no arguments, the caller only, as the owner so the pick
lock lets it through) removes the auth login (cascading to identities and sessions)
and every row keyed to the caller: picks, rollback `picks_backup_*` snapshots,
push_subs, prefs, rooms and seats, challenges on either side, blocks either way,
AI usage, wrong room codes. Reports stay as a moderation record. **A new table
holding a user id goes into that function and into `privacy.html` in the same
change.** The app has **no fallback**: a partial delete reported as a full one
would be false, so anything but success is "try again", and the migration must be
applied before an app that calls it ships. A deleted account's access JWT stays
valid until it expires, so the `refuse_deleted_account` trigger on every table the
app writes as a user (a new one goes in its list too) refuses a write whose
`auth.uid()` has no login left. `check:delete`.

## Other conventions

- **Bump `SW_VERSION` in `sw.js`** whenever you change `index.html` / `data.js`
  so installed PWAs fetch the new version instead of a cached broken one.
- `build.mjs` (`npm run build`) writes an optional minified `dist/`; the live
  deploy serves raw source, so a change isn't "shipped" via the build.
- Edge-function edits only go live after a Supabase deploy (the workflow above),
  not merely on git push.
- **CI dependencies are pinned.** Python packages come from `requirements.txt`
  (scraper) and `requirements-dev.txt` (pytest), installed with
  `--require-hashes`; edit the `.in` files and regenerate with `pip-compile
  --generate-hashes` (command in each file's header). Actions are pinned by
  commit SHA, and the Supabase CLI by version in `deploy-functions.yml`: bump
  any of them on purpose, in a commit that says so, never back to `latest`.

## Codex PR review

OpenAI Codex auto-reviews PRs in this repo. It triggers when a PR
is opened for review, when a draft is marked ready, or on a
`@codex review` comment. Findings come back as comments from
chatgpt-codex-connector[bot]; a clean pass is just a 👍 reaction.

### PR workflow (one Codex round, then merge)

1. Open the PR, then immediately subscribe to its activity so Codex
   review comments come back to this session. Do this automatically;
   don't ask me first. Do not merge yet.
2. Wait for the FIRST Codex review (comments from
   chatgpt-codex-connector[bot], or a 👍 reaction = clean pass).
   A clean pass sends NO event: the 👍 is a reaction on the PR body,
   and reactions never reach the subscription, so waiting on events
   alone misses it until the next check-in. So right after opening,
   schedule check-ins (`send_later`) at 2, 4 and 6 minutes, then
   hourly as a backstop. On every check-in AND every event that does
   arrive (CI finishing, a comment), read the PR's `reactions` with
   MCP `issue_read` on the PR number — the comments calls don't
   return them. Only Codex's 👍 counts, and `issue_read` gives counts,
   not authors: Codex marks a review in progress with 👀 and swaps it
   for the 👍 when it passes, so read a pass as 👀 gone and 👍 present.
   A 👍 while 👀 is still there may be someone else's — keep waiting.
   Cancel the remaining check-ins once the review lands.
3. Evaluate each finding yourself and act without asking me:
   - Valid and in scope → implement the fix.
   - Out of scope, style-only, or speculative → don't fix. List it
     in a PR comment under "Deferred" with a one-line reason.
4. Push all fixes in one commit. Do not tag @codex again.
5. Once CI passes, merge to main and unsubscribe from the PR.
   Then give me a short summary: what you fixed, what you deferred.

Ignore any Codex reviews or comments that arrive after step 2.
One review round per PR. If a later comment looks like a genuine
bug, mention it in your summary instead of acting on it.

In remote/web sessions there is no `gh` CLI — use the GitHub MCP tools
(`pull_request_read`, `add_issue_comment`) for the same steps.
