# Deferred TODOs

Improvements identified during the 2026-06-13 review that were intentionally
deferred (need external setup, a preview to test, or a larger refactor). Already
shipped to `main`: the stored-XSS fix, performance pass, UX/accessibility pass,
icon cleanup, the optional minify build, and the version bump/footer sync.

Priority key: **P0** security · **P2** maintainability · **P3** polish.

---

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
  from the CSP meta in `index.html:9`.
- **Blocked until #3:** ~170 inline `onclick`/`oninput` handlers require
  `'unsafe-inline'`. The rest of the CSP is already tight (`object-src 'none'`,
  `base-uri 'self'`, locked `connect-src`/`img-src`).

## 3. De-inline handlers + modularize globals — P2
- Convert the ~170 inline event handlers to `addEventListener` (this unblocks #2).
- Wrap the ~100 globals (`index.html:~950-1043`) in a namespace/object to reduce
  collision risk and clarify state flow.
- **Test on a preview** — not run-verifiable in a sandbox; click through the app
  (picks, themes, leaderboard, modals, swipe) before deploying.

## 4. Wire up the minify build — P2 (optional)
- `npm run build` already produces a minified `dist/` (see `build.mjs`) without
  touching source. To use it: point the host at `dist/` or add a deploy step that
  runs the build, then verify on a preview.
- Current savings: index.html -14%, data.js -13%, sw.js -44%. More is possible by
  enabling name-mangling **after** #3 removes the global-name dependency.

## 5. Housekeeping — P3
- **Single source of truth for the version.** It currently lives in two
  hand-edited places that already drifted once: `sw.js:5` (`SW_VERSION`) and
  `index.html:4039` (footer `v…` literal). Derive both from one constant (or a
  build/git step) so they can't fall out of sync. **Until then, bump both on
  every release.**
- Gate the ~16 `console.*` calls behind a `DEBUG` flag.
- Prune unused `@font-face` unicode-ranges (`index.html:~20-29`).
- Consider `<dialog>` + a focus-trap for modals (Escape-to-close is done; focus
  management on open/close is not).
