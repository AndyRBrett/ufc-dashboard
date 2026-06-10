-- ===========================================================================
-- RLS Audit + Remediation — UFC Dashboard
-- ===========================================================================
--
-- The frontend ships the Supabase *anon* key (public by design). RLS is the only
-- thing protecting the data behind it. A live audit (queried via pg_policies)
-- found RLS enabled on all three tables, but with policies permissive enough that
-- anyone holding the public anon key could DELETE or UPDATE every user's picks,
-- and seed/read notif_log. This migration tightens that to least privilege.
--
-- ⚠️  SEQUENCING — APPLY ONLY AFTER THE AUTH-ENABLED FRONTEND IS DEPLOYED  ⚠️
--   The picks drops below remove unauthenticated write access. The app now signs
--   users in via Supabase ANONYMOUS AUTH and writes as the `authenticated` role
--   (auth.uid()::text = user_id). You MUST:
--     1. Enable "Allow anonymous sign-ins" in the dashboard
--        (Authentication → Sign In / Providers).
--     2. Deploy the updated index.html and confirm picks save/update/delete work.
--     3. THEN run this migration (or paste it into the SQL editor).
--   Running it before the new frontend is live will break writes for clients still
--   using the raw anon key.
--
-- These statements are idempotent (drop ... if exists) and only REMOVE the
-- over-permissive policies. The secure `authenticated` owner policies
-- (picks_insert / picks_update / picks_delete, scoped to auth.uid()::text =
-- user_id) and the public SELECT policies (leaderboard is public by design) are
-- already present in the project and are intentionally left in place.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- picks — remove unauthenticated write access.
-- Anonymous-auth users act as `authenticated` and are covered by the existing
-- owner-scoped policies. SELECT stays public so the leaderboard still loads.
-- ---------------------------------------------------------------------------
drop policy if exists "public delete"      on public.picks;  -- anyone could delete any pick
drop policy if exists "picks_delete_anon"  on public.picks;  -- anyone could delete any pick
drop policy if exists "anon update picks"  on public.picks;  -- anyone could rewrite any pick
drop policy if exists "public insert"      on public.picks;  -- anyone could insert as anyone
drop policy if exists "picks_insert_anon"  on public.picks;  -- replaced by authenticated owner insert

-- ---------------------------------------------------------------------------
-- notif_log — internal push-dedup log. Written/read only by the send-push edge
-- function using the service-role key (bypasses RLS). Anon needs no access;
-- anon INSERT previously allowed suppressing notifications by pre-seeding rows.
-- ---------------------------------------------------------------------------
drop policy if exists "anon_insert" on public.notif_log;
drop policy if exists "anon_select" on public.notif_log;

-- ---------------------------------------------------------------------------
-- push_subs — subscriptions are registered through the send-push edge function
-- (service-role), not by direct anon insert. SELECT is already denied to anon
-- (push_subs_no_select). Remove the unused anon INSERT to cut attack surface.
-- ---------------------------------------------------------------------------
drop policy if exists "push_subs_insert" on public.push_subs;

-- ---------------------------------------------------------------------------
-- Sanity: keep RLS enabled (no-op if already enabled).
-- ---------------------------------------------------------------------------
alter table public.picks     enable row level security;
alter table public.push_subs enable row level security;
alter table public.notif_log enable row level security;
