# Notifications — architecture & topography

How every push notification in the UFC Dashboard is triggered and delivered,
and which paths work when the recipient's app is **closed**.

## Key principle

A closed phone can only be reached by a **Web Push delivered to the service
worker** (`sw.js`). Everything below ultimately calls the **`send-push`** edge
function, which fans a payload out to every matching `push_subs` row. What
differs per notification is *who triggers* `send-push`:

- **Client-triggered** — fired by a user's browser the moment they act. The
  *sender* must have the app open (they're tapping a button), but the
  *recipient* receives it whether their app is open or closed.
- **Cron-triggered** — fired by a scheduler with no app open anywhere. Required
  for time-based and "everyone offline" cases.

De-duplication is centralised: `send-push` records each `(event_date, type)` in
`notif_log` before sending, so any number of redundant triggers produce **exactly
one** push per logical event.

## Notification catalogue

| Notification | Trigger | Needs an app open? | Delivers to a closed recipient? |
| --- | --- | --- | --- |
| **Pick made** ("X is picking" / "locked in") | Sender's browser on `syncPick` → `send-push` | Sender only | ✅ |
| **Nudge** ("⏰ card locks soon") | Sender's browser → `send-push` (`include_user_ids`) | Sender only | ✅ |
| **Challenge** (sent / accepted) | Sender's browser → `send-push` (`include_user_ids`) | Sender only | ✅ (also lands in in-app inbox regardless) |
| **Trash talk** | Sender's browser → `send-push` | Sender only | ✅ |
| **Fight result** (won / lost) | `check-results` cron **+** `scrape.py` **+** client live-poll | No (cron path) | ✅ |
| **Main/Prelim reminder** ("starting in <1 hr") | `send-reminders` cron **+** client `checkNotifSchedule` | No (cron path) | ✅ |
| **Local fight-night reminder** (`fireNotif`) | Client `setTimeout` only | Yes — dies when app closes | ❌ (foreground nicety only) |

The client-side triggers for results and reminders are kept as **harmless
redundant** triggers — the cron guarantees delivery when nothing is open.

## Delivery chain

```
              ┌─ client (instant: picks, nudges, challenges, trash talk)
triggers ─────┼─ check-results   (results)      ┐
              ├─ send-reminders  (reminders)    ├─ POST → send-push ─→ Web Push ─→ sw.js ─→ phone
              ├─ scrape.py       (results)      │         (notif_log dedup)
              └─ client live-poll (results)     ┘
```

## Tap → in-app display (where this keeps breaking)

Delivering the push is only half of it. A trash-talk roast is too long for the
notification body, so tapping it has to hand the full text to the page — and
**every** way the tap can arrive needs a listener, or the user taps and sees
nothing. That failure has shipped more than once.

`notificationclick` (`sw.js`) always writes the payload to the **`ufc-tap`
cache** first, then tries to route it. The stash is the contract: a delivery
path that loses the message is survivable, one that also loses the stash is not.

| How the tap arrives | What consumes it |
| --- | --- |
| App closed → SW `openWindow()` | page-load consumer reads `ufc-tap` |
| App backgrounded → SW focuses it | SW `postMessage` **and** the `visibilitychange` re-check |
| Old SW, short message | legacy `?trash=` / `?inbox=` URL params |

The backgrounded case is the one that bites. `postMessage` to a focused client
is **not** a delivery guarantee — iOS keeps listing window clients for a PWA it
has already frozen, so `focus()` resolves, the message evaporates, and no
reload ever happens to re-run the page-load consumer. That is why the page
re-checks the stash on every foreground, not just on load.

Because two paths can now deliver the same tap, both carry the SW's tap `ts`
and the page shows a given `ts` once. Consumption is mutexed on `cache.delete()`
resolving `true`, so a race can't double-show or drop.

`npm run check:tap` (`tests/notification-tap.mjs`) covers all of these; it runs
in `verify` and gates the deploy. If you touch the tap path, that test is the
one that tells you whether a tapped push still shows anything.

## Edge functions

| Function | Role | JWT gateway | Inbound auth |
| --- | --- | --- | --- |
| `send-push` | Fan-out + `notif_log` dedup + `push_subs` registration | **verified** | anon key (a valid JWT) |
| `check-results` | Detect final fights from Wikipedia, push results | **`--no-verify-jwt`** | `CRON_SECRET` |
| `send-reminders` | Compute event start times, push reminders | **`--no-verify-jwt`** | `CRON_SECRET` |
| `kick-scraper` | Dispatches `update.yml` so the app's `data.js` stays fresh | **`--no-verify-jwt`** | `CRON_SECRET` |
| `ai-breakdown` | AI fight breakdowns (not a notification path) | verified | anon key |

`CRON_SECRET` is accepted **either** as `Authorization: Bearer <CRON_SECRET>`
**or** as a `?key=<CRON_SECRET>` query param, so header-less cron UIs work.

## Scheduling (the cron functions)

In-database `pg_cron` is **not** used: this project's `pg_net` can't queue
requests ("Quote command returned error") and `pgaudit` blocks updating the
extension. Scheduling is external, with redundancy:

1. **cron-job.org (primary)** — one job per function, every **2 min**, each
   sending `Authorization: Bearer <CRON_SECRET>` as a custom request header:
   - `…/functions/v1/check-results`
   - `…/functions/v1/send-reminders`

   > ⚠️ These two reject `?key=` — they read the header only. A job still
   > configured with a `?key=` URL returns 401 on every ping, and because
   > `scheduled-push.yml` covers them with the header, pushes keep working and
   > nothing looks broken. Only `kick-scraper` accepts `?key=`.
2. **GitHub Actions (backup)** — `.github/workflows/scheduled-push.yml`, every
   **5 min**, POSTs all three (including `kick-scraper`) with the
   `Authorization: Bearer` header (repo secret `CRON_SECRET`). GitHub throttles
   `schedule:` heavily, so treat this as "hours, not minutes" cover.

Both can run at once safely — `notif_log` dedup collapses the overlap. This
removes any single dependency on GitHub Actions' scheduler (which throttles).

> ⚠️ That dedup is **plain string equality on `(event_date, type)`**, and for a
> result the type is `result:<fight_key>:<group>`. So the three senders only
> collapse into one push while they build byte-identical fight keys from
> byte-identical fighter names. They didn't: scrape.py's ASCII fold drops the
> Latin letters NFKD can't decompose ("Syguła" → "Sygua") and the two JS senders
> kept them, so one bout keyed two ways and everyone who picked it was notified
> twice. All three now share the same `_fold()`, and `npm run check:dedup`
> fails the build if they drift again.
Reminders also have a **60-minute lead window**, so they tolerate a stalled run.

## Quotas & usage estimates (as of 2026-06-21)

Rough capacity check for the current cadence — recompute if intervals change.

**cron-job.org (free tier):** 3 jobs.

| Job | Interval | Runs/day |
| --- | --- | --- |
| check-results | 2 min | 720 |
| send-reminders | 2 min | 720 |
| kick-scraper | 5 min | 288 |
| **Total** | | **~1,730/day (~52k/mo)** |

Free tier allows 1-min intervals and far more than 3 jobs; each call finishes in
<7 s (worst seen: check-results ~6.7 s), well under the free ~30 s per-request
timeout. **Not near any cron-job.org limit.**

**Supabase Edge Functions (free tier = 500,000 invocations/mo):** the real
ceiling to watch. Tally of everything that hits a function:
- cron-job.org pings: ~1,730/day
- GitHub Actions backup (`scheduled-push.yml`, check-results + send-reminders +
  kick-scraper every 5 min, heavily throttled in practice): ~860/day nominal
- occasional `send-push` calls during live events

≈ **~2,300/day ≈ ~70k/mo ≈ 14% of the 500k free allotment** — comfortable
headroom.

**GitHub Actions minutes:** repo is public → runs are **free/unlimited**.

**GitHub API (`workflow_dispatch` via the PAT in `kick-scraper`):** 5,000
req/hr authenticated; `kick-scraper` fires ≤12/hr and only during live cards.
Negligible.

**If you ever need to trim** (you don't, at current usage): the two 2-min jobs
can go to 3–5 min — reminders are unaffected (60-min window); result-notification
latency rises a couple minutes.

## App data freshness vs. notifications (two clocks)

A result has **two independent delivery paths**, and they run on different clocks:

- **Notification** — `check-results` (every 2 min via cron-job.org) → `send-push`.
  Fast; arrives ~2 min after Wikipedia posts the result.
- **App fight card** — comes only from `data.js`, which is written by the
  `scrape.py` scraper in `update.yml`. That workflow's `schedule:` cron is
  throttled by GitHub (most runs dropped), so the card used to lag ~80 min.
  **`kick-scraper`** fixes this: cron-job.org pings it every 5 min and it
  dispatches `update.yml` via the (un-throttled) `workflow_dispatch` API during
  live cards, so `data.js` refreshes every ~5 min.

So a notification can legitimately arrive before the app card flips — the card
catches up on the next scrape. (While the app is open, the client live-poll also
patches results in-app every ~2 min independent of `data.js`.)

## Subscriptions (closed-app reliability)

A push only lands if the recipient's `push_subs` row is valid. Two safeguards
keep it that way (see `index.html` `_ensurePushFresh` / `sw.js`
`pushsubscriptionchange`):

- On every app load/foreground the subscription is re-validated and re-registered
  (a rotated endpoint or a row pruned after a `410` is healed).
- The service worker re-subscribes and re-registers if the browser rotates the
  subscription while the app is closed.

## Deploy

`deploy-functions.yml` deploys all functions on push to `main` touching
`supabase/functions/**`. The cron functions deploy with `--no-verify-jwt`. The
functions use the runtime's built-in `Deno.serve` (no `deno.land/std` import), so
deploys don't depend on `deno.land` uptime.

## Owner-managed config (not in the repo)

- Supabase secret `CRON_SECRET` (must match the cron-job.org URL key and the
  GitHub repo secret `CRON_SECRET`).
- cron-job.org jobs for `check-results`, `send-reminders`, and `kick-scraper`.
- Supabase secret `GH_DISPATCH_TOKEN` (GitHub PAT for `kick-scraper` — **classic,
  no expiration**, set 2026-06-21).
- VAPID keys + `SB_ANON_KEY` / `SB_SERVICE_ROLE_KEY` (pre-existing `send-push`
  secrets).

## ⚠️ Credential expiry & troubleshooting — READ THIS IF PUSH OR THE APP CARD SUDDENLY BREAKS

As of 2026-06-21, **no credential in the chain has a time-expiry:**
- `GH_DISPATCH_TOKEN` (GitHub PAT) — **no expiration** (classic PAT).
- `SUPABASE_ACCESS_TOKEN` (the Supabase token named **"GitHub Actions"**) —
  reissued with **Expires: Never** (2026-06-21, deploy re-verified). Note:
  Supabase access tokens *can* carry an expiry (set at creation) — the previous
  one was dated 31 Aug 2026.
- Everything else (`CRON_SECRET`, VAPID, legacy `SB_*`) has no time-expiry.

So a sudden break is most likely a *revocation*, a `CRON_SECRET` mismatch, or the
legacy-key deprecation (below) — not a lapse. Symptoms are usually *partial* and
easy to misdiagnose; match here first:

| Symptom | Likely cause | Where it's set | Fix |
| --- | --- | --- | --- |
| **App fight cards stop updating** (results show in notifications but not on the card); `kick-scraper` test returns `{"ok":false,"status":401/403}` | **`GH_DISPATCH_TOKEN` revoked / scope changed** (no longer expires) | Supabase → Edge Functions → Secrets | Recreate the GitHub PAT (classic no-expiry + `repo`/`workflow`, or fine-grained repo `ufc-dashboard` **Actions: R/W**) and overwrite `GH_DISPATCH_TOKEN`. See `supabase/functions/kick-scraper/README.md`. |
| **Function deploys fail** in GitHub Actions ("Deploy Supabase Functions" job, auth error) | **`SUPABASE_ACCESS_TOKEN` revoked** (now no-expiry, so not a lapse) | Supabase → Account → Access Tokens (named "GitHub Actions") → GitHub repo secret | Generate a new Supabase token (*Expires: Never*), update the `SUPABASE_ACCESS_TOKEN` repo secret, revoke the old one. |
| **All cron functions return `401 {"error":"Unauthorized"}`** | `CRON_SECRET` mismatch (rotated in one place, not the others) | Supabase secret **and** cron-job.org URLs **and** GitHub repo secret — all three must match | Re-sync the same value across all three. |
| **`check-results` test returns `UNAUTHORIZED_INVALID_JWT_FORMAT`** | function lost its `--no-verify-jwt` (e.g. redeployed without the flag) | `deploy-functions.yml` | Redeploy with `--no-verify-jwt` (already in the workflow). |
| **Result pushes stop entirely / `send-push` 401s** | legacy `SB_ANON_KEY` / `SB_SERVICE_ROLE_KEY` revoked or rotated | Supabase secrets + `index.html` client key | Reissue keys and update (see legacy-key note below). |
| **Scraper `update.yml` fails the odds step** | `ODDS_API_KEY` quota exhausted or key expired | GitHub repo secret | Top up / reissue the odds API key. |
| **App fight cards stale and `update.yml` shows no `workflow_dispatch` runs at all** | **the cron-job.org job was auto-disabled** after too many consecutive failures (happened 2026-09-05, 26 failures) | cron-job.org dashboard | Re-enable the job. Its failure history gives the status codes — a run of 502s means `GH_DISPATCH_TOKEN` (row above); timeouts mean the function was slow, not broken. |

**Fast triage:** notifications working but the **app card** stale → it's almost
always the **`GH_DISPATCH_TOKEN`** (it gates only the scraper relay, not the push
path). Test it with:
`…/functions/v1/kick-scraper?key=<CRON_SECRET>&force=1` → a `4xx` in `status`
means the token is dead (revoked/scope-changed, since it no longer expires).

> **No credential expires** as of 2026-06-21 — both the `GH_DISPATCH_TOKEN` PAT
> and the `SUPABASE_ACCESS_TOKEN` deploy token are set to *no expiration*, and
> nothing else is time-bound. No expiry reminders needed. (If you ever reissue a
> token *with* an expiry, re-add a calendar note — tokens can't be viewed after
> creation, only regenerated.)

## Future migration: legacy Supabase API keys (deprecated, not yet removed)

Supabase has **deprecated** the legacy JWT keys (`SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) in favour of a new system
(`SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS`, issued via JWT Signing
Keys). This app still uses the legacy keys:

- **Client** (`index.html`) — the anon key for REST/auth/`send-push` calls.
- **Edge functions** — the `SB_ANON_KEY` / `SB_SERVICE_ROLE_KEY` secrets.

Deprecated ≠ removed — they keep working until Supabase announces an end date.
When that happens (or proactively), do a one-time migration: issue the new
publishable/secret keys and swap them into the client anon key and the `SB_*`
function secrets. No notification-stack logic changes, just the key values.

