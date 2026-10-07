-- Notifications, one toggle per kind.
--
-- The 🔔 bell used to be all or nothing: a player who wanted results but not
-- trash talk had to take both or neither. Now each kind of push has its own
-- switch in ⋯ More → Notifications, and the switch follows the account like
-- the bell does (user_prefs, 0004).
--
-- notif_off lists the kinds this account has turned OFF, so a new kind (and
-- every account that never opens the sheet) starts ON, as everything did
-- before. The kinds are send-push's categories:
--   start      card starting (main / prelim)       result   fight results
--   brief      Friday Fight Week Brief             swap     a picked bout changed
--   pick       a friend is picking / locked in     roast    trash talk
--   challenge  challenges and their answers        nudge    nudges
--
-- send-push is the one place every push goes through (check-results and
-- send-reminders call it too), so it is the one place that honours this: it
-- reads the accounts with the push's kind in notif_off, with the service key,
-- and drops their subscriptions. The app also keeps its own copy, so the sheet
-- shows the right state offline.
--
-- Additive and safe in any deploy order: before this runs, the app's write of
-- notif_off fails quietly (logged) and its read finds no column; send-push's
-- read fails and it sends as it always has, which is right, since nobody can
-- have turned anything off yet. Owner-only like the rest of the row (0004's
-- policies cover every column). Rollback at the bottom.

alter table public.user_prefs
  add column if not exists notif_off text[] not null default '{}';

-- A short list of short words: nothing else belongs here.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_prefs_notif_off_shape') then
    alter table public.user_prefs add constraint user_prefs_notif_off_shape
      check (cardinality(notif_off) <= 16 and array_to_string(notif_off, ',') ~ '^[a-z,]{0,200}$');
  end if;
end $$;

-- One switch changes one kind, on the server. The app used to write its whole
-- list, so a phone that hadn't seen another phone's change would put it back
-- (turning Nudges off on a stale phone re-enabled Trash talk). This adds or
-- removes just the one kind in a single statement and returns the account's
-- whole list, which the app adopts. Security invoker: it runs as the caller,
-- so 0004's owner-only policies and 0014's deleted-account guard still apply.
create or replace function public.set_notif_kind(kind text, enabled boolean)
returns text[] language plpgsql security invoker set search_path = public as $$
declare me text := auth.uid()::text; result text[];
begin
  if me is null then raise exception 'not signed in'; end if;
  if kind is null or kind !~ '^[a-z]{1,20}$' then raise exception 'bad kind'; end if;
  insert into public.user_prefs (user_id, notif_off, updated_at)
    values (me, case when enabled then '{}'::text[] else array[kind] end, now())
  on conflict (user_id) do update set
    notif_off = case
      when enabled then array_remove(public.user_prefs.notif_off, kind)
      when kind = any(public.user_prefs.notif_off) then public.user_prefs.notif_off
      else array_append(public.user_prefs.notif_off, kind) end,
    updated_at = now()
  returning notif_off into result;
  return result;
end $$;
revoke all on function public.set_notif_kind(text, boolean) from public, anon;
grant execute on function public.set_notif_kind(text, boolean) to authenticated;

-- Rollback:
-- drop function if exists public.set_notif_kind(text, boolean);
-- alter table public.user_prefs drop constraint if exists user_prefs_notif_off_shape;
-- alter table public.user_prefs drop column if exists notif_off;
