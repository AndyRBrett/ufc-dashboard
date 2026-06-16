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

- **Inbound** (the cron → this function): gated by `CRON_SECRET`. Requests must
  send `Authorization: Bearer <CRON_SECRET>`; anything else gets 401.
- **Outbound** (this function → `send-push` and `picks`): uses the public anon
  key `SB_ANON_KEY`, exactly like the web client. `send-push` is left unchanged.

| Secret               | Purpose                                                  |
| -------------------- | -------------------------------------------------------- |
| `CRON_SECRET`        | Authenticates the inbound cron trigger (new).            |
| `SB_ANON_KEY`        | Calls `send-push` + reads `picks` (already exists).      |
| `SB_SERVICE_ROLE_KEY`| Reads `notif_log` for per-run dedup (already exists).    |
| `SUPABASE_URL`       | Auto-provided by the Edge runtime.                       |

## Deploy & schedule (owner steps)

```bash
# 1. Deploy
supabase functions deploy check-results

# 2. Set the cron secret (SB_ANON_KEY / SUPABASE_URL already exist project-wide)
supabase secrets set CRON_SECRET="$(openssl rand -hex 24)"
```

Enable the `pg_cron` and `pg_net` extensions (Supabase → Database → Extensions),
then schedule it (Database → Cron, or SQL). Every 2 min matches the client
cadence; on days with no in-window events the function returns cheaply.

```sql
select cron.schedule('check-results-2m', '*/2 * * * *', $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/check-results',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer <CRON_SECRET>')
  );
$$);
```

To unschedule: `select cron.unschedule('check-results-2m');`

**External-cron fallback:** if you'd rather not enable pg_cron/pg_net, point
cron-job.org or a Cloudflare Worker cron at the same URL with the same
`Authorization: Bearer <CRON_SECRET>` header.

## Local smoke test

```bash
supabase functions serve check-results
# With a recent event present in `picks`:
curl -XPOST localhost:54321/functions/v1/check-results \
  -H "Authorization: Bearer <CRON_SECRET>"
# Missing/bad bearer must return 401.
```

The JSON response reports `events` scanned, `parsed` results, `pushed` count,
`skipped` (fights short-circuited by the `notif_log` pre-read), and per-group
`result`. On a second run for an already-final fight, `skipped` increments and no
`send-push` call is made; if the service-role read is unavailable the call still
goes out and returns `{skipped:true}` from `send-push` instead.
