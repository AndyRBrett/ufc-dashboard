-- Nobody sees anyone else's pick until that bout locks.
--
-- Picks were readable by everyone at all times (0011), so the board showed each
-- player's picks for tonight the moment they were made. With picks open until
-- the fight before each bout ends (fightLocked in index.html, lockRows in
-- send-reminders), that let a late player copy the room's picks on any fight
-- still open, or switch theirs at the last second against what everyone else
-- had. Now a row is readable by:
--   - its owner, always (their own picks have to come back to a new device);
--   - everyone else once the bout's lock time plus LOCK_GRACE has passed. The
--     grace matters: the lock trigger (0010) still takes a pick for 5 minutes
--     after the lock, so revealing any earlier would let someone read the
--     room's picks and still write theirs.
--   - everyone, for a card more than 2 days old, without asking for a lock time.
--     Every lock on a card falls on its own night, so this changes no answer;
--     it keeps the board's read of every past pick from looking each one up.
-- Every promotion, each by its own lock times (pick_lock_for, 0012). A missing
-- schedule row falls back the way the lock does: the card's first bell, then
-- midnight ET after its date. So a broken sync hides picks only until the card
-- is over, never for good.
--
-- Our own functions read with the service key, which bypasses RLS: the fight
-- change alert needs who picked a bout before it locks. Realtime's
-- postgres_changes applies these same policies.
--
-- Also: pick_locks becomes readable (not writable) by the app, so it can show a
-- bout as locked at the time the database enforces. Those are fight schedules;
-- nothing in them is anyone's.
--
-- Apply after 0012. Rollback at the bottom.

drop policy if exists picks_select      on public.picks;
drop policy if exists picks_select_auth on public.picks;

create policy picks_select on public.picks for select to anon
  using (
    event_date < to_char(now() at time zone 'America/New_York' - interval '2 days', 'YYYY-MM-DD')
    or now() >= public.pick_lock_for(coalesce(promotion, 'ufc'), event_date, f1, f2) + interval '5 minutes'   -- LOCK_GRACE
  );
create policy picks_select_auth on public.picks for select to authenticated
  using (
    auth.uid()::text = user_id
    or event_date < to_char(now() at time zone 'America/New_York' - interval '2 days', 'YYYY-MM-DD')
    or now() >= public.pick_lock_for(coalesce(promotion, 'ufc'), event_date, f1, f2) + interval '5 minutes'   -- LOCK_GRACE
  );

grant select on public.pick_locks to anon, authenticated;
drop policy if exists pick_locks_read on public.pick_locks;
create policy pick_locks_read on public.pick_locks for select to anon, authenticated using (true);

-- The name check. The app refused a nickname another player was actively
-- using by reading their picks on the current card, which this hides. This
-- answers just that yes/no, as the owner: is the name (the text after the
-- emoji) on anyone else's pick dated p_since or later. A plain suffix compare,
-- so a % or _ in the name is a character, not a wildcard.
create or replace function public.nickname_taken(p_name text, p_since text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from picks
     where right(lower(nickname), length(p_name) + 1) = ' ' || lower(p_name)
       and user_id <> coalesce(auth.uid()::text, '')
       and event_date >= p_since)
$$;
revoke all on function public.nickname_taken(text, text) from public;
grant execute on function public.nickname_taken(text, text) to anon, authenticated;

-- Rollback (back to 0011: every pick readable by everyone, lock table closed):
-- drop policy if exists picks_select on public.picks;
-- drop policy if exists picks_select_auth on public.picks;
-- create policy picks_select      on public.picks for select to anon          using (true);
-- create policy picks_select_auth on public.picks for select to authenticated using (true);
-- drop policy if exists pick_locks_read on public.pick_locks;
-- revoke select on public.pick_locks from anon, authenticated;
-- drop function if exists public.nickname_taken(text, text);
