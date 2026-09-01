# UFC Fight Cards

A pick-'em dashboard for UFC events: every upcoming card, live results as they
land, betting lines, fighter tale-of-the-tape, and a leaderboard for the group
chat — installable as a phone app, with push notifications that arrive whether
or not anyone has it open.

**Live:** https://andyrbrett.github.io/ufc-dashboard/

The site is a static progressive web app served straight from this repository by
GitHub Pages. A scheduled scraper rebuilds the fight data on its own; a small
Supabase backend holds picks and fans out push notifications.

---

## Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [The data pipeline](#the-data-pipeline)
- [Scoring](#scoring)
- [Notifications](#notifications)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Security](#security)
- [Further reading](#further-reading)

---

## What it does

**Cards and fighters**
- Every announced UFC event with venue, broadcaster, and main-card / prelim start
  times resolved to the viewer's local timezone, plus a countdown to the next one.
- Per-bout tale of the tape: records, rankings, reach and stance, striking and
  grappling rates, finish splits, and recent form.
- Moneyline odds per fighter, with line movement tracked over time and closing
  line value recorded once a card is in the past.
- Fighter search, weight-class filtering, and a head-to-head comparison view.

**Picks and competition**
- Pick a winner for every bout, optionally with a method (KO/TKO, submission,
  decision) and a Fight of the Night call. Picks lock at the bout's start.
- A public leaderboard with streaks, perfect cards, upset hit rate, method
  accuracy, and a "belt lineage" tracing who won each past event.
- Head-to-head challenges, a nudge for people who haven't picked yet, an
  activity feed, a spin-the-wheel forfeit list, and AI-generated fight
  breakdowns and trash talk (Claude, behind an edge function).

**Live nights**
- Fight Night mode: results appear as bouts are called, with standings updating
  live, a spoiler-free option, and reactions.
- Installable PWA with an offline app shell and push notifications for reminders,
  results, and social events.

---

## Architecture

```
   GitHub Actions (cron)                 GitHub Pages
   ┌──────────────────┐                  ┌──────────────────────────┐
   │ scrape.py        │   commits        │ index.html  (app)        │
   │  Wikipedia       │   data.js ─────► │ data.js     (fight data) │ ◄── browser / PWA
   │  UFCStats        │                  │ sw.js       (push+cache) │
   │  ESPN            │                  └──────────────────────────┘
   │  The Odds API    │                             │  picks, challenges
   └────────┬─────────┘                             ▼
            │ health.py --gate                ┌────────────────────┐
            │ (blocks a broken publish)       │ Supabase           │
            └──────────────────────────────►  │  Postgres + RLS    │
                       result pushes          │  Edge Functions    │
                                              └────────────────────┘
```

Three deliberate properties hold this together:

1. **App code and data are separate files.** `index.html` is the application;
   `data.js` is a generated `var EVENTS = [...]` blob. An automated data push can
   never corrupt the app, and a bad data pull can be reverted on its own.
2. **The frontend has no build step.** GitHub Pages serves the source verbatim,
   so what you read in the repo is exactly what runs in production. (`npm run
   build` produces an optional minified `dist/`; the live site does not use it.)
3. **Everything that costs money or holds a secret lives server-side** — the
   Anthropic API key, the web-push signing key, and the service-role key are all
   confined to Supabase edge functions.

---

## Repository layout

| Path | What it is |
| --- | --- |
| `index.html` | The entire frontend — markup, inline CSS, and ~5,600 lines of inline JS. |
| `data.js` | Generated fight data: `EVENTS`, `FIGHTER_STATS`, `RANKINGS`, `RESULTS_ARCHIVE`. Never edited by hand. |
| `sw.js` | Service worker: install/offline shell, push receipt, notification-tap routing. |
| `manifest.json`, `icon-*.png`, `fonts/`, `sounds/` | PWA install metadata and static assets. |
| `scrape.py` | The data pipeline — discovers cards, parses results, fetches stats and odds, writes `data.js`. |
| `health.py` | Reads the built `data.js` and reports what's wrong; gates the publish. |
| `write_status.py` | Per-event freshness and odds-movement status (`overseer-status.json`). |
| `odds_series.py` | Rebuilds the odds snapshot log into per-bout time series and closing-line value. |
| `make_icons.py` | Regenerates the app icons. |
| `supabase/functions/` | Deno edge functions: `send-push`, `send-reminders`, `check-results`, `ai-breakdown`, `kick-scraper`. |
| `supabase/migrations/` | Row-Level Security policies, kept in version control. |
| `tests/` | Node validation gates (`check-web`, `check-functions`, `smoke`, `notification-tap`) and Python unit tests. |
| `build.mjs` | Optional minified `dist/` build. Not part of the deploy. |
| `.github/workflows/` | Data updates, validation, Pages and Supabase deploys, secret scanning. |

Generated state files at the repo root — `odds-state.json`, `odds-snapshots.jsonl`,
`odds-series.json`, `overseer-status.json`, `health-report.json` — are written by
the pipeline and committed so the next run can diff against them. The runner is
ephemeral; uncommitted state would reset every run.

---

## The data pipeline

`scrape.py` runs in GitHub Actions (`.github/workflows/update.yml`) and rebuilds
`data.js` from four upstream sources:

| Source | Provides |
| --- | --- |
| Wikipedia | Event discovery, cards, bout order, official results, rankings |
| UFCStats | Per-fighter statistics, records, physical attributes, recent form |
| ESPN scoreboard | Authoritative main-card and prelim start times |
| The Odds API | Moneyline odds, pulled across two region sets for coverage |

Every source degrades gracefully: a failed fetch keeps the previous value rather
than blanking the card. That keeps the site up, but on its own it makes a broken
pull indistinguishable from a good one — so the run is gated.

### The publish gate

`health.py --gate` runs between the scrape and the commit, comparing the new
`data.js` against a snapshot of the published one:

- **BLOCK** — structural breakage: unparseable data, empty `EVENTS`, a card that
  *lost* bouts. The job fails, nothing is committed, the last-good `data.js`
  stays live, and the failure is emailed.
- **WARN** — data gaps: a blank record, a missing line, a TBD fighter. These are
  reported to a single auto-updating GitHub issue and **never block**. A blocked
  commit during a card would also block the live results everyone is watching.

Findings are weighted by how close the card is: a gap on a card five days out
matters, the same gap on one three months out does not.

### Results run before the rebuild

`scrape.py` does two different jobs, and it never does both in one run. It first
looks for results to inject into events in the last few days; if it injects any,
it writes `data.js` and **exits before the rebuild** — odds, stats and rankings
are not touched. That is deliberate: during a card the 5-minute runs exist to
publish results, and a full rebuild on each of them would be wasted work and
wasted quota.

The cost is that anything which makes an injection *look* successful stops the
rebuild for as long as the event stays in the results window. In September 2026
a fighter name reached `data.js` carrying an unclosed `{{nowrap|` template from
Wikipedia. The stray braces unbalanced the brace scan `inject_results` uses to
find a bout's extent, so it edited an empty slice — changing nothing, and
counting it as an injection anyway. Every run for three days stopped at that
phantom result. The odds froze on a card four days out, the scrape step finished
in two seconds, and each commit still landed looking healthy.

So: **an injection must be a real edit.** `inject_results` refuses a bout it
cannot delimit and counts only a substitution that actually changed the text.
`clean_wiki` strips unclosed template openers, because the caller feeds it one
line at a time and a template split across lines arrives without its closing
braces.

### Diagnosing frozen odds

Stale lines report as an Odds API problem — `odds-state.json` shows the last
status and remaining quota, and the health report repeats it — but that state is
only as fresh as the last *attempted* pull. A pipeline that never reaches the
odds step leaves the last failure sitting there looking current. Check the API
directly before believing it:

```bash
# headers only; still spends one call from the quota
curl -s -o /dev/null -D - "https://api.the-odds-api.com/v4/sports/mma_mixed_martial_arts/odds/?apiKey=$KEY&regions=us&markets=h2h"
```

`x-requests-used` is the honest number. If it is far below what the cadence
should have spent this cycle, the scraper is not calling the API at all and the
fault is upstream of the odds code — start with the scrape step's duration and
whether it exited on a result injection.

Note that the API answers `401` for both an exhausted quota and a rejected key,
and sends no `x-requests-remaining` header on that response — so the remaining
count in `odds-state.json` may be left over from an earlier call.
`update.yml` tells the two cases apart by that count and warns rather than fails
on exhaustion, since a dead key needs a human and a spent quota fixes itself.

### Two budgets

- **Odds API calls are quota-metered.** `should_fetch_odds` gates them on elapsed
  time — between 3 and 24 hours depending on how near the next card is. Calling
  `fetch_odds` unconditionally on the 5-minute fight-window cadence once burned
  ~1,200 calls a month against a 500/month tier and froze every line for six days.
- **Fighter stats have a failure cooldown**, but fighters on a card within
  `STATS_URGENT_DAYS` bypass it (`_needs_stats_fetch(..., urgent=True)`). A flat
  cooldown guaranteed blank records through any card that landed inside it.

### Cadence

| When | Why |
| --- | --- |
| Daily 09:00 UTC | Card structure and odds |
| Every 4h Thu–Sat | Fight-week churn — late replacements and withdrawals |
| Every 5 min during fight windows (Sat and Sun US prime time) | Live results and result pushes |

GitHub throttles `schedule:` cron hard during busy periods, so the
`kick-scraper` edge function also dispatches the workflow via the API on an
external schedule, which is not throttled the same way.

---

## Scoring

| Outcome | Points |
| --- | --- |
| Correct winner | 1 |
| Correct method (on a correct pick) | +0.5 |
| Correct Fight of the Night | +1 |
| Correct underdog at +150 to +249 | +0.5 |
| Correct underdog at +250 or better | +1 |

A bout with no stored line simply scores no underdog bonus. `userPts()` in
`index.html` is the single formula every board, badge, and projection reads, so
they cannot drift apart.

---

## Notifications

A closed phone can only be reached by a Web Push delivered to the service
worker. Everything therefore funnels through the **`send-push`** edge function,
which fans a payload out to matching `push_subs` rows and records each
`(event_date, type)` in `notif_log` first — so any number of redundant triggers
produce exactly one push per logical event.

```
              ┌─ client (picks, nudges, challenges, trash talk)
triggers ─────┼─ check-results   (results)      ┐
              ├─ send-reminders  (reminders)    ├─ POST → send-push → Web Push → sw.js → phone
              ├─ scrape.py       (results)      │        (notif_log dedup)
              └─ client live-poll (results)     ┘
```

Result and reminder pushes have both a cron trigger and a client trigger; the
cron path is what guarantees delivery when nobody has the app open. Results are
spoiler-free by default — subscribers only see the outcome in the notification
if they have opted into live results.

Delivering the push is only half of it: a tapped notification has to hand its
full payload to the page, across app-closed, app-backgrounded, and legacy paths.
`npm run check:tap` covers all of them and gates the deploy.
[`NOTIFICATIONS.md`](NOTIFICATIONS.md) documents the full catalogue and the
failure modes worth knowing about.

---

## Local development

```bash
npm install          # dev dependencies (Playwright, esbuild, terser)
python -m pip install requests beautifulsoup4 pytest
```

Playwright's browser download is skipped when `PLAYWRIGHT_BROWSERS_PATH` is
already set; otherwise run `npx playwright install chromium`.

Serve the repo root with any static server and open it — there is nothing to
compile:

```bash
python -m http.server 8000     # then visit http://localhost:8000
```

### Run the checks before you commit

Because all the app logic is inline in one file, a single typo turns the site
into a blank white page for every user. Once, a break shipped mid-fight-card and
stayed live while people were using it.

```bash
npm run verify
```

| Script | Catches |
| --- | --- |
| `npm run check:web` | Syntax errors in `index.html`'s inline scripts and in `sw.js`; a broken or empty `data.js` |
| `npm run check:functions` | Syntax errors in any Supabase edge function, including the paid one |
| `npm run smoke` | The app failing to boot — loads it headlessly and opens the leaderboard |
| `npm run check:tap` | A tapped push notification failing to surface its message |

Python tests run with `python -m pytest -q`.

**Never push a change that fails `verify`.** If you touched `index.html`,
`data.js`, `sw.js`, or an edge function, it is mandatory. CI runs the same gates,
but it is a backstop — not a substitute for finding the break locally.

### Conventions

- **Bump `SW_VERSION` in `sw.js`** whenever you change `index.html` or `data.js`,
  so installed PWAs fetch the new version instead of serving a cached broken one.
- Never hand-edit `data.js`; change `scrape.py` and let the pipeline regenerate it.
- Don't re-add silent fallbacks to the pipeline. Failures are meant to be loud.

---

## Deployment

| Workflow | Trigger | Result |
| --- | --- | --- |
| `pages.yml` | Push to `main`, a data update, or manual dispatch | Deploys the site to GitHub Pages |
| `deploy-functions.yml` | Push to `main` touching `supabase/functions/**` | Deploys the edge functions |
| `update.yml` | Cron and manual dispatch | Rebuilds and commits `data.js` |
| `ci.yml` | Every push and pull request | Runs all gates for visibility |
| `secret-scan.yml` | Every push and pull request | `gitleaks` over full history |

Both deploys are gated on the same checks you run locally: `pages.yml`'s deploy
job `needs:` the `validate-web.yml` workflow, and `deploy-functions.yml`'s deploy
job `needs:` a `check:functions` gate. A build that fails to boot cannot reach
production.

Edge-function changes go live only after the Supabase deploy runs — not on git
push alone.

---

## Security

The Supabase **anon** key ships in `index.html`; that is by design. It identifies
the project and grants exactly what the `anon` role's Row-Level Security policies
allow. RLS is the real boundary, and it is kept in version control at
[`supabase/migrations/0001_rls_baseline.sql`](supabase/migrations/0001_rls_baseline.sql).

Each visitor is signed in through Supabase anonymous auth, so writes are made as
the `authenticated` role and scoped by `auth.uid()::text = user_id` — a user can
only modify their own picks. Leaderboard reads are public on purpose.

The Anthropic API key, the web-push VAPID private key, the service-role key, and
the Odds API key never reach the browser. Edge functions enforce a CORS
allowlist, per-IP and global rate limiting, and input length caps.
[`SECURITY.md`](SECURITY.md) documents the full model, the known gaps, and how to
rotate every key.

Found a security issue? Report it privately — see [`SECURITY.md`](SECURITY.md);
please don't open a public issue.

---

## Further reading

| Document | Covers |
| --- | --- |
| [`CLAUDE.md`](CLAUDE.md) | Working notes and guardrails for contributors and AI agents |
| [`SECURITY.md`](SECURITY.md) | Secret topography, RLS, defenses, key rotation |
| [`NOTIFICATIONS.md`](NOTIFICATIONS.md) | Every notification path and how taps are delivered |
| [`TODO.md`](TODO.md) | Open follow-ups, known gaps, and credential reminders |
| `supabase/functions/*/README.md` | Per-function deployment and configuration notes |

---

UFC® is a trademark of Zuffa, LLC. This is an unofficial fan project with no
affiliation to or endorsement from the UFC. Fight data is aggregated from public
sources and may be incomplete or wrong; odds are shown for interest, not as
betting advice.
