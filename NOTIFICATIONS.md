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

1. **cron-job.org (primary)** — one job per function, every **2 min**, no custom
   headers, secret in the URL:
   - `…/functions/v1/check-results?key=<CRON_SECRET>`
   - `…/functions/v1/send-reminders?key=<CRON_SECRET>`
2. **GitHub Actions (backup)** — `.github/workflows/scheduled-push.yml`, every
   **5 min**, POSTs both with the `Authorization: Bearer` header (repo secret
   `CRON_SECRET`).

Both can run at once safely — `notif_log` dedup collapses the overlap. This
removes any single dependency on GitHub Actions' scheduler (which throttles).
Reminders also have a **60-minute lead window**, so they tolerate a stalled run.

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
- cron-job.org jobs for `check-results` and `send-reminders`.
- VAPID keys + `SB_ANON_KEY` / `SB_SERVICE_ROLE_KEY` (pre-existing `send-push`
  secrets).
