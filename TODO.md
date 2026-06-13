# TODO

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
