-- ===========================================================================
-- RLS Baseline — UFC Dashboard
-- ===========================================================================
--
-- PURPOSE
--   The frontend ships the Supabase *anon* key (this is public by design). The
--   only thing standing between that public key and your data is Row-Level
--   Security. Those policies currently live only in the Supabase dashboard, so
--   the database's protection is not reviewable or reproducible from this repo.
--   This file captures the intended RLS model in version control so the security
--   posture is auditable in code.
--
-- ⚠️  RECONCILE BEFORE APPLYING  ⚠️
--   RLS is already enabled in the live project. Do NOT blindly `supabase db push`
--   this file — it could conflict with or clobber the policies already in place.
--   Instead:
--     1. Run `supabase db pull` against the project to capture the ACTUAL current
--        schema + policies into a migration.
--     2. Diff that against this baseline and reconcile any differences.
--     3. Treat the reconciled result as authoritative.
--   The `drop policy if exists` guards below make re-application idempotent once
--   you've confirmed these match (or supersede) what's live.
--
-- MODEL (matches how the app actually uses each table)
--   picks      — public leaderboard. Anon may SELECT all rows and INSERT/UPDATE
--                via upsert. No DELETE for anon.
--   push_subs  — written ONLY by the `send-push` edge function via the service
--                role key (which bypasses RLS). Anon gets no access at all.
--   notif_log  — internal dedup log, service-role only. Anon gets no access.
--
-- NOTE ON SPOOFING
--   Picks are keyed by a client-generated `device` id with no authentication, so
--   a determined user can still submit picks under any display name. Closing that
--   requires real auth (e.g. Supabase Auth) and is out of scope here. RLS below
--   constrains *which operations* anon can perform, not *whose* rows it claims.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- picks
-- ---------------------------------------------------------------------------
alter table public.picks enable row level security;

drop policy if exists "picks_anon_select" on public.picks;
create policy "picks_anon_select"
  on public.picks
  for select
  to anon
  using (true);

drop policy if exists "picks_anon_insert" on public.picks;
create policy "picks_anon_insert"
  on public.picks
  for insert
  to anon
  with check (true);

-- Required so the frontend upsert (POST with Prefer: resolution=merge-duplicates
-- on conflict device,event,bout) can update an existing row.
drop policy if exists "picks_anon_update" on public.picks;
create policy "picks_anon_update"
  on public.picks
  for update
  to anon
  using (true)
  with check (true);

-- No DELETE policy for anon → deletes are denied by default.

-- ---------------------------------------------------------------------------
-- push_subs  (service-role only; anon has no policies → no access)
-- ---------------------------------------------------------------------------
alter table public.push_subs enable row level security;

-- ---------------------------------------------------------------------------
-- notif_log  (service-role only; anon has no policies → no access)
-- ---------------------------------------------------------------------------
alter table public.notif_log enable row level security;
