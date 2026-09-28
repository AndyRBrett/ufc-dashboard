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
| `GROK_API_KEY` (or `XAI_API_KEY`) | `ai-breakdown` edge function env | ❌ No | xAI key for the trash-talk roast only. Unset = the roast stays on Claude. |
| Supabase **service_role** key (`SB_SERVICE_ROLE_KEY`) | env of `send-push`, `check-results`, `send-reminders`, `ai-breakdown` | ❌ No | Bypasses RLS — must never reach the client. `send-push` uses it for its own tables; `check-results` and `send-reminders` send it as `X-Service-Key` to prove to `send-push` that a push is ours; `send-reminders` also writes pick lock times with it; `ai-breakdown` uses it for the daily-quota RPC. |
| `VAPID_PRIVATE_KEY` | `send-push` edge function env | ❌ No | Web Push signing key. The matching public key is safe to ship. All web-push delivery happens in the edge function — `scrape.py` never holds this key. |
| `ODDS_API_KEY` | GitHub Actions secret | ❌ No | Used only by `scrape.py` in CI. |
| `CRON_SECRET` | GitHub Actions secret, the three `--no-verify-jwt` edge function envs, and the three cron-job.org jobs | ❌ No | Inbound auth for `check-results`, `send-reminders` and `kick-scraper`, which the Supabase gateway does not JWT-check. Header only (`Authorization: Bearer`), never in a URL — see the cron bullet under **Defenses in place**. |
| `GH_DISPATCH_TOKEN` | `kick-scraper` edge function env | ❌ No | GitHub PAT used only to fire `update.yml` via `workflow_dispatch`. Anyone holding this can trigger workflows in this repo, so it should be scoped to that one workflow rather than repo-wide `actions: write`. |

**The anon key is not a leak.** In Supabase, the anon key identifies the project
and grants whatever the `anon` role's RLS policies allow — nothing more. The
security boundary is RLS, documented as code in
[`supabase/migrations/0001_rls_baseline.sql`](supabase/migrations/0001_rls_baseline.sql).

## Row-Level Security (the real boundary)

Because the anon key is public, every table the frontend touches must have RLS
enabled with least-privilege policies:

- `picks` — `SELECT` is public (the leaderboard is public by design). Writes
  (`INSERT`/`UPDATE`/`DELETE`) are restricted to the `authenticated` role and
  scoped to the owner via `auth.uid()::text = user_id`. Two triggers sit on top
  of RLS, because RLS says *whose* row it is, not *when* it may change:
  - `picks_enforce_lock` ([`0010`](supabase/migrations/0010_picks_lock.sql))
    refuses a new pick, a changed pick/method/🔒, a moved row or a delete once
    that bout's segment has started (plus 5 minutes' grace), so a direct REST
    call can't pick after the bell or delete a losing lock. Lock times live in
    `pick_locks` / `card_bells`, written by `send-reminders` with the
    service_role key and unreadable by app users. Account deletion goes through
    the `delete_my_picks()` RPC, which can only touch the caller's own rows.
  - `picks_cap_locks` ([`0005`](supabase/migrations/0005_picks_lock_cap.sql))
    clamps a third 🔒 on a card to none.
- `push_subs` / `notif_log` — no anon access; written only by the `send-push`
  edge function using the service_role key (which bypasses RLS).
- `challenges` — readable by all; only the challenger can create one, and only
  its target can answer it.
- `user_prefs` — each account reads and writes only its own row.
- `rooms` / `room_members` — visible only to a room's members, and created or
  joined only through the `create_room` / `join_room` RPCs, which refuse
  anonymous sessions (`is_account()`). Invite codes are 10 characters of
  Crockford base32, and each account gets 10 wrong codes an hour
  (`room_join_misses`, [`0008`](supabase/migrations/0008_rooms_codes_throttle.sql)).
- `ai_usage` — no client access; `ai_quota_take()` is executable by
  service_role only ([`0009`](supabase/migrations/0009_ai_quota.sql)).

### Per-user identity via anonymous auth
Because the picks table needs per-user writes but the app has no login, each
visitor is signed in through **Supabase anonymous auth** (`/auth/v1/signup`,
enabled in Authentication settings). The browser stores the returned session in
`localStorage` (`ufc_sb_session`), uses the user's JWT — not the raw anon key —
for all REST/realtime calls, and `USER_ID` is the auth `uid`. This lets RLS
enforce `auth.uid()::text = user_id`, so a user can only modify their own picks.
The same session JWT is what proves identity to the edge functions:
`ai-breakdown` requires it for every call, and `send-push` requires it for every
push a user sends. The anon key alone identifies nobody.

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
- **Edge functions:** CORS allowlist and per-IP + global rate limiting on
  `ai-breakdown` and `send-push`. The per-IP key is
  read from the right-most (gateway-appended) entry of `X-Forwarded-For`, not
  the left-most caller-supplied one, so a caller can't dodge the limiter by
  spoofing a fresh fake IP on every request; the global limit is a backstop
  that caps total volume even if IP identification is defeated some other way.
  `ai-breakdown` also caps the length of caller-supplied prompt fields
  (question/card/persona/nicknames/hint), since `max_tokens` only bounds Claude's
  output, not the input tokens a caller could otherwise inflate for free. To keep
  those caps tight, the trash-talk feature's prompt scaffolding (board framing,
  roast angles, structure rules) is assembled server-side in `ai-breakdown`'s
  `trash-talk` action — the client only sends short variable fields, never a
  pre-built prompt.
- **`ai-breakdown` is a signed-in account spending its own budget.** Every call
  needs the caller's session JWT, checked against GoTrue (`REQUIRE_SESSION=0` is
  the outage escape hatch). Each call takes from lasting daily buckets in
  `ai_usage`: per account (`AI_DAILY_CAP`, and `IQ_DAILY_CAP` for Fight IQ
  write-ups), per IP (`AI_IP_DAILY_CAP`) and one global ceiling
  (`AI_GLOBAL_DAILY_CAP`). The IP and global buckets matter because anonymous
  sign-in is open, so a fresh account is one signup away. If that table can't
  answer, the in-memory limits decide: it fails to memory, never open. A
  client-sent `viewerId` is ignored.
- **`send-push` sends only what it can vouch for.** It enforces a
  notification-type allowlist, title/body length caps and relative same-app
  `url`s, and every caller is one of three kinds:
  - **service:** our own functions, proved by `X-Service-Key` (the service_role
    key, compared in constant time). Only they may send `brief` and `swap-*`.
  - **user:** a session JWT verified with GoTrue. Social pushes (picks, nudges,
    challenges, roasts) go out as the verified sender only, with server-written
    titles and text (a challenge is read from its row), and a per-sender hourly
    cap.
  - **anon:** may only trigger the fight reminders and result pushes, which the
    server rebuilds from the committed `data.js` (parsed, never run), with the
    result audience read from `picks` itself.
- **Registering for push proves identity.** `push_subs` is keyed on `user_id`
  and `register` upserts on conflict, so whoever picks `user_id` owns that
  person's notifications from then on. The anon key cannot establish who is
  asking — it is the same for everyone — and `user_id`s are not secret either,
  since `picks` is world-readable by design. So `register` requires the caller's
  own session JWT, verified against GoTrue (`/auth/v1/user`), and refuses any
  row whose `user_id` is not the token's subject. Every *other* notification
  type still authenticates with the anon key exactly as before.
  `REQUIRE_JWT_FOR_REGISTER=0` is the rollback.
- **Push endpoints are allowlisted.** A subscription `endpoint` is a URL this
  function later POSTs to from inside Supabase's network, and `register` takes
  it from the caller — unrestricted, that is a server-side request forgery
  primitive. It must now be https and one of the four real browser push
  services, matched exactly or as a subdomain (so
  `fcm.googleapis.com.attacker.com` fails). Override with
  `PUSH_ENDPOINT_HOSTS`.
- **Cron auth is header-only, and compared in constant time.** A secret in a
  query string is written to every log that records a URL. All three
  `--no-verify-jwt` functions take `CRON_SECRET` only as `Authorization:
  Bearer`. `kick-scraper` used to accept `?key=` for cron-job.org; on
  2026-09-27 the secret was rotated, all three cron-job.org jobs moved to the
  header, and `CRON_ALLOW_QUERY_KEY=0` was set, so the old query-string secret
  is dead. Keep it at `0`. All three compare with a constant-time helper rather
  than `!==`, which returns at the first differing byte.
- **`send-reminders` never runs code it fetched.** It holds the service_role
  key, and it used to fetch `lab/*.js`, `scoring.js`, `index.html` and `data.js`
  from GitHub Pages and run them with `new Function`, so whoever could change
  what Pages served could read that key. The Lab code is now bundled into the
  function (`supabase/functions/_shared/lab-bundle.js`, kept fresh by
  `check:bundle`), and `data.js` is read by `parseDataJs`, which accepts only
  plain literals and throws on anything else. Only JSON is fetched besides it.
- **Secret scanning:** `gitleaks` runs in CI (`.github/workflows/secret-scan.yml`)
  on every push/PR. The public anon key is allowlisted in `.gitleaks.toml`; any
  other secret will fail the build.
- **Actions are pinned to commit SHAs.** `uses: owner/action@v4` resolves a tag,
  and a tag is a pointer its owner can move. These workflows hand third-party
  code `ANTHROPIC_API_KEY`, `SUPABASE_ACCESS_TOKEN`, `CRON_SECRET` and a
  `contents: write` token, so every reference is a 40-hex SHA with the tag kept
  as a trailing comment. `.github/dependabot.yml` keeps them moving, since a pin
  nobody updates is its own stale-dependency risk. (`supabase/setup-cli@v1` was
  a *branch*, not a tag — every push to it changed what the deploy job ran.)
- **Dependencies are pinned too.** Python packages install from
  `requirements.txt` / `requirements-dev.txt` with `--require-hashes`, so a
  package republished under the same version, or a new unpinned dependency,
  fails the install instead of running with `contents: write`. The Supabase CLI
  is pinned by version in `deploy-functions.yml`, and PGlite (which runs the
  real migrations in `check:picklock`) by exact version in `package.json`. Bump
  any of them on purpose, never back to `latest`.

## The automated implementer

`.github/workflows/implement.yml` hands a GitHub issue to a coding agent running
with `Bash`, `contents: write`, `pull-requests: write` and `ANTHROPIC_API_KEY`.
Its prompt begins `gh issue view <n> --comments`, which makes **the issue text
the agent's instructions** — and this repo is public, so anyone can open an issue
and anyone can comment on one.

The workflow therefore refuses to run unless the issue's `authorAssociation` is
`OWNER`, `MEMBER` or `COLLABORATOR`. That value is computed by GitHub and cannot
be set by the author. Issues filed by the overseer arrive as `OWNER`, so the
normal path is unaffected.

This check is deliberately here and not only in the dispatcher. The overseer also
checks the author before an issue enters its ledger, but that guard lives in
another repo and another process, and this workflow answers to more than the
ledger: a `workflow_dispatch`, or a `repository_dispatch` from anyone holding a
token with `actions: write` here, reaches the agent without the ledger being
consulted at all.

Do not treat a marker string in an issue body as proof of authorship. The
overseer's `_Filed by Project Overseer._` is printed in the footer of every issue
it files on public repos, so it is public text anyone can paste — it identifies
an issue, it does not authenticate one.

## Rotating keys

- **Supabase anon / service_role:** rotate in the Supabase dashboard
  (Settings → API). Update the `SUPABASE_ANON` GitHub Actions secret and the
  embedded value in `index.html` for the anon key. For the service_role key,
  update `SB_SERVICE_ROLE_KEY` in all four functions that hold it (`send-push`,
  `check-results`, `send-reminders`, `ai-breakdown`) together: a function left
  on the old key has its pushes refused by `send-push`. Update the allowlist
  regex in `.gitleaks.toml`.
- **`ANTHROPIC_API_KEY`, `GROK_API_KEY`, `VAPID_*`, `ODDS_API_KEY`:** rotate at
  the provider, then update the corresponding edge function env vars and/or
  GitHub Actions secrets.
- **`CRON_SECRET`:** it is our own value, so "rotating" means picking a new
  random string (`openssl rand -hex 32`) and setting it everywhere it is
  checked or sent, in one sitting: Supabase's Edge Function secrets (read by all
  three `--no-verify-jwt` functions), the `CRON_SECRET` GitHub Actions secret
  (`scheduled-push.yml`), and the `Authorization: Bearer` header of all three
  cron-job.org jobs (`kick-scraper`, `send-reminders`, `check-results`). A
  missed caller gets 401s until it is updated, so check the function logs
  afterwards. Leave `CRON_ALLOW_QUERY_KEY` at `0`.
- **`GH_DISPATCH_TOKEN`:** reissue the PAT on GitHub and update the `kick-scraper`
  env. Scope it to `workflow_dispatch` on `update.yml` rather than repo-wide
  `actions: write` while you are there.

## Reporting a vulnerability

Email andyrbrett@gmail.com with details. Please do not open a public issue for
security-sensitive reports.
