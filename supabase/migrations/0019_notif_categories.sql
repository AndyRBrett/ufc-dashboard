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

-- Rollback:
-- alter table public.user_prefs drop constraint if exists user_prefs_notif_off_shape;
-- alter table public.user_prefs drop column if exists notif_off;
