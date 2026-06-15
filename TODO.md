# TODO

## Always-on server-side result-push backup (Supabase pg_cron) — needs DB changes

**Status:** open · **Added:** 2026-06-15 · **Severity:** medium (resilience) ·
**Owner action:** Andy will make the DB/Supabase changes after the event.

### Why
Result push notifications currently come from two places, both with gaps:
- **GitHub Actions scraper** — GitHub throttles scheduled runs hard (the "every
  5 min" cron effectively ran ~hourly, and not at all outside its window). On
  2026-06-14 (UFC Freedom 250) no scheduled run fired during the fights at all.
- **Client-side live poll** (`index.html` `startLivePolling` → `_pushResult`) —
  reliable and throttle-proof, but only fires while **someone has the app open**.
  If nobody's watching when a fight ends, no push.

Need a layer that fires even when no browser is open and regardless of GitHub.

### Plan
Move result detection + push into a Supabase **scheduled edge function** driven
by `pg_cron` (or `pg_net` + a cron), running every ~1 min during fight windows:
1. New edge function (e.g. `check-results`) that parses Wikipedia results for
   active events and calls the existing `send-push` for each newly-final fight,
   reusing the **same** `result:<fight_key>:<group>` type + `safe_*` payload.
2. Schedule it with `pg_cron` (Supabase Dashboard → Database → Cron), or an
   external uptime-cron (cron-job.org / Cloudflare Worker cron) pinging it.
3. Relies on the existing `notif_log` dedup, so it stacks safely with the
   client trigger and the GitHub scraper — only one push per fight ever.

### Owner must (after event)
- Create the `check-results` function and deploy it.
- Enable `pg_cron`/`pg_net` and add the schedule (or wire an external cron).
- Optionally fold in the `CRON_SECRET` hardening from "Edge-function hardening"
  below so only the cron (not the public anon key) can trigger broadcasts.

### Already shipped (code side, no DB needed)
- Client-side live poll now triggers `send-push` on each detected result
  (`index.html`), making any open browser a backup notifier.
- Scraper now also pushes from the rebuild path, guarded by `notif_log` dedup +
  a 2-day recency filter (`scrape.py` `send_push_notifications`).
- Added Sunday-ET / Monday-UTC cron windows to `.github/workflows/update.yml`
  so Sunday-night cards get covered (best-effort, still GitHub-throttled).

---

## UFCStats scraping returns 0 rows for every fighter (stats can't refresh)

**Status:** open · **Found:** 2026-06-13 · **Severity:** medium (records/odds unaffected; deep stats go stale)

### Symptom
On a scrape run, every fighter that needs a stats refresh fails with:

```
Fetching stats for 64 fighters (0 new)...
  UFCStats letter page (r): 0 rows parsed — possible structure change
  ... (every letter, every fighter) ...
  UFCStats: no match for Diego Lopes
```

`_load_ufcstats_letter()` gets HTTP 200 but `table.b-statistics__table tbody tr`
parses **0 rows**, so `_search_ufcstats()` finds no match and
`fetch_fighter_stats()` returns `None`.

### Impact
- Fighter **records and odds are unaffected** (records come from the cache /
  back-fill; odds come from the Odds API). The card face is correct.
- Only the **deep stats** (SLpM, accuracy, TD, TD def, DOB, height, recent form)
  in the "Compare Fighters" panel go stale, and only for fighters who need a
  re-fetch. Already-cached fighters keep their last-known values, which is why
  this stayed invisible.
- Concrete example masked by this: **Diego Lopes**. His cached entry is a
  different fighter named Diego Lopes (DOB Sep 26 1984, 5'5", originally 19-3).
  His record was manually corrected to 27-8-0 (held as a fallback the scraper's
  failure path preserves), but his deep stats can't repull until this is fixed.

### Likely cause
The request uses a **bot User-Agent** (`UFC-Dashboard/1.0 (github.com/AndyRBrett/ufc-dashboard)`)
over `http://`. UFCStats most likely now serves an anti-bot / interstitial page
(HTTP 200, no fighter table) to that UA / to datacenter IPs (GitHub Actions),
or changed its HTML structure. Couldn't confirm the exact returned HTML —
ufcstats.com isn't reachable from the dev sandbox (egress allowlist) and the
Actions log doesn't dump response bodies.

### Suggested fix (in priority order)
1. Use a realistic **browser User-Agent** + `https://` in `_load_ufcstats_letter()`
   and the detail fetch in `fetch_fighter_stats()`. This is the usual fix for
   "200 but empty" anti-bot responses.
2. Add **diagnostics** when 0 rows parse: log response status, length, and a
   short snippet (detect "cloudflare" / "captcha" / "challenge") so the cause is
   visible in the next run's log.
3. If it's a structure change, update the selector to match the current
   `ufcstats.com/statistics/fighters?char=<x>&page=all` table markup.
4. Once scraping works, force a fresh repull of Diego Lopes (his cached entry is
   already missing `form`, so the next successful run will refetch him with the
   hardened most-experienced matcher and self-correct DOB/height/stats).

### Related (already shipped)
- `_search_ufcstats()` now prefers the most-experienced match when multiple
  fighters share a name (covered by tests in `tests/test_parsers.py`). This is
  correct but can't take effect until the parser returns rows again.

---

## fn-live activity ticker (reactions + picks + trash-talk feed) — needs backend

**Status:** open · **Added:** 2026-06-15 · **Severity:** low (feature) ·
**Owner action:** Andy will do the Supabase side.

### Why
fn-live mode now has a pick-split bar, "on the line" stakes, and tale of the
tape filling the midsection. The remaining idea is a live **activity ticker**
("🔥 Tristin · AB picked Gaethje · 'you're cooked' —JPe$o") so the dead space
between fights feels alive. Held back because the full version needs backend:

- **Reactions** — already client-side. The `reaction` broadcast on the
  `picks-live` realtime channel carries `{e, by, uid, t}` (`_rtBroadcastReaction`
  / `_fnOnReaction`), so a reactions-only feed needs **zero backend** — it's the
  same data that already drives the floating-emoji animation.
- **Picks** — can't really populate a *live* ticker: picks lock at event start
  (`picksLocked`), so nobody is changing picks during the card. And the
  `pick-change` broadcast payload is empty (`_rtBroadcast`), so attributing
  "X picked Y" would need the broadcast enriched anyway.
- **Trash-talk** — **this is the backend dependency.** Trash-talk is delivered
  via the **push** path (`_triggerPush` → `send-push` edge function → service-
  worker `message`, `index.html:~3577` send / `:~5182` receive), *not* the
  realtime channel. To surface it in-app live for everyone you'd either (a) also
  broadcast each jab on the `picks-live` channel — but jabs can be **targeted**
  (`include_user_ids`), so blanket-broadcasting would leak targeted trash-talk to
  the whole room — or (b) persist a `trash_talk` table + realtime subscription.
  Both are backend/edge-function work.

### Plan (when backend is on the table)
1. Decide trash-talk delivery: a dedicated `trash_talk` table with realtime
   `postgres_changes` (respects targeting via row-level filters) is cleaner than
   channel-broadcasting and gives history.
2. Add a capped (~last 12), auto-expiring ticker UI in `#fnLiveBody` (above the
   reaction bar) fed by `_fnOnReaction` + the new trash-talk stream.
3. Optionally enrich the `pick-change` broadcast with `{by, fighter}` for
   pre-event pick activity (not needed during a locked live card).

### Zero-backend slice (shippable now, if wanted)
A reactions-only feed (who just reacted, with names) needs no backend — wire a
small recent-list off `_fnOnReaction`. Skipped for now because the value is in
the mixed feed; logged here so it's a known quick win.

---

## Duplicate pick rows when the scrape flips a bout's fighter order — needs DB cleanup

**Status:** open · **Added:** 2026-06-15 · **Severity:** medium (data integrity) ·
**Owner action:** Andy will do the Supabase side (dedup + optional write-time normalize).

### Why
The scrape can flip a bout's `f1`/`f2` order between runs (commonly when winners
get filled in — e.g. UFC Freedom 250's main event went `Topuria vs Gaethje` →
`Gaethje vs Topuria`, co-main `Pereira vs Gane` → `Gane vs Pereira`). The
`picks` upsert conflict target is **`(user_id, event_date, f1, f2)`**
(`index.html` `syncPick` → `POST /rest/v1/picks?on_conflict=user_id,event_date,f1,f2`).
Because `f1`/`f2` are part of the conflict key, a pick saved under the **old**
order and then re-saved after a flip lands as a **second row** instead of
updating the first. Result: the same user can hold two rows for one fight.

The **display layer is now order-agnostic** (shipped — see below), so this is
not user-visible today, but stale duplicate rows can skew anything that counts
raw rows server-side and is generally dirty data.

### Plan (DB side)
1. **Clean up existing dups:** for each `(user_id, event_date, {f1,f2} as a set)`
   keep the most recent `updated_at` row, delete the rest. A `frozenset`-style
   normalized pair (lower-name|higher-name) makes the grouping order-independent.
2. **Prevent new dups:** normalize fighter order at write time so a bout always
   stores the same `f1`/`f2` regardless of scrape order — e.g. store the pair
   sorted, or add a generated normalized-pair column and move the unique
   constraint / `on_conflict` onto `(user_id, event_date, normalized_pair)`.
   (Client `syncPick` would then send the normalized order, or a trigger
   normalizes on insert.)
3. Optional: a periodic dedup job as a backstop.

### Already shipped (client side, no DB needed)
- Leaderboard chips key picks under **both** orderings (`index.html` `nextMap`).
- `_reconcilePickOrder()` re-keys the local user's `preds`/method/conf to the
  current event-data order on every `render()`, so the fight card, local
  scoring, and the "you" chip survive a flip.
- Community-pick tally is oriented to the current fight via `_fightIndex`
  (both orders) and deduped order-agnostically.
- Leaderboard scoring already matched both orderings (`f.f1.n===p.f1 && … || …`).

---

# Code-review follow-ups (2026-06-13 full-app review)

Deferred improvements from the full-app review. Already shipped to `main`:
stored-XSS fix, performance pass (O(1) lookup, render coalescing, in-place
countdown, delegated swipe), UX/accessibility pass, icon cleanup, optional
minify build, and the version bump/footer sync.

Priority key: **P0** security · **P2** maintainability · **P3** polish.

## 1. Edge-function hardening — P0 (needs Supabase access)
Harden the push-notification broadcast path.
- Require a `CRON_SECRET` (not just the public anon key) for broadcast sends in
  `supabase/functions/send-push/index.ts` (bearer check at ~`:88-92`).
- Derive the dedup key **server-side** instead of trusting caller-supplied
  `event_date` / `type` (~`:176-195`).
- **You must:** set `CRON_SECRET` in Supabase project settings, redeploy the
  function, and update whatever cron invokes it. Code change alone won't take
  effect (and would reject the real sender until the secret is set).

## 2. Full CSP lockdown — P0 (blocked by #3)
- Remove `script-src 'unsafe-inline'` (ideally `style-src 'unsafe-inline'` too)
  from the CSP meta in `index.html` (the `<meta http-equiv="Content-Security-Policy">`).
- **Blocked until #3:** ~170 inline `onclick`/`oninput` handlers require
  `'unsafe-inline'`. The rest of the CSP is already tight (`object-src 'none'`,
  `base-uri 'self'`, locked `connect-src`/`img-src`).

## 3. De-inline handlers + modularize globals — P2
- Convert the ~170 inline event handlers to `addEventListener` (unblocks #2).
- Wrap the ~100 globals in `index.html` in a namespace/object to reduce collision
  risk and clarify state flow.
- **Test on a preview** — not run-verifiable in a sandbox; click through picks,
  themes, leaderboard, modals, and swipe before deploying.

## 4. Wire up the minify build — P2 (optional)
- `npm run build` already produces a minified `dist/` (see `build.mjs`) without
  touching source. To use it: point the host at `dist/` or add a deploy step that
  runs the build, then verify on a preview.
- Savings: index.html -14%, data.js -13%, sw.js -44%. More is possible by
  enabling name-mangling **after** #3 removes the global-name dependency.

## 5. Housekeeping — P3
- ~~**Single source of truth for the version.**~~ **Done (2026-06-15).**
  `SW_VERSION` in `sw.js` is now the only place to edit; the footer reads it live
  from the controlling service worker via a `getVersion` message, so it can't
  drift. Bumping `SW_VERSION` on deploy remains required (it's the cache-buster).
- Gate the ~16 `console.*` calls behind a `DEBUG` flag.
- Prune unused `@font-face` unicode-ranges in `index.html`.
- Consider `<dialog>` + a focus-trap for modals (Escape-to-close is done; focus
  management on open/close is not).
