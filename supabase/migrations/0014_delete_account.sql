-- Delete my account, for real. Apple (guideline 5.1.1(v)) requires an app that
-- lets people create an account to let them delete it from inside the app:
-- the account itself, not just some of its rows.
--
-- The app's old "Delete forever" removed picks, the push subscription, prefs,
-- rooms and blocks one REST call at a time, and left behind the login itself
-- (auth.users, with a linked email), every challenge the player was part of,
-- their AI usage rows (one per day, 30 days) and their wrong room-code tries.
-- This does all of it in one transaction, as the database owner, for the
-- signed-in caller only (auth.uid(); it takes no arguments, so it can't be
-- pointed at anyone else).
--
-- Kept on purpose: content_reports the player FILED (a moderation record,
-- which the privacy policy says), and reports filed ABOUT them. Gone: blocks
-- they made, and blocks others made of them (a dead uid blocks nothing).
--
-- Runs as the owner, so the pick lock (0010) lets the picks through, as it
-- does delete_my_picks. Deleting from auth.users cascades to Supabase's own
-- identities, sessions and refresh tokens, so the caller's token stops
-- working: the app clears local state and reloads into a fresh account.
--
-- Apply any time; until it exists the app falls back to its old row-by-row
-- delete (a 404 on the RPC). Rollback at the bottom.

create or replace function public.delete_my_account()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me text := auth.uid()::text;
  out jsonb := '{}'::jsonb;
  n integer;
  t text;
begin
  if me is null then raise exception 'not signed in'; end if;

  delete from picks where user_id = me;              get diagnostics n = row_count; out := out || jsonb_build_object('picks', n);
  delete from push_subs where user_id = me;          get diagnostics n = row_count; out := out || jsonb_build_object('push_subs', n);
  delete from challenges where challenger_id = me or target_id = me;
                                                     get diagnostics n = row_count; out := out || jsonb_build_object('challenges', n);

  -- Tables a later migration added: present on any install that has applied
  -- it, absent (and skipped) on one that hasn't.
  foreach t in array array['user_prefs:user_id', 'room_members:user_id', 'rooms:owner_id',
                           'user_blocks:blocker_id', 'user_blocks:blocked_id',
                           'ai_usage:user_id', 'room_join_misses:user_id'] loop
    if to_regclass('public.' || split_part(t, ':', 1)) is not null then
      execute format('delete from public.%I where %I = $1', split_part(t, ':', 1), split_part(t, ':', 2)) using me;
      get diagnostics n = row_count;
      out := out || jsonb_build_object(replace(t, ':', '.'), n);
    end if;
  end loop;

  -- Rollback snapshots of picks (docs/ROLLBACK.md) hold the same personal
  -- data; a deleted account must not survive in one.
  for t in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relkind = 'r' and c.relname like 'picks\_backup\_%' loop
    execute format('delete from public.%I where user_id = $1', t) using me;
  end loop;

  -- The login itself. Only a real auth uid has one.
  if to_regclass('auth.users') is not null then
    delete from auth.users where id = auth.uid();
    get diagnostics n = row_count; out := out || jsonb_build_object('login', n);
  end if;
  return out;
end $$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Rollback:
-- drop function if exists public.delete_my_account();
