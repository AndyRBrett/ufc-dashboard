# Security Model

This document describes how secrets and data access work in the UFC Dashboard so
that the security posture is reviewable, and explains how to rotate keys.

**Last reviewed 2026-09-28.** Every table in `public` has RLS on, and
Supabase's security advisor reports nothing above WARN. Its WARNs are all
explained below: the lock-time RPCs, anonymous sign-ins being on (by design),
and the pg_cron defaults. The open items are under
[**Known gaps and accepted risks**](#known-gaps-and-accepted-risks).

## Architecture

- **Frontend:** a static `index.html` (vanilla, inline JS) plus a generated
  `data.js` (fight cards, odds, stats), served from the repo root via GitHub
  Pages. App code and data are separate files so a bad data write can never
  corrupt the app.
- **Backend:** Supabase (managed Postgres + Edge Functions): `send-push`,
  `ai-breakdown`, `check-results`, `send-reminders` and `kick-scraper`.
- **Pipeline:** cron-job.org calls `kick-scraper`, which dispatches
  `update.yml`; `scrape.py` rebuilds `data.js` from Wikipedia and the Odds API
  and asks `send-push` for result pushes. It sends only the anon key, so
  `send-push` rebuilds those pushes' text and audience itself (see
  **send-push** below) rather than trusting what `scrape.py` sent.
- **Readers:** the Fight Lab (`lab.html`, `lab/*.js`) and FightBot
  (`fightbot/`) read picks and cards but never write a pick, a lock or a pref.

## What is exposed to the browser — and why it's safe

| Credential | Where it lives | Browser-exposed? | Notes |
|---|---|---|---|
| Supabase **anon** key | `index.html` | ✅ Yes | **Public by design.** Anon keys are meant to be shipped to clients. Data is protected by Row-Level Security (RLS), not by hiding this key. |
| `ANTHROPIC_API_KEY` | `ai-breakdown` edge function env | ❌ No | Server-side only. The browser calls the edge function, never Anthropic directly. |
| `GROK_API_KEY` (or `XAI_API_KEY`) | `ai-breakdown` edge function env | ❌ No | xAI key for the trash-talk action only. Unset = the roast stays on Claude. |
| Supabase **service_role** key (`SB_SERVICE_ROLE_KEY`) | `send-push`, `check-results`, `send-reminders`, `ai-breakdown` edge function envs | ❌ No | Bypasses RLS — must never reach the client. `check-results` and `send-reminders` send it to `send-push` in an `X-Service-Key` header (see **send-push** below); `ai-breakdown` uses it only for the `ai_quota_take` RPC. |
| `VAPID_PRIVATE_KEY` | `send-push` edge function env | ❌ No | Web Push signing key. The matching public key is safe to ship. All web-push delivery happens in the edge function — `scrape.py` never holds this key. |
| `ODDS_API_KEY` | GitHub Actions secret | ❌ No | Used only by `scrape.py` in CI. |
| `ODDS_API_KEY_SECONDARY` | GitHub Actions secret | ❌ No | Backup Odds API key with its own quota, used by `scrape.py` when the primary's is spent. Unset = no backup provider. |
| `CRON_SECRET` | GitHub Actions secret, the three `--no-verify-jwt` edge function envs, and the three cron-job.org jobs | ❌ No | Inbound auth for `check-results`, `send-reminders` and `kick-scraper`, which the Supabase gateway does not JWT-check. Header only (`Authorization: Bearer`), never in a URL — see the cron bullet under **Defenses in place**. |
| `GH_DISPATCH_TOKEN` | `kick-scraper` edge function env | ❌ No | GitHub PAT used only to fire `update.yml` via `workflow_dispatch`. Anyone holding this can trigger workflows in this repo, so make it a fine-grained token for this one repo with only **Actions: read and write**, and an expiry date. GitHub can't narrow a token to a single workflow, so this is the tightest it gets. |
| `FORCE_SECRET` | `kick-scraper` edge function env | ❌ No | Manual-operator credential for `force=1` (dispatch regardless of the cadence gate). Never sent by the cron. Unset = forced dispatches are disabled. |

**The anon key is not a leak.** In Supabase, the anon key identifies the project
and grants whatever the `anon` role's RLS policies allow — nothing more. The
security boundary is RLS, documented as code in
[`supabase/migrations/0001_rls_baseline.sql`](supabase/migrations/0001_rls_baseline.sql).

## Row-Level Security (the real boundary)

Because the anon key is public, every table the frontend touches must have RLS
enabled with least-privilege policies:

- `picks` — `SELECT` is public (the leaderboard is public by design): one
  policy per role, `picks_select` (anon) and `picks_select_auth`
  (authenticated), since `0011_picks_read_policies.sql` removed two duplicates
  that had been made in the dashboard. Writes (`INSERT`/`UPDATE`/`DELETE`) are
  restricted to the `authenticated` role and scoped to the owner via
  `auth.uid()::text = user_id`.
- `push_subs` / `notif_log` — no anon access; written only by the `send-push`
  edge function using the service_role key (which bypasses RLS). The one
  client policy is `push_subs_delete`: a signed-in user (anonymous sign-ins
  included) may delete their **own** subscription rows.
- `picks` also carries a **server-side pick lock** (`0010_picks_lock.sql`, extended
  to every promotion by `0012_sport_pick_locks.sql`): the
  `picks_enforce_lock` trigger refuses an insert, a changed pick/method/🔒 or a
  delete once the bout's segment has started (plus a 5-minute grace), so a
  direct REST call can't change a pick after the bell either. The lock times
  (`pick_locks`, `card_bells`, and for PFL/RIZIN/DWCS `sport_pick_locks`,
  `sport_card_bells`) are revoked from `anon`/`authenticated` and
  written only by `send-reminders` with the service_role key. They can still be
  *read* through two `SECURITY DEFINER` functions, `pick_lock_at` and
  `card_first_bell`, which anyone can call over `/rest/v1/rpc`. That is on
  purpose: the trigger runs as the caller, so the caller must be able to run
  them. They return only a bout's lock time, which the app shows anyway, and
  Supabase's advisor flags them for that reason. "Delete account"
  goes through the owner-only `delete_my_picks()` RPC.
- `rooms` / `room_members` (`0006`, `0008`) — only email-linked accounts can
  create, join or see a room, enforced in the database by `is_account()`
  (a missing `is_anonymous` claim fails closed). Inserts happen only through the
  `create_room` / `join_room` RPCs. Invite codes are 10 characters of Crockford
  base32, and each account gets 10 wrong codes an hour (`room_join_misses`,
  revoked from every client role).
- `ai_usage` (`0009_ai_quota.sql`) — revoked from every client role; only
  `ai_quota_take`, executable by `service_role` alone, touches it.
- `challenges` (`0003`) — readable by anyone, like `picks`: both names, the
  fight and the stake are public. Only the challenger can insert one (as
  themselves, never against themselves), and only its target can accept or
  decline a pending one.
- `user_prefs` (`0004`) — owner-only for every operation.
- **Tables with no client policy at all** (`ai_usage`, `card_bells`,
  `notif_log`, `pick_locks`, `sport_card_bells`, `sport_pick_locks`,
  `room_join_misses`, `picks_backup_2026_09_24`):
  RLS on and no policy means the browser can't read or write them; only our
  functions (service_role) can. Supabase's advisor lists these as INFO, which
  is expected.

### Per-user identity via anonymous auth
Because the picks table needs per-user writes but the app has no password
login, each visitor is signed in through **Supabase anonymous auth**
(`/auth/v1/signup`, enabled in Authentication settings). "Link an email" is
optional: it sends a one-time code (`/auth/v1/otp`), keeps the same `user_id`,
and is what rooms require. The browser stores the returned session in
`localStorage` (`ufc_sb_session`), uses the user's JWT — not the raw anon key —
for all REST/realtime calls, and `USER_ID` is the auth `uid`. This lets RLS
enforce `auth.uid()::text = user_id`, so a user can only modify their own picks.
Edge-function calls send the user's session JWT too: `ai-breakdown` requires it
(checked against GoTrue), and `send-push` accepts it first and falls back to the
anon key only for the few backup types an anonymous caller may trigger (see
below). **Anonymous sign-in is open, so an account is not a rate limit on its
own:** a fresh `uid` is one signup call away, which is why every per-account
budget is paired with a per-IP and a global one.

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
- **Outside text never becomes HTML.** Card and fighter names are scraped from
  Wikipedia, which anyone can edit; nicknames, room names, roasts and stakes
  are other users' input; `intel.json`, `events-extra.json` and
  `overseer-status.json` are written by other processes. All of it is shown
  with `textContent` or text nodes, never `innerHTML`, which matters because
  the CSP allows inline scripts, so an injected `onerror=` handler would run.
  `npm run check:html` fails on any HTML insertion that isn't a string literal
  or one of a few reviewed expressions built from the app's own constants.
  It was added on 2026-09-28, after a card name was found reaching `innerHTML`
  in the leaderboard's empty state (an unclosed `<img … onerror=` in a title
  would have survived `scrape.py`'s tag stripping), and a card name from
  `overseer-status.json` in the odds banner. Both now use text nodes.
- **Edge functions:** CORS allowlist and per-IP + global rate limiting on
  `ai-breakdown` and `send-push`; who a caller is comes from its session JWT or
  service key (below), never from the anon key. The per-IP key is
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
  `send-push` additionally enforces
  a notification-type allowlist, title/body length caps, and only forwards
  relative same-app `url` values into push payloads.
- **send-push sends only what it can vouch for.** This closed the old gap where
  anyone holding the public anon key could push crafted text to every
  subscriber. Each caller is one of three kinds:
  - **service**: our own functions, proven by the service_role key in
    `X-Service-Key`. Trusted as given. `brief` and `swap-*` are service-only.
  - **user**: a session JWT verified with GoTrue. Social pushes go out as the
    verified sender only and are capped per sender per hour (`SENDER_LIMIT`,
    30). Pick announcements, nudges and challenges carry server-written text,
    built from the sender's own picks, the one nudge target, or the challenge
    row. Trash talk differs: the roast *is* the message, so its body is the
    sender's text (capped at `MAX_BODY`), the persona in its title is read from
    that text, and the title names the verified sender (`… (via <nickname>)`).
    Without `include_user_ids` it goes to every subscriber but the sender; with
    them, to any user IDs named (up to 60), and user IDs are public because
    `picks` is.

    **Only established players may send any social push.** Every one of them
    puts text the sender chose in front of other people (the roast, a
    self-chosen nickname, a challenge's stake), and anonymous sign-up is open,
    so a verified JWT alone proves only "somebody made an account". The sender
    must also have UFC picks on `SOCIAL_MIN_CARDS` (2) **real** cards dated at
    least two days ago; otherwise it is a 403. Real means listed in the
    committed `data.js`: a pick on a made-up date isn't refused (it locks at
    midnight after that date), so counting any old date would let a new account
    pick "today" and "tomorrow" and qualify days later. A real card's picks close
    at its bell (`0010`), so its history can't be minted: a stranger has to play
    real cards for weeks first. `data.js` keeps only the last few finished
    cards, so in practice this is two of those. The check fails closed (503 if
    `picks` or `data.js` can't be read). `SOCIAL_MIN_CARDS=0` turns it off.
    What it does not cover: an established player can still set any nickname,
    including another player's. That is a friend-group problem, not a public one.
  - **anon**: may only trigger the `main`, `prelim` and `result:*` backups. The
    server rebuilds their text and audience from the committed `data.js` (read
    with patterns, never executed) and from `picks` itself.

  `npm run check:pushauth` runs the real handler against all of this.
- **ai-breakdown spends a signed-in account's own budget.** It requires the
  caller's session JWT and takes from `ai_quota_take`: a per-account daily cap
  (`AI_DAILY_CAP`, plus `IQ_DAILY_CAP` for the Fight IQ write-up), a lasting
  per-IP bucket (`AI_IP_DAILY_CAP`) and one global ceiling
  (`AI_GLOBAL_DAILY_CAP`). If the quota table can't answer, the in-memory caps
  decide: it fails to memory, never open. A client-sent `viewerId` is ignored.
  `REQUIRE_SESSION=0` is the outage escape hatch (a bearer is then accepted
  unverified; the IP and global buckets still apply).
- **send-reminders never runs code it fetched.** It holds the service_role
  key, and it used to fetch `lab/*.js`, `scoring.js`, `index.html` and
  `data.js` from Pages and run them with `new Function`, one Pages change away
  from handing the key out. The Lab code is now bundled at build time
  (`supabase/functions/_shared/lab-bundle.js`, `npm run build:fn`,
  `check:bundle`), and `data.js` is read by `parseDataJs`, which accepts only
  the literals `scrape.py` writes and throws on anything else. Only JSON is
  fetched besides `data.js`.
- **kick-scraper reads the committed `data.js`, never runs it.** It fetches
  `data.js` from `main` on raw.githubusercontent.com (the repo is public) and
  reads it with a regex only to pick its cadence. Changed on 2026-09-27 from the
  Pages copy, which let a blocked deploy hold the scraper at the every-ping
  cadence (a feedback loop, not a security issue). Anyone who could change that
  file could already push to `main`. An unreadable file fails open to
  "dispatch", which only costs Actions minutes: the endpoint still needs
  `CRON_SECRET`, and `scrape.py` meters the Odds API itself.
- **Registering for push proves identity.** `push_subs` is keyed on `user_id`
  and `register` upserts on conflict, so whoever picks `user_id` owns that
  person's notifications from then on. The anon key cannot establish who is
  asking — it is the same for everyone — and `user_id`s are not secret either,
  since `picks` is world-readable by design. So `register` requires the caller's
  own session JWT, verified against GoTrue (`/auth/v1/user`), and refuses any
  row whose `user_id` is not the token's subject. The other notification types
  follow the caller rules under **send-push sends only what it can vouch for**
  above. `REQUIRE_JWT_FOR_REGISTER=0` is the rollback.
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
- **CI dependencies are pinned too.** Python packages install from
  `requirements.txt` / `requirements-dev.txt` with `--require-hashes` (edit the
  `.in` files and regenerate with `pip-compile --generate-hashes`), and the
  Supabase CLI is pinned by version in `deploy-functions.yml`, and PGlite
  (which runs the real migrations in `check:picklock`) by exact version in
  `package.json`. Bump them on purpose, in a commit that says so, never back to
  `latest`. The edge functions' one npm import, `npm:web-push@3.6.7` in
  `send-push`, is pinned in the import itself (`check:pushauth` fails on an
  unversioned one), since there is no Deno lockfile. The npm dev dependencies
  use caret ranges, but they only run in tests and builds, never in production.

## Settings outside the repo

Some defenses are dashboard settings, not code, so nothing here can check them.
Review them when you rotate keys:

- **Two-factor sign-in** on the GitHub and Supabase accounts, with a passkey or
  an authenticator app. Either account can change the live app, so these
  logins are the real perimeter.
- **Branch protection on `main`:** require a pull request and the CI checks to
  pass. A push to `main` deploys the site.
- **Provider spending caps:** a monthly limit in the Anthropic and xAI
  consoles. It is the backstop if every rate limit in `ai-breakdown` fails at
  once.
- **CAPTCHA on sign-up and email codes** (Supabase → Authentication → Bot and
  Abuse Protection, with Cloudflare Turnstile). Not on yet. Without it, anyone
  can script anonymous accounts in bulk and use "Link an email" to send codes to
  other people's inboxes; Supabase's built-in email rate limits are the only
  brake. Turning it on also needs an app change: `index.html` has to render the
  Turnstile widget, send its token as `captcha_token` on `/auth/v1/signup` and
  `/auth/v1/otp`, and the CSP must allow `challenges.cloudflare.com`. Turn the
  setting on only after that change ships, or every new visitor's sign-in
  fails.

## Known gaps and accepted risks

What is still open, and why. Revisit this list at each review.

- **No CAPTCHA yet.** See **Settings outside the repo**. Until it is on, bulk
  anonymous accounts are possible. What they can reach is limited: every
  per-account budget has a per-IP and global one beside it, and social pushes
  need an established player.
- **`'unsafe-inline'` in the CSP, and no `frame-ancestors`.** The app is one
  inline-JS file on GitHub Pages, which can't send headers. The mitigation is
  the rule above: outside text never becomes HTML (`check:html`). Moving the JS
  into files, or hosting behind a CDN that sets headers, would close both.
- **An established player can set any nickname**, including another player's,
  and push as it. That is a friend-group problem, not an outsider one.
- **Public by design:** picks, nicknames, user IDs and challenges can be read
  by anyone holding the anon key (the leaderboard needs them), and the repo,
  including `data.js`, is public. Don't put anything private in those tables.
- **`kick-scraper` fails open** on an unreadable `data.js`: it dispatches the
  scraper, which costs only Actions minutes, since the endpoint still needs
  `CRON_SECRET`.
- **`picks_backup_2026_09_24`** is a full copy of every pick, kept for the
  engine-migration rollback (`docs/ROLLBACK.md`). No client can read it. Drop it
  once that rollback window is closed.
- **pg_cron's own policies** (`cron.job`, `cron.job_run_details`) show as
  advisor WARNs. They are Supabase's defaults and scope rows to the job's owner,
  and neither `anon` nor `authenticated` has usage on the `cron` schema, so the
  browser can't reach those tables at all.

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
  embedded value in `index.html` for the anon key; update the edge function env
  for the service_role key (`SB_SERVICE_ROLE_KEY` in all four functions that
  hold it: `send-push`, `check-results`, `send-reminders`, `ai-breakdown`). A
  partial update breaks the `X-Service-Key` handshake, and the Friday brief and
  swap alerts stop sending. Update the allowlist regex in `.gitleaks.toml`.
- **`ANTHROPIC_API_KEY`, `GROK_API_KEY`, `VAPID_*`, `ODDS_API_KEY` /
  `ODDS_API_KEY_SECONDARY`:** rotate at the provider, then update the
  corresponding edge function env vars and/or GitHub Actions secrets.
- **`CRON_SECRET`:** it is our own value, so "rotating" means picking a new
  random string (`openssl rand -hex 32`) and setting it everywhere it is
  checked or sent, in one sitting: Supabase's Edge Function secrets (read by all
  three `--no-verify-jwt` functions), the `CRON_SECRET` GitHub Actions secret
  (`scheduled-push.yml`), and the `Authorization: Bearer` header of all three
  cron-job.org jobs (`kick-scraper`, `send-reminders`, `check-results`). A
  missed caller gets 401s until it is updated, so check the function logs
  afterwards. Leave `CRON_ALLOW_QUERY_KEY` at `0`.
- **`GH_DISPATCH_TOKEN`:** reissue the PAT on GitHub and update the `kick-scraper`
  env. Make it fine-grained: this repo only, **Actions: read and write** only,
  with an expiry. GitHub can't limit a token to one workflow, so that is the
  narrowest possible.
- **`FORCE_SECRET`:** our own value; set a new random string in the
  `kick-scraper` env. Only people who trigger forced runs by hand need it.

## Reporting a vulnerability

Email andyrbrett@gmail.com with details. Please do not open a public issue for
security-sensitive reports.
