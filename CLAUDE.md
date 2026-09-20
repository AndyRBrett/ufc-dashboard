# UFC Dashboard — working notes for Claude / contributors

A vanilla PWA: the entire app is **`index.html`** (HTML + inline CSS + ~5,600
lines of inline JS), fed by **`data.js`** (the generated `EVENTS` array) and
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
| `npm run check:prompt` | a typed roast angle getting diluted by the rest of the prompt |
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
  `check:functions` + `check:provider` gate.
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
| `odds-state.json` | last Odds API pull time, HTTP status, and remaining quota |
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

Fires once per boot, ~1.2s after the initial `render()`, and skips entirely
if a real overlay is already open — a tap-driven deep link (trash talk,
challenge inbox) always wins. "Real overlay" means listed in `_escClosers`
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

`ai-breakdown` serves four actions. Three of them — `breakdown`, `chat`,
`parlay` — make claims about real fights people are betting picks on, and those
stay on Claude. The fourth, `trash-talk`, is a joke between five friends, and
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
| `GROK_MODEL` | `grok-4-fast-non-reasoning` | overridable so the model moves without a redeploy, same as `MODEL` |
| `GROK_MAX_TOKENS` | `1000` | Grok's ceiling. Not a length control — see below |
| `GROK_API_URL` | xAI chat-completions | only for pointing at a proxy |

**Two ways this feature fails silently, both ending in a roast that isn't
there.** Neither raises an error, and both look identical from the app — which
is why `provider`, `model` and `fellBack` come back in the response.

1. **A wrong `GROK_MODEL` is a 400**, and a 400 is deliberately not retried. The
   roast falls back to Claude and comes back *polite*, which reads like a prompt
   regression rather than a config typo. Verify the id against
   `GET https://api.x.ai/v1/models` rather than typing it from memory; the
   marketing name ("Grok 4.6") is not necessarily the API id.
2. **A reasoning model returns HTTP 200 with empty content** if the token budget
   is tight, because on the OpenAI-shaped API that budget covers the model's
   internal reasoning, not just the reply. The roast's prompt-level cap (~30
   words) made 120 tokens a natural ceiling, and 120 is nowhere near enough for
   a model that thinks first. Hence `GROK_MAX_TOKENS` at 1000, separate from the
   120 the Claude path still uses: **it buys reasoning room, it does not permit a
   longer roast** — length is the prompt's job. A loose ceiling costs nothing
   when the model doesn't reason, since billing is per token produced.

   A blank-but-successful reply is therefore treated as a *failure* and falls
   back, rather than being returned as an empty roast the client renders as
   "No trash talk generated." with nothing logged. `check:provider` holds this.

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
(which caught Derek's Eminem likeness and any joke about AB and Tristin being
married), and "no threat meant literally" (which contradicted the comedic-menace
shape this same prompt offers as a rhetorical form). `check:provider` asserts
the slur line survives *and* that neither ban has crept back — a prompt tweak
aimed at making roasts rawer should not silently re-tighten the floor either.
Worth knowing when weighing where it sits: the sender reads the roast on screen
and taps send, so this governs what gets **generated**, not what reaches a phone.

**What the rule does NOT relax.** The length cap, `FACTS ARE STRICT` and the
signature rule are untouched by it, and `check:provider` asserts all three
survive. `send-push`'s `MAX_BODY` already sits well above what 120 tokens can
produce, so nothing downstream needed resizing.

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

- Default: do not merge right after opening a PR — open it, then
  stop. If I say to merge, merge.
- Once the review lands, run `gh pr view <n> --comments` and triage
  each finding: real bug / not applicable / style-only. Tell me your
  call and reasoning before changing code.
- `@codex address that feedback` makes Codex push the fix itself.
  Only do that if I ask.

In remote/web sessions there is no `gh` CLI — use the GitHub MCP tools
(`pull_request_read`, `add_issue_comment`) for the same steps.
