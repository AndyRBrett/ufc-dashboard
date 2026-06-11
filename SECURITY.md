# Security Model

This document describes how secrets and data access work in the UFC Dashboard so
that the security posture is reviewable, and explains how to rotate keys.

## Architecture

- **Frontend:** a static `index.html` (vanilla, inline JS) plus a generated
  `data.js` (fight cards, odds, stats), served from the repo root via GitHub
  Pages. App code and data are separate files so a bad data write can never
  corrupt the app.
- **Backend:** Supabase (managed Postgres + Edge Functions).
- **Pipeline:** `scrape.py` runs in GitHub Actions to rebuild `data.js` and
  trigger result push notifications via the `send-push` edge function.

## What is exposed to the browser — and why it's safe

| Credential | Where it lives | Browser-exposed? | Notes |
|---|---|---|---|
| Supabase **anon** key | `index.html` | ✅ Yes | **Public by design.** Anon keys are meant to be shipped to clients. Data is protected by Row-Level Security (RLS), not by hiding this key. |
| `ANTHROPIC_API_KEY` | `ai-breakdown` edge function env | ❌ No | Server-side only. The browser calls the edge function, never Anthropic directly. |
| Supabase **service_role** key | `send-push` edge function env | ❌ No | Bypasses RLS — must never reach the client. Server-side only. |
| `VAPID_PRIVATE_KEY` | `send-push` edge function env | ❌ No | Web Push signing key. The matching public key is safe to ship. All web-push delivery happens in the edge function — `scrape.py` never holds this key. |
| `ODDS_API_KEY` | GitHub Actions secret | ❌ No | Used only by `scrape.py` in CI. |

**The anon key is not a leak.** In Supabase, the anon key identifies the project
and grants whatever the `anon` role's RLS policies allow — nothing more. The
security boundary is RLS, documented as code in
[`supabase/migrations/0001_rls_baseline.sql`](supabase/migrations/0001_rls_baseline.sql).

## Row-Level Security (the real boundary)

Because the anon key is public, every table the frontend touches must have RLS
enabled with least-privilege policies:

- `picks` — `SELECT` is public (the leaderboard is public by design). Writes
  (`INSERT`/`UPDATE`/`DELETE`) are restricted to the `authenticated` role and
  scoped to the owner via `auth.uid()::text = user_id`.
- `push_subs` / `notif_log` — no anon access; written only by the `send-push`
  edge function using the service_role key (which bypasses RLS).

### Per-user identity via anonymous auth
Because the picks table needs per-user writes but the app has no login, each
visitor is signed in through **Supabase anonymous auth** (`/auth/v1/signup`,
enabled in Authentication settings). The browser stores the returned session in
`localStorage` (`ufc_sb_session`), uses the user's JWT — not the raw anon key —
for all REST/realtime calls, and `USER_ID` is the auth `uid`. This lets RLS
enforce `auth.uid()::text = user_id`, so a user can only modify their own picks.
Edge-function calls (`ai-breakdown`, `send-push`) still send the anon key, which
is what those functions authenticate against.

See [`supabase/migrations/0001_rls_baseline.sql`](supabase/migrations/0001_rls_baseline.sql)
for the authoritative policy definitions. Keep RLS in version control: run
`supabase db pull` after any dashboard change so policies stay reviewable.

## Defenses in place

- **CSP:** `index.html` sets a locked-down Content-Security-Policy (`default-src
  'self'`, restricted `connect-src`, `object-src 'none'`, `base-uri 'self'`).
  `script-src`/`style-src` allow `'unsafe-inline'` because the app is a single
  inline-JS file on a static host; externalizing the JS to drop `'unsafe-inline'`
  is a future improvement. Note: `frame-ancestors` (clickjacking) can't be set via
  a `<meta>` tag — it requires an HTTP header, which GitHub Pages doesn't allow.
- **Edge functions:** CORS allowlist, per-IP rate limiting (both functions), and
  an anon-key bearer check on both functions. `send-push` additionally enforces
  a notification-type allowlist, title/body length caps, and only forwards
  relative same-app `url` values into push payloads. ⚠️ Remaining gap: the anon
  key is public, so anyone can still invoke `send-push` with crafted content for
  an allowed type (the `notif_log` dedup only limits repeats per
  `event_date`+`type`, and both are caller-supplied). Planned hardening: a
  `CRON_SECRET` bearer requirement for broadcast sends and server-built payloads
  for client-triggered types.
- **Secret scanning:** `gitleaks` runs in CI (`.github/workflows/secret-scan.yml`)
  on every push/PR. The public anon key is allowlisted in `.gitleaks.toml`; any
  other secret will fail the build.

## Rotating keys

- **Supabase anon / service_role:** rotate in the Supabase dashboard
  (Settings → API). Update the `SUPABASE_ANON` GitHub Actions secret and the
  embedded value in `index.html` for the anon key; update the edge function env
  for the service_role key. Update the allowlist regex in `.gitleaks.toml`.
- **`ANTHROPIC_API_KEY`, `VAPID_*`, `ODDS_API_KEY`:** rotate at the provider, then
  update the corresponding edge function env vars and/or GitHub Actions secrets.

## Reporting a vulnerability

Email andyrbrett@gmail.com with details. Please do not open a public issue for
security-sensitive reports.
