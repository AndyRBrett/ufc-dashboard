-- Locks 🔒: at most two per user per card, enforced where the rows land.
--
-- A lock is picks.confidence > 0 (the column the retired 1–3 "confidence
-- stars" wrote to). The app caps locks at two per card in toggleLock, but that
-- only sees one device's state: two phones on the same account can each lock
-- two different bouts and the server ends up holding four, all of which score.
--
-- A third lock is CLAMPED to confidence = 0, not rejected. syncPick upserts the
-- whole row — pick, method and lock together — so rejecting it would drop the
-- pick itself over a lock that was never going to count. The first two locks to
-- reach the server win.
--
-- Scoped like the app's scoring: only cards on/after LOCKS_START (2026-09-26)
-- count locks, and older cards still carry legacy star values up to 3 that must
-- stay untouched. Keep this date in step with LOCKS_START in index.html.
--
-- The advisory lock serialises concurrent writes for the same user + card, so
-- two simultaneous upserts can't both see "one lock so far" and both land.

create or replace function public.picks_cap_locks()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  others int;
begin
  if coalesce(new.confidence, 0) <= 0 or new.event_date < '2026-09-26' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('picks_lock:' || new.user_id || '|' || new.event_date));
  select count(*) into others
    from public.picks p
   where p.user_id = new.user_id
     and p.event_date = new.event_date
     and coalesce(p.confidence, 0) > 0
     -- the same bout (either corner order) is this row, not another lock
     and not ((p.f1 = new.f1 and p.f2 = new.f2) or (p.f1 = new.f2 and p.f2 = new.f1));
  if others >= 2 then
    new.confidence := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists picks_cap_locks on public.picks;
create trigger picks_cap_locks
  before insert or update of confidence, event_date, f1, f2, user_id on public.picks
  for each row execute function public.picks_cap_locks();
