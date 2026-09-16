# kick-scraper — reliable trigger for the data scraper

Triggers `update.yml` (the `scrape.py` scraper that writes `data.js`) via
GitHub's **`workflow_dispatch`** API, so the app's fight cards stay fresh even
though GitHub throttles `schedule:` cron.

## Why this exists

`update.yml` is scheduled every 5 min during fight windows, but GitHub runs
`schedule:` events best-effort and drops most of them under load — during one
Saturday window ~6 of ~96 expected runs fired (~80 min apart). So `data.js`
(the only source of the app's fight results/odds) went stale. **API-dispatched**
runs are not throttled that way, so pinging `workflow_dispatch` on a reliable
external schedule keeps the scraper actually running every few minutes.

The GitHub token lives **here** (server-side) rather than in cron-job.org, so
the cron call only needs to prove it is the cron. That was originally done with
`?key=<CRON_SECRET>`, identical to `check-results` / `send-reminders` — which
turned out to publish the secret into the request logs, so header auth is now
the documented form. See [Security](#security).

## How it works

1. Authenticates the caller via `CRON_SECRET` (header **or** `?key=`). `?force=1`
   takes a **different** secret, `FORCE_SECRET`, by header — see
   [Security](#security).
2. **Cadence gate:** fetches `data.js` and reads how hard the scraper should be
   driven right now:

   | mode | when | behaviour |
   | ---- | ---- | --------- |
   | `live` | an event dated today/yesterday (UTC — cards cross midnight) still has an unfinished (`state:"pre"`) bout | dispatch on **every** ping (~5 min) |
   | `fight-week` | an unfinished card is within `FIGHT_WEEK_DAYS` (7) | dispatch at most once per `FIGHT_WEEK_MIN_GAP_MIN` (60) |
   | `idle` | nothing closer than that | `{"dispatched":false,"reason":"no card in range"}` |

   Both gates **fail open**: an unreadable `data.js` is treated as a live card,
   and an unreadable Actions API (the fight-week thinning reads `update.yml`'s
   last run from it) dispatches rather than skipping. Skipping there would be
   silent — a revoked `GH_DISPATCH_TOKEN` fails that lookup on every ping, and a
   skip returns 200, which both the cron and `scheduled-push.yml` read as
   healthy. Dispatching instead puts a dead credential in front of the 502 path,
   which already alarms. The live path never consults the Actions API at all.
3. POSTs `workflow_dispatch` for `update.yml` on `main`; GitHub returns 204.

### Why fight week dispatches at all

It used to be live-days-only, on the stated grounds of not burning odds-API
quota off-days. That reasoning doesn't hold: `scrape.py` gates every Odds API
call itself (`ODDS_PULL_INTERVALS` — 2h–24h by proximity, backed off further on a
quiet market), so an extra run spends Actions minutes (free, public repo) and
nothing metered. A run that finds nothing new writes no commit.

What the old gate *did* cost was the whole non-fight week: with it closed, the
only thing left driving the scraper is GitHub's `schedule:`, which is throttled
to roughly one delivered run a day (measured 2026-09-15 and -16: one each, both
~5h late, zero in the 23h between). So Ortega/Moicano came off UFC 331 four days
out and the app kept showing the bout — nothing was running often enough to
notice, and fight week is exactly when withdrawals and replacements land.

`npm run check:kick` pins both directions: a live card must not be thinned to
hourly, and an idle week must not dispatch.

## Config

| Secret / env        | Purpose                                                  |
| ------------------- | -------------------------------------------------------- |
| `CRON_SECRET`       | Inbound auth (shared with the other cron functions).     |
| `GH_DISPATCH_TOKEN` | **New.** Fine-grained GitHub PAT, repo-scoped to `ufc-dashboard`, **Actions: Read and write**. |
| `GH_REPO`           | Optional, default `AndyRBrett/ufc-dashboard`.            |
| `GH_WORKFLOW`       | Optional, default `update.yml`.                          |
| `GH_REF`            | Optional, default `main`.                                |
| `DATA_URL`          | Optional, schedule source for the cadence gate.          |
| `FIGHT_WEEK_DAYS`   | Optional, default `7`. How far out counts as fight week. |
| `FIGHT_WEEK_MIN_GAP_MIN` | Optional, default `60`. Minimum minutes between fight-week dispatches. |
| `FORCE_SECRET`      | Optional. Separate operator credential for `?force=1`; unset disables forcing. |

Deployed with `--no-verify-jwt` by `deploy-functions.yml`.

## Setup (owner steps)

1. **Create the token:** GitHub → Settings → Developer settings → Fine-grained
   tokens → only `AndyRBrett/ufc-dashboard`, Permissions → **Actions: Read and
   write**. Copy it.
   > 🔑 **Current token (set 2026-06-21) is a classic PAT with _no expiration_,**
   > so it won't lapse. If `kick-scraper` ever returns
   > `{"ok":false,"status":401/403}` — app fight cards stop refreshing **while
   > notifications keep working** — the token was revoked or its scope changed;
   > recreate it and overwrite `GH_DISPATCH_TOKEN`. (Fine-grained PATs expire,
   > 90-day default, if you switch back to one.) See the credential table in
   > `/NOTIFICATIONS.md`.
2. **Store it:** `supabase secrets set GH_DISPATCH_TOKEN=<paste>` (or dashboard →
   Edge Functions → Secrets).
3. **Schedule it on cron-job.org:** one job, every 5 min, no headers:
   ```
   https://gkccophrdqtqcowmblre.supabase.co/functions/v1/kick-scraper?key=<CRON_SECRET>
   ```
   The gate means a 24/7 every-5-min schedule is safe — it only dispatches every
   ping around a live card, thins to hourly in fight week, and declines
   otherwise.

   > 🔐 Prefer `Authorization: Bearer <CRON_SECRET>` over `?key=` — see
   > [Security](#security). The query form still works so that migrating the job
   > is never urgent, but the secret is logged on every request while it is in
   > use.

   > ⚠️ **cron-job.org disables a job after enough consecutive failures.** This
   > happened on 2026-09-05 (26 failures, on a fight day). If the card stops
   > refreshing, check that the job is still *enabled* there before anything
   > else — a disabled job looks identical to a broken function from here.

## Backup trigger

`.github/workflows/scheduled-push.yml` also pings this every 5 min (header auth,
alongside `check-results` / `send-reminders`). GitHub throttles `schedule:` hard
— that throttling is the entire reason this function exists — so the backup
fires every few hours at best, not every 5 minutes. It is not a replacement for
the cron-job.org job; it exists so that losing that job degrades the card to
"hours stale" instead of "not updating at all", and so a dead
`GH_DISPATCH_TOKEN` produces a failed workflow run GitHub emails about.

A dispatch failure is announced in three places now: the `::error::` in that
workflow step, a `console.error` in the Supabase function logs, and a `hint`
field in the 502 response body naming the likely fix.

## Smoke test

```bash
# Forces a dispatch regardless of the cadence gate. Takes FORCE_SECRET, NOT
# CRON_SECRET, and only as a header; 403 otherwise (see Security). If
# FORCE_SECRET is unset on the deployment, forcing is disabled outright.
curl -XPOST "https://<ref>.supabase.co/functions/v1/kick-scraper?force=1" \
  -H "Authorization: Bearer <FORCE_SECRET>"
# Expect {"ok":true,"dispatched":true,...}; then update.yml shows a
# workflow_dispatch run in the Actions tab.

# What the scheduled caller sees (gate applies):
curl -XPOST "https://<ref>.supabase.co/functions/v1/kick-scraper" \
  -H "Authorization: Bearer <CRON_SECRET>"
# {"dispatched":false,"reason":"fight-week cadence: too soon",...} is healthy.
```

## Security

**`?key=` puts `CRON_SECRET` in the URL, and Supabase logs the full URL of every
request.** It is readable in plaintext by anyone who can open the project's edge
logs, for as long as the logs are retained — confirmed present on 2026-09-16.
This is the worst function for that to happen to: `GH_DISPATCH_TOKEN` lives here,
so the secret is a route to firing workflows in the repo.

Mitigated in code as far as it can be: `force=1` — the only input that bypasses
the cadence gate, and so the only way to turn a leaked credential into unbounded
workflow runs — now takes a **separate** secret, `FORCE_SECRET`, supplied by
header. Moving `force` to header auth on `CRON_SECRET` would have bought
nothing: the leaked value and the header value are the same string, so anyone
reading it out of a logged URL could simply send it as `Authorization: Bearer`.
A distinct credential that never travels in a URL is the only version of this
that contains the actual threat. When `FORCE_SECRET` is unset, forcing is
disabled — the safe default, since nothing automated uses it.

Whoever holds a leaked `CRON_SECRET` can therefore do exactly what the cron
already does, at the cadence the gate allows, and nothing more. That is a
smaller blast radius, **not** a fix: rotation below is the fix.

Closing it properly is three owner steps, in this order:

1. **Move the cron-job.org job to header auth.** Same URL without `?key=`, plus
   a request header `Authorization: Bearer <CRON_SECRET>`. Verify a ping returns
   200 rather than 401 before continuing.
2. **Rotate `CRON_SECRET`** (`supabase secrets set CRON_SECRET=…`), then update
   it in the cron-job.org job and in the `CRON_SECRET` GitHub Actions secret that
   `scheduled-push.yml` uses. The old value has been logged for months; moving to
   headers does not un-log it, and the logged value keeps working until it is
   rotated. **This step is the actual fix — 1 and 3 only stop the bleeding.**
3. **Set `CRON_ALLOW_QUERY_KEY=0`** to refuse the query form outright. No code
   change — the switch already exists.

Do **not** do 3 before 1: the query path is what the live dispatcher currently
authenticates with, and closing it first stops the scraper mid-card.

`check-results` and `send-reminders` share `CRON_SECRET` and the same `?key=`
habit. They hold no GitHub token, so the blast radius is smaller, but step 2
rotates their credential too — migrate those jobs in the same sitting.

See [`/NOTIFICATIONS.md`](../../../NOTIFICATIONS.md) for the full topography.
