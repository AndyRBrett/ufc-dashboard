# check-results — always-on server-side result-push backup

Detects newly-final UFC fights from Wikipedia and calls `send-push` for each,
so result notifications reach subscribers **even when nobody has the app open**
and regardless of whether the GitHub Actions scraper fired.

It is the third trigger alongside the client live-poll (`index.html`
`startLivePolling`) and the scraper (`scrape.py` `send_push_notifications`). All
three produce the identical `result:<fightKey>:<group>` notification type, so
the `send-push` `notif_log` (event_date, type) dedup guarantees **one push per
fight** no matter which trigger sees it first.

## How it works

Per invocation it:

1. Reads the distinct recent events people picked from `picks`
   (`event_date` in roughly `[today-2d, today+1d]`).
2. Derives each event's Wikipedia slug and fetches `prop=wikitext`.
3. Parses final results (`{{MMAevent bout}}` templates, then wikitable
   fallback) — ported byte-for-byte from `index.html`.
4. For each result, groups picks into winners/losers and POSTs win + loss
   pushes to `send-push` (spoiler-free `safe_*` payload by default).

No state table is needed: `notif_log` in `send-push` handles dedup, and the
2-day lookback mirrors the scraper's stale-spoiler guard.

To avoid re-calling `send-push` once per already-final fight on every run (each
such call just returns `{skipped:true}` but still costs an invocation), this
function reads `notif_log` once per run and skips fights already logged. That
table is service-role-only (migration `0001` blocks anon), so the read uses
`SB_SERVICE_ROLE_KEY` — for that one read only; `picks` and `send-push` still go
through the anon key. If the key is absent the read is skipped and behavior falls
back to the old path (`send-push` still dedups; only the invocation saving lost).

## Auth / config

Deployed with `--no-verify-jwt` (see `deploy-functions.yml`) so the Supabase
gateway doesn't reject the cron's non-JWT bearer before the function runs.
Inbound auth is enforced here via `CRON_SECRET`, accepted **either** way:

- `Authorization: Bearer <CRON_SECRET>` header (used by GitHub Actions), **or**
- ~~a `?key=<CRON_SECRET>` query param~~ — **removed.** This function is
  header-only now (see the auth check in `index.ts`); a secret in a query string
  lands in every log that records a URL. The cron-job.org job for this function
  must send the header, not `?key=`. Only `kick-scraper` still accepts `?key=`,
  and only until `CRON_ALLOW_QUERY_KEY=0` is set.

Anything else → 401. Outbound (this function → `send-push` and `picks`) uses the
public anon key `SB_ANON_KEY`, exactly like the web client. `send-push` is
unchanged.

| Secret               | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `CRON_SECRET`        | Authenticates the inbound cron trigger (shared with send-reminders). |
| `SB_ANON_KEY`        | Calls `send-push` + reads `picks` (already exists).      |
| `SB_SERVICE_ROLE_KEY`| Reads `notif_log` for per-run dedup (already exists).    |
| `SUPABASE_URL`       | Auto-provided by the Edge runtime.                       |

## Deploy & schedule (owner steps)

**Deploy** is automatic: `deploy-functions.yml` deploys this (with
`--no-verify-jwt`) on every push to `main` that touches `supabase/functions/**`.

**Scheduling** is external, not pg_cron — the project's `pg_net` fails to queue
requests ("Quote command returned error") and `pgaudit` blocks updating it, so
in-database cron is dead here. Two redundant triggers drive it instead (plus the
client live-poll and `scrape.py`); `notif_log` dedup means only one push per
fight goes out regardless of how many triggers fire:

1. **cron-job.org (primary)** — one job, every 2 min, with a custom request
   header (`?key=` is rejected — see Auth above):
   ```
   URL:    https://<project-ref>.supabase.co/functions/v1/check-results
   Header: Authorization: Bearer <CRON_SECRET>
   ```
2. **GitHub Actions (backup)** — `.github/workflows/scheduled-push.yml`, every
   5 min, POSTs with the `Authorization: Bearer` header (repo secret
   `CRON_SECRET`).

> See [`/NOTIFICATIONS.md`](../../../NOTIFICATIONS.md) for the full notification
> topography (all triggers, auth, and delivery paths).

## Local smoke test

```bash
supabase functions serve check-results
# With a recent event present in `picks`; either auth form works:
curl -XPOST "localhost:54321/functions/v1/check-results?key=<CRON_SECRET>"
curl -XPOST localhost:54321/functions/v1/check-results -H "Authorization: Bearer <CRON_SECRET>"
# Missing/bad secret must return 401.
```

The JSON response reports `events` scanned, `parsed` results, `pushed` count,
`skipped` (fights short-circuited by the `notif_log` pre-read), and per-group
`result`. On a second run for an already-final fight, `skipped` increments and no
`send-push` call is made; if the service-role read is unavailable the call still
goes out and returns `{skipped:true}` from `send-push` instead.
