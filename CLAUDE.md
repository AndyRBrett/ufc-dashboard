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
| `npm run check:lock`  | a bout still pickable after its own segment has started (or locked before it) |
| `npm run check:recap` | the post-card recap crediting a title, rank or score the board and belt don't |
| `npm run check:wrapped` | Year Wrapped reporting a rank, score, upset or reign the year-scoped board and belt don't |
| `npm run check:locks` | a 🔒 lock scoring differently on the board, belt or challenges, legacy stars scoring, or a third lock on a card |
| `npm run check:lab`   | the Fight Lab scoring differently from the board, reading a result it claims to predict, or failing to boot |
| `npm run check:fightbot` | FightBot's MCP stream corrupted by stray stdout, a tool crashing the session, or its standings drifting from the board |
| `npm run check:brief` | the Friday Fight Week Brief push firing at the wrong time, twice, after the bell, off the Lab's numbers, or not at all |
| `npm run check:swap` | a pulled bout's pickers not told, told twice or after it locks, a rename announced as a replacement, or the alert reaching anyone else |
| `npm run check:iq` | the AI Fight IQ write-up stating a number it wasn't given, drifting onto Grok, repeating one voice, or escaping its daily cap |
| `npm run check:parity` | any score moving during the engine migration: board, main-card board, per-card, Belt lineage, recaps, Year Wrapped |
| `npm run check:promotion` | a picks query without `promotion=eq.ufc`, letting another sport's picks onto the UFC board, Belt, restore or result pushes |
| `npm run check:sports` | the sport switcher showing with nothing to pick, a PFL pick saved untagged or after its lock, or another sport scored on the UFC board |
| `npm run check:rooms` | a room's board scoring differently from the main board, an anonymous device joining a room, or an invite link re-joining / re-prompting |

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

Two budgets to respect when changing cadence:

- **Odds API calls are quota-metered.** `should_fetch_odds` gates them on elapsed
  time (3h–24h depending on how near the next card is). Do not call `fetch_odds`
  unconditionally — the 5-minute fight-window cadence used to, which burned
  ~1,200 calls/month against a 500/month tier and froze every line for six days.
- **Fighters on a card within `STATS_URGENT_DAYS` bypass the failure cooldown**
  (`_needs_stats_fetch(..., urgent=True)`). The flat 3-day cooldown guaranteed a
  blank record through any card that landed inside it.

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

`ai-breakdown` serves five actions. Four of them — `breakdown`, `chat`,
`parlay`, and the Fight Lab's `fight-iq` scouting report — make claims about real
fights or real people's picks, and those stay on Claude. The fourth, `trash-talk`, is a joke between five friends, and
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

Which bouts sit in which segment is still inferred from **bout order**, not from
the article's section headings — `parse_upcoming_card` reads `{{MMAevent bout}}`
templates and throws the headings away. `_MAIN_CARD_SIZE` and
`_PRELIM_CARD_SIZE` pin the exceptions to the standard 5 / 4 / rest shape. When
the parser learns to read the headings, both tables retire together.

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
empty tap for `index.html`. The copy is composed by the Lab's own code, fetched
from Pages at send time; if that fails it still sends a plain teaser — never
nothing. `check:brief` holds all of it, mutation-tested.

## Fight change alerts: a vanished bout tells exactly who picked it

Picks are stored by fighter name, so a withdrawal leaves every pick on the old
bout matching nothing: it silently never scores. `send-reminders` (5-minute
cadence) now compares each upcoming card's UFC picks with `data.js` and sends
one `swap-<old bout>` push per vanished bout (`notif_log` dedups it), **targeted
with `include_user_ids`** at the people who picked it and haven't already
re-picked the new bout. It names who is out and who now faces whom, or says the
bout was cancelled. Three guards, all held by `npm run check:swap` (mutation-tested):

- **Name matching is `scoring.js`'s `nmEq`/`nmBout`**, fetched from Pages, plus
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
day in the Lab (`IQ_WRITEUPS_PER_DAY`), `IQ_DAILY_CAP` per viewer per day on the
server (in-memory, best-effort — a cold start resets it), and the existing
per-IP / global rate limits; inputs are capped (`MAX_IQ_LINES`, `MAX_IQ_LINE`).
It runs on `MODEL`, like the other analysis actions. `check:iq` holds all of it.

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
(`sportStandings` in `scoring.js`: 1 point per correct winner, no locks, no
dog bonus, no method). `loadLeaderboard` hands off to `renderSportBoard`
before reading any UFC rows. Picks close at the feed's `time` (ET) if given,
else `SPORT_LOCK_UTC_H` on the card's date. Feed text is rendered with
`textContent` only. `check:sports` holds all of it.

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
that nothing may state a card that isn't happening. Title fights are read from
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
rooms, 50 members). Room names are other people's input: render them with
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

## Other conventions

- **Bump `SW_VERSION` in `sw.js`** whenever you change `index.html` / `data.js`
  so installed PWAs fetch the new version instead of a cached broken one.
- `build.mjs` (`npm run build`) writes an optional minified `dist/`; the live
  deploy serves raw source, so a change isn't "shipped" via the build.
- Edge-function edits only go live after a Supabase deploy (the workflow above),
  not merely on git push.

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
