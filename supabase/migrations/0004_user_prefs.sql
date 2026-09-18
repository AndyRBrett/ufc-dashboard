-- ===========================================================================
-- Notification preferences that follow the account — UFC Dashboard
-- ===========================================================================
--
-- The three notification toggles (the 🔔 bell, Live Result Spoilers, and
-- fight-night reminders) lived only in localStorage. Signing back in after a
-- reinstall restored the identity and every pick, then showed all three off —
-- so the user had to rediscover and re-pick settings they had already chosen.
-- Reported after exactly that: an iOS home-screen app has to be deleted and
-- re-added to pick up a changed apple-mobile-web-app-* tag, which clears its
-- storage.
--
-- Why its own table rather than more columns on push_subs, which already
-- carries live_results (see 0002): togglePush DELETEs the push_subs row when
-- notifications are switched off, so preferences stored there vanish exactly
-- when the user is most likely to come back and turn them on again. And the
-- fight-night reminder toggle is local-only — it has no push subscription to
-- hang off at all. Preferences outlive subscriptions, so they get their own
-- row.
--
-- Cost: one primary-key read per load for a signed-in user, the same per-user
-- cost picks already pay. This is personal state — different for every
-- account — so it cannot be a committed static file the way intel.json can.
--
-- RLS: strictly owner-only, read included. Unlike challenges and the
-- leaderboard (public by design), nothing here is anyone else's business, and
-- the send-push function reads its own push_subs row for delivery rather than
-- this table.
--
-- Paste into the Supabase SQL editor to apply.
-- ===========================================================================

create table if not exists public.user_prefs (
  user_id      text primary key,
  push         boolean not null default false,  -- the 🔔 bell (web push)
  live_results boolean not null default false,  -- spoilers in result pushes
  reminders    boolean not null default false,  -- local fight-night reminders
  updated_at   timestamptz not null default now()
);

alter table public.user_prefs enable row level security;

drop policy if exists user_prefs_select on public.user_prefs;
create policy user_prefs_select on public.user_prefs
  for select to authenticated using (auth.uid()::text = user_id);

drop policy if exists user_prefs_insert on public.user_prefs;
create policy user_prefs_insert on public.user_prefs
  for insert to authenticated with check (auth.uid()::text = user_id);

drop policy if exists user_prefs_update on public.user_prefs;
create policy user_prefs_update on public.user_prefs
  for update to authenticated
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);

-- "Delete forever" promises to remove notification settings, so the owner
-- must be able to delete their own row.
drop policy if exists user_prefs_delete on public.user_prefs;
create policy user_prefs_delete on public.user_prefs
  for delete to authenticated using (auth.uid()::text = user_id);

revoke all on public.user_prefs from anon, authenticated;
grant select, insert, update, delete on public.user_prefs to authenticated;
