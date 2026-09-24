# Migrating the app onto the Pick Engine

**Goal:** `index.html` stops owning its own card model and scoring and becomes
*Pick Engine + UFC adapter*, the same engine the Fight Lab and FightBot
already read through (`docs/PICK-ENGINE.md`). That's what makes rooms (a
standings view per group) and non-UFC promotions (picks on feed events)
buildable once instead of twice.

**The one rule:** a stage moves code, never numbers. `npm run check:parity`
pins the board (all-time, main-card-only, per card), the Belt's full lineage,
every card recap and every player's Year Wrapped to a golden taken before the
migration started. A stage that changes any of them is not a refactor.
Regenerating the golden (`node tests/check-parity.mjs --update`) is only for
an *intended* scoring change, and the PR has to say so.

## Stages

Each stage is one PR, with the one Codex round per `CLAUDE.md`, `verify` +
`check:parity` green, a `SW_VERSION` bump, and a check on a real phone after
deploy before the next stage starts. **Nothing merges on a card day.**

| # | Stage | What moves | Status |
| - | ----- | ---------- | ------ |
| 1 | Safety net | `check:parity` + golden, `docs/ROLLBACK.md`, this plan. No app change. | ✅ #176 |
| 2 | Engine in the app | `index.html` loads `lab/engine.js`; scoring's bout lookups (`_findFightResult`, `_isMainCardPick`, the lookup loop in `_lbScoreUsers`) go through one `_boutLookup` → `engine.findBout`, with the original loops as a fallback if the engine didn't load | ✅ #177 |
| 3 | One scoring rulebook (option A) | Every scoring function moves out of `index.html` into a standalone `scoring.js` that the app loads (required, version-pinned, self-healing like `data.js`) and the Lab, FightBot, the Friday brief and the tests all run. `loadKernel` stops lifting scoring out of HTML. The alternatives were the engine owning scoring natively (a second implementation to keep in step) or bundling at deploy (changes the deploy); A is one real source with no build step | ✅ #179 |
| 4 | Standings by scope | one call, `boardStandings(rows, scope)` in `scoring.js`, replaces every hand-rolled `_lbScoreUsers` filter: the board (current card / main card), card recap, Year Wrapped, the trash-talk pool, the Lab and FightBot. `computeBeltLineage` moves into `scoring.js` and takes the same scope. Scopes: `date`, `through`, `before`, `year`, `mainCard`, `users`. `_fightIndex` stays in the page: it is pick sync's *exact-name* index, not scoring, and the engine's index is deliberately fuzzy, so moving it would buy an indirection and nothing else | ✅ #180 (+ #182: prototype-free maps) |
| 5 | Segments and locks | `fightLocked` / `boutSegmentTime` read the engine's segments (`check:lock` must stay green) | **not started, and optional.** UFC lock timing still lives in `index.html` (`fightLocked`, `boutSegmentTime`, `_segPassed`). Nothing downstream needs it: other sports lock through their own `sportLockMs`. Do it only if a second promotion ever needs segment-level locks |
| 6 | Open it up | new behavior on top of 1–4 | **mostly shipped**, see below |

### Stage 6, as shipped

| Piece | PR | State |
| ----- | -- | ----- |
| Rooms: a `users` scope on `boardStandings`, a room's own Belt, email accounts only (`0006_rooms.sql`) | #181 | ✅ live |
| Picks tagged by promotion (`0007_picks_promotion.sql`); every UFC reader says `promotion=eq.ufc`; the lock cap counts per promotion | #184 | ✅ live |
| Sport switcher: UFC \| PFL \| …, its own view, local picks, board (`sportStandings`), locks | #185 | ✅ deployed, **hidden** until the feed publishes |
| PFL cards from Wikipedia (`extra.py`) | #183 | ✅ running in **shadow mode**. First real run (2026-09-24 22:03 UTC): PFL Chicago (14 bouts, 12 independently confirmed, none contradicted) and PFL Dubai (8); two cards without articles correctly withheld. Publishing (`EXTRA_PUBLISH=1`) is the remaining step |

### The sequencing changed, on purpose

The plan said stage 6 would land only after stages 2–5 had been live through at
least one card. It didn't: Andy chose to keep going, so rooms and multi-sport
shipped on 2026-09-24, before the first card (UFC, Saturday 2026-09-26) that
stages 3–4 run through. What stands in for that soak instead:

- the UFC path is isolated from everything stage 6 added: `check:parity`
  proves 1,372 PFL rows leave every UFC output byte-identical, and
  `check:promotion` fails on any UFC picks query without the filter;
- the switcher can't appear until PFL is published, so Saturday's card runs on
  exactly the UFC code stages 1–4 produced;
- **publishing PFL is held until after that card**, so the first multi-sport
  production test starts from a UFC path that has already survived a live card.

Stages 2–4 changed no behavior; `check:parity` holds that on every push.

## Rollback

`docs/ROLLBACK.md`: revert the stage's PR, or restore `main` from
`backup/pre-engine-migration-2026-09-24`.
