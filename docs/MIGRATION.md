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

| # | Stage | What moves | Risk |
| - | ----- | ---------- | ---- |
| 1 | Safety net | `check:parity` + golden, `docs/ROLLBACK.md`, this plan. No app change. | none |
| 2 | Engine in the app | `index.html` loads `lab/engine.js`; bout lookups (`_findFightResult`, `_isMainCardPick`, `_fightIndex`, the lookup loop in `_lbScoreUsers`) go through `engine.findBout` | low: lookups only |
| 3 | Scoring owned by the engine | `pickPts` / `userPts` / locks / dog tiers / method matching move into `ufcRules` natively. `index.html` calls the engine, and `loadKernel` stops lifting scoring out of `index.html` | medium: every number, held by parity |
| 4 | Standings consumers | the Belt, card recap and Year Wrapped read engine standings instead of calling `_lbScoreUsers` directly | medium |
| 5 | Segments and locks | `fightLocked` / `boutSegmentTime` read the engine's segments (`check:lock` must stay green) | medium: lock timing |
| 6 | Open it up | picks on feed promotions; a standings scope parameter, which rooms plugs into | new behavior, own tests |

Stages 2–5 change no behavior. Stage 6 is where the platform starts doing new
things, and it lands only after 2–5 have been live through at least one card.

## Rollback

`docs/ROLLBACK.md`: revert the stage's PR, or restore `main` from
`backup/pre-engine-migration-2026-09-24`.
