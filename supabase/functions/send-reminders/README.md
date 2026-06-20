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

- **Inbound** (cron → this function): gated by `CRON_SECRET`; requests must send
  `Authorization: Bearer <CRON_SECRET>`, else 401.
- **Outbound** (this function → `send-push`): uses the public anon key
  `SB_ANON_KEY`, exactly like the web client.

| Secret         | Purpose                                                   |
| -------------- | -------------------------------------------------------- |
| `CRON_SECRET`  | Authenticates the inbound cron trigger (already exists if check-results is set up). |
| `SB_ANON_KEY`  | Calls `send-push` (already exists).                       |
| `SUPABASE_URL` | Auto-provided by the Edge runtime.                       |
| `DATA_URL`     | Optional override for the schedule source (defaults to the GitHub Pages `data.js`). |

## Deploy & schedule (owner steps)

The GitHub Actions workflow `deploy-functions.yml` deploys this on push to
`main`. To deploy manually / set the secret:

```bash
supabase functions deploy send-reminders
# Reuse the same CRON_SECRET as check-results (skip if already set):
supabase secrets set CRON_SECRET="$(openssl rand -hex 24)"
```

Schedule it with pg_cron (Database → Cron, or SQL). Every ~5 min comfortably
catches the 1-hour lead window; on days with no in-window event it returns
cheaply.

```sql
select cron.schedule('send-reminders-5m', '*/5 * * * *', $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer <CRON_SECRET>')
  );
$$);
```

To unschedule: `select cron.unschedule('send-reminders-5m');`

**External-cron fallback:** point cron-job.org or a Cloudflare Worker cron at the
same URL with the same `Authorization: Bearer <CRON_SECRET>` header.

## Local smoke test

```bash
supabase functions serve send-reminders
curl -XPOST localhost:54321/functions/v1/send-reminders \
  -H "Authorization: Bearer <CRON_SECRET>"
# Missing/bad bearer must return 401.
```

The JSON response reports `events` in window, `fired` phase-reminders attempted,
and total `sent`. Reminders only POST when a phase is within the hour before its
start, so off-window runs report `fired: 0`.
