# Pick Engine, Fight Lab & FightBot

The UFC app (`index.html`) still takes every pick, closes every lock and scores
the board. Beside it sits a small platform that **reads** what the app stores
and never writes to it:

```
             data.js ─┐                 ┌─ lab.html        (Fight Lab page)
   odds-series.json ─┤                 │
         intel.json ─┼─► lab/engine.js ─┼─► lab/analytics.js
 events-extra.json ─┤   (normalize +   │
   picks (public) ─┘    score)         └─ fightbot/        (MCP server)
                            ▲
          index.html ───────┘  scoring + fight model lifted out at load
```

| file | what it is |
| ---- | ---------- |
| `lab/engine.js` | The sport-agnostic core: normalized model, adapters, rules, pick resolution |
| `lab/analytics.js` | Fight IQ and the Fight IQ player card (`fightCard`), market movers / CLV, fight-week brief, matchup, backtest, watch-party ticker. All deterministic |
| `lab.html` | The Fight Lab page (⋯ menu → Fight Lab) |
| `fightbot/core.mjs` | FightBot's tools, built on the two modules above |
| `fightbot/server.mjs` | Zero-dependency MCP server over stdio |
| `events-extra.json` | Non-UFC cards (PFL first), built by `extra.py`; empty until publishing is switched on |

## The one rule: scoring is shared, never copied

`PickEngine.loadKernel(indexHtml, env, compile, scoringSrc)` runs the app's own
**`scoring.js`** whole: every scoring function (name matching, `pickPts`,
`userPts`, locks, the dog bonus, `_boutLookup`, `_eventFinished`,
`_lbScoreUsers`) lives there and nowhere else, and the app loads the same file.
From `index.html` it lifts only what isn't scoring: the fight model
(`// model:start … :end`) and the two Fight Week Intel filters (`intelKey`,
`intelItemsFor`). Everything is compiled against the data.js globals, so every
score the Lab, FightBot or the Friday brief shows is the board's score, and the
fight model is the model under the moneyline on the cards.

If a scoring function, the model markers or an intel filter is renamed,
`loadKernel` throws and `check:lab` / `check:fightbot` fail the build.

In the browser the kernel is compiled through an injected inline `<script>`
(`compileInline` in `lab.html`) rather than `new Function`, so the page's CSP
needs no `'unsafe-eval'`.

## Normalized model

```
Promotion { id, name, sport }
Event     { id, promotion, name, date, venue, location, broadcast, source,
            segments: [{ id: "main" | "prelims" | "early", name, time }],
            bouts: [Bout], fotn }
Bout      { id, eventId, order, label, segment, division, title,
            competitors: [Competitor, Competitor],
            result: { winner, method, round } | null, state, raw }
Competitor{ name, record, rank, odds }
```

Ids are namespaced by promotion (`ufc:2026-09-26:slug#a|b`), so two promotions
on one Saturday can never share a bout.

## Adapters

An adapter is `{ id, promotion?, events() → Event[] }`.

- **`ufcAdapter(env)`** reads `EVENTS` (the live window) and `RESULTS_ARCHIVE`
  (cards that aged out). It is the only source of UFC cards.
- **`feedAdapter(feed)`** reads a curated feed (`events-extra.json`). The feed
  is untrusted input, validated as a whole: an invalid event is dropped and
  listed in `problems`, and it's never half-loaded.

### Adding PFL / ONE / boxing: the feed format

```json
{
  "promotions": [{ "id": "pfl", "name": "PFL", "sport": "mma" }],
  "events": [{
    "promotion": "pfl", "name": "PFL World Tournament 5", "date": "2026-10-10",
    "venue": "…", "location": "…", "broadcast": "…", "time": "20:00",
    "bouts": [
      { "a": "Fighter One", "b": "Fighter Two", "label": "Main Event",
        "division": "Lightweight", "title": false,
        "odds": { "a": -150, "b": 130 },
        "winner": "", "method": "", "round": null }
    ]
  }]
}
```

Rules the validator enforces:

- `promotion.id` is 2–20 chars of `[a-z0-9-]`, and **`ufc` is reserved**. The feed
  can't shadow or duplicate the scraped card.
- `date` is `YYYY-MM-DD`; every event has a name and at least one bout.
- Every bout names two different fighters; a `winner`, if set, must be one of them.

Feed promotions score on `simpleRules()`: 1 for the winner, +0.5 for the
method. Pass your own rules object to `createEngine({ rules: { pfl: … } })` to
change that.

**Where the feed comes from:** `extra.py`, in `update.yml` after the intel
step. It reads PFL's events list and each event's article (or its section of
the year page) from Wikipedia with `scrape.py`'s own parsers, keeps only cards
with at least two real bouts, and never drops a card on a failed fetch. It
starts in **shadow mode**: output goes to `events-extra.candidate.json` and a
report to `extra-state.json`, and `events-extra.json` is untouched until
`EXTRA_PUBLISH=1` is set on that step after a real run has been checked
against the actual card. `tests/test_extra.py` holds it.

Picks on feed promotions **are** wired into the app (#184, #185): the sport
switcher shows a promotion's cards, stores its picks tagged with its
promotion, and scores them on their own board (`sportStandings`). It stays
hidden until `events-extra.json` has a card worth picking, which is why
publishing is gated on checking a real candidate first: nothing here should
state a card that isn't happening.

## Rules

A ruleset is `{ id, same(nameA, nameB), isLock(row), score(pick, bout) }`.

- `ufcRules(kernel)` delegates to the app: `nmEq`, `isLockPick`, `pickPts`.
  Summed per player and plus the FOTN bonus, it equals the board's `userPts`
  exactly. `check:lab` asserts that.
- `simpleRules({ winner, method })` is the default for everything else.

## Analytics: honesty rules

- **Sample floor.** No Fight IQ insight is claimed on fewer than
  `MIN_SAMPLE` (5) decided picks in a split.
- **De-vigged market.** Every market probability has the margin divided out
  (`PickEngine.deVig`), the same way the fight model compares itself to the line.
- **No reading the answer.**
  - Streak splits read only the fights *before* the bout (matched by opponent in
    the stats' `opp` list).
  - The backtest scores only bouts whose fighters' stats were fetched *before* the
    fight, replays only earlier cards into the ratings, and passes no rankings,
    because today's rankings can reflect the result.
  - Before these guards the backtest read 87–93%. After them it reads a small
    sample around the market, which is the truth.
- **CLV** is judged from the line at the pick's last edit (`updated_at`) to the
  close, in de-vigged percentage points toward the picked fighter.

## FightBot

An MCP server any MCP client can use (Claude Desktop, Claude Code, …).

```bash
# Claude Code
claude mcp add fightbot -- node /path/to/ufc-dashboard/fightbot/server.mjs
```

```json
// Claude Desktop — claude_desktop_config.json
{ "mcpServers": { "fightbot": { "command": "node",
    "args": ["/path/to/ufc-dashboard/fightbot/server.mjs"] } } }
```

| tool | answers |
| ---- | ------- |
| `get_next_card` | The upcoming card, each bout's line, market % and model % |
| `get_card` | Any card by date, with results |
| `search_fighters` | Name lookup in the stats cache |
| `compare_fighters` | Tale of the tape for any two fighters + model + betting history |
| `get_odds_movement` | Biggest movers, steam, dogs gaining |
| `find_underdogs` | "Every +200 dog with better takedown stats" |
| `fight_week_brief` | The fight-week brief |
| `get_leaderboard` | Standings, by the board's own code |
| `get_user_picks` | One player's graded picks |
| `fight_iq` | A player's scouting report |
| `why_did_my_pick_lose` | Each loss on a card: the line at the pick, the move after it, the tape and model (earlier cards only, no rankings), each labelled `pre-fight` or `retrospective` by whether the stats predate the fight |

It reads the repo's committed data files (rebuilt when they change on disk, so
`git pull` refreshes a running server) and the same public picks read the app
makes. `FIGHTBOT_PICKS_FILE=/path/picks.json` swaps in a fixture for offline use
and tests. stdout carries protocol messages only; all logging goes to stderr.

## Tests

- `npm run check:lab` covers:
  - board parity
  - feed validation
  - odds orientation and CLV sign
  - leakage guards
  - the ticker
  - service-worker cache keys
  - a headless boot of every Lab tab under the page's CSP
- `npm run check:fightbot` spawns the server and drives it over JSON-RPC. It
  covers protocol shape, every tool, leaderboard parity, error paths, and that
  stdout stays pure.

Both run in `npm run verify` and CI.
