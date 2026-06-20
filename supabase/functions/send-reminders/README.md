# send-reminders — always-on server-side fight reminders

Sends the **"Main Card / Prelims starting in under 1 hour"** push reminders so
they reach subscribers **even when nobody has the app open**.

These reminders used to fire only from the web client (`index.html`
`checkNotifSchedule`, a 5-min `setInterval`). That works only while *someone*
has the app open near event time — if every phone is closed an hour before the
card, no reminder goes out. This scheduled function is the server-side trigger
that guarantees delivery.

It produces the same `main` / `prelim` notification types, keyed on the event
date, that the client does, so `send-push`'s `notif_log` (event_date, type)
dedup guarantees **one reminder per event per phase** regardless of which
trigger (an open client or this cron) reaches it first. The client code is left
in place as a harmless redundant trigger — exactly like `check-results`
coexists with the client live-poll for results.

## How it works

Per invocation it:

1. Fetches the published `data.js` (the same schedule the PWA loads, regenerated
   by `scrape.py`) and parses each event's `name` / `date` / `time` /
   `prelimTime`.
2. Converts each phase's wall-clock Eastern time to UTC (`etOffset()` is
   replicated from `index.html`).
3. For any phase starting within the next hour (and not already started), POSTs a
   `main` / `prelim` push to `send-push`. TBD times are skipped.

No state table is needed: `notif_log` in `send-push` handles dedup.

## Auth / config

Deployed with `--no-verify-jwt` (see `deploy-functions.yml`) so the Supabase
gateway doesn't reject the cron's non-JWT bearer before the function runs.
Inbound auth is enforced here via `CRON_SECRET`, accepted **either** way:

- `Authorization: Bearer <CRON_SECRET>` header (used by GitHub Actions), **or**
- a `?key=<CRON_SECRET>` query param (used by cron-job.org — no custom headers).

Anything else → 401. Outbound (this function → `send-push`) uses the public anon
key `SB_ANON_KEY`, exactly like the web client.

| Secret         | Purpose                                                   |
| -------------- | -------------------------------------------------------- |
| `CRON_SECRET`  | Authenticates the inbound cron trigger (shared with check-results). |
| `SB_ANON_KEY`  | Calls `send-push` (already exists).                       |
| `SUPABASE_URL` | Auto-provided by the Edge runtime.                       |
| `DATA_URL`     | Optional override for the schedule source (defaults to the GitHub Pages `data.js`). |

## Deploy & schedule (owner steps)

**Deploy** is automatic: `deploy-functions.yml` deploys this (with
`--no-verify-jwt`) on every push to `main` that touches `supabase/functions/**`.

**Scheduling** is external, not pg_cron — the project's `pg_net` fails to queue
requests ("Quote command returned error") and `pgaudit` blocks updating it, so
in-database cron is dead here. Two redundant triggers drive it instead, and
`send-push`'s `notif_log` dedup makes the overlap free:

1. **cron-job.org (primary)** — one job per function, every 2 min, **no
   headers**, just the URL with the secret in the query string:
   ```
   https://<project-ref>.supabase.co/functions/v1/send-reminders?key=<CRON_SECRET>
   ```
2. **GitHub Actions (backup)** — `.github/workflows/scheduled-push.yml`, every
   5 min, POSTs with the `Authorization: Bearer` header (repo secret
   `CRON_SECRET`).

A 2–5 min cadence comfortably catches the 1-hour lead window; off-window runs
return cheaply (`fired: 0`).

> See [`/NOTIFICATIONS.md`](../../../NOTIFICATIONS.md) for the full notification
> topography (all triggers, auth, and delivery paths).

## Local smoke test

```bash
supabase functions serve send-reminders
# Either auth form works:
curl -XPOST "localhost:54321/functions/v1/send-reminders?key=<CRON_SECRET>"
curl -XPOST localhost:54321/functions/v1/send-reminders -H "Authorization: Bearer <CRON_SECRET>"
# Missing/bad secret must return 401.
```

The JSON response reports `events` in window, `fired` phase-reminders attempted,
and total `sent`. Reminders only POST when a phase is within the hour before its
start, so off-window runs report `fired: 0`.
