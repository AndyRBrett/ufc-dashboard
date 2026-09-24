# Rollback runbook

For when a change breaks the app for real users, most likely during the
engine migration (`docs/MIGRATION.md`) or the rooms work that follows it.
Pick the smallest row that fixes the problem.

| What broke | Do this | Takes |
| --- | --- | --- |
| One merged PR | Revert that PR (below) | ~5 min |
| Several migration stages, or not sure which | Restore `main` from the backup branch (below) | ~10 min |
| A Supabase edge function | Redeploy it from the restored `main` (below) | ~5 min |
| Picks data | Restore from the snapshot table (below) | ~2 min |
| Phones still showing the broken app | Nothing extra: every revert changes `sw.js`, so installed PWAs update on next open | next open |

## Known-good points

- **Code:** branch [`backup/pre-engine-migration-2026-09-24`](https://github.com/AndyRBrett/ufc-dashboard/tree/backup/pre-engine-migration-2026-09-24)
  = `main` at `d557a0e`, before the Friday brief, the scouting report and any
  migration stage. Anything merged after it can be reverted on its own.
- **Picks:** table `public.picks_backup_2026_09_24` in Supabase: 748 rows,
  verified identical to `public.picks` by checksum when taken. RLS on with no
  policies, so the public API can't read it. There's also an off-site CSV copy
  in Andy's hands.

## Revert one PR

1. GitHub → the merged PR → **Revert** → merge the revert PR.
2. `pages.yml` redeploys the site after `validate` passes, which takes a few
   minutes. If the PR touched `supabase/functions/`, `deploy-functions.yml`
   redeploys those too.
3. If the revert doesn't touch `sw.js` (it will if the PR bumped
   `SW_VERSION`, which every app change does), bump `SW_VERSION` in the
   revert so installed PWAs pick it up.

From a terminal instead: `git revert -m 1 <merge-sha> && npm run verify && git push`.

## Restore `main` from the backup branch

A forward commit, never a force-push, so everyone's checkout stays valid:

```bash
git fetch origin
git checkout main && git pull
git rm -r -q .                            # clear the tree (files added since go too)
git checkout origin/backup/pre-engine-migration-2026-09-24 -- .
# keep today's generated data rather than the backup's week-old copy:
git checkout origin/main -- data.js odds-series.json odds-snapshots.jsonl odds-state.json intel.json intel-state.json health-report.json overseer-status.json
# bump SW_VERSION in sw.js so installed PWAs update
npm run verify
git commit -m "Restore main to backup/pre-engine-migration-2026-09-24" && git push
```

That also rolls back the Fight Lab's later features. Revert individual PRs
instead if only the migration is at fault.

## Redeploy edge functions

GitHub → Actions → **Deploy Supabase Functions** → Run workflow on `main`. It
redeploys every function from whatever `main` now holds, behind the same
`check:functions` / `check:provider` / `check:brief` / `check:iq` gate.

## Restore picks from the snapshot

Only if picks themselves were damaged, and only after confirming the snapshot is
what you want: it holds nothing made after 2026-09-24. In the Supabase SQL editor:

```sql
begin;
-- keep what's there now, just in case
create table public.picks_damaged_<today> as select * from public.picks;
truncate public.picks;
insert into public.picks select * from public.picks_backup_2026_09_24;
select count(*) from public.picks;   -- expect 748
commit;
```

Picks made after the snapshot are in `picks_damaged_<today>` and can be
re-inserted selectively. The CSV copy is the fallback if the project itself is
lost: Table Editor → `picks` → Import data from CSV.
