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
the cron call needs no headers — just `?key=<CRON_SECRET>`, identical to
`check-results` / `send-reminders`.

## How it works

1. Authenticates the caller via `CRON_SECRET` (header **or** `?key=`).
2. **Quota guard:** fetches `data.js` and dispatches only when an event dated
   today/yesterday (UTC — cards cross midnight) still has an unfinished
   (`state:"pre"`) bout. Off-days it returns `{"dispatched":false,"reason":"no live card"}`
   so `scrape.py` doesn't burn odds-API quota. The guard **fails open** (any
   fetch/parse error → dispatch anyway), and `?force=1` bypasses it.
3. POSTs `workflow_dispatch` for `update.yml` on `main`; GitHub returns 204.

## Config

| Secret / env        | Purpose                                                  |
| ------------------- | -------------------------------------------------------- |
| `CRON_SECRET`       | Inbound auth (shared with the other cron functions).     |
| `GH_DISPATCH_TOKEN` | **New.** Fine-grained GitHub PAT, repo-scoped to `ufc-dashboard`, **Actions: Read and write**. |
| `GH_REPO`           | Optional, default `AndyRBrett/ufc-dashboard`.            |
| `GH_WORKFLOW`       | Optional, default `update.yml`.                          |
| `GH_REF`            | Optional, default `main`.                                |
| `DATA_URL`          | Optional, schedule source for the live-card guard.       |

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
   The guard means a 24/7 every-5-min schedule is safe — it only dispatches the
   scraper around live cards.

## Smoke test

```bash
# Forces a dispatch regardless of the live-card guard:
curl -XPOST "https://<ref>.supabase.co/functions/v1/kick-scraper?key=<CRON_SECRET>&force=1"
# Expect {"ok":true,"dispatched":true,...}; then update.yml shows a
# workflow_dispatch run in the Actions tab.
```

See [`/NOTIFICATIONS.md`](../../../NOTIFICATIONS.md) for the full topography.
