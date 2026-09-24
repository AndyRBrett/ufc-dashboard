-- Which promotion a pick belongs to (the sport switcher: UFC, then PFL, ...).
--
-- Additive and backward compatible: every existing row, and every row an
-- older app build inserts without the field, is 'ufc'. The UFC board, Belt,
-- recap, Wrapped, Lab, FightBot, brief and result pushes read
-- promotion=eq.ufc (and scoring.js skips any other row as a second guard), so
-- a PFL pick can never land on — or drag down — the UFC standings.
--
-- The id format matches the Pick Engine feed's promotion ids
-- (lab/engine.js validateFeed: 2-20 chars of [a-z0-9-]).
alter table public.picks
  add column if not exists promotion text not null default 'ufc';

alter table public.picks drop constraint if exists picks_promotion_format;
alter table public.picks
  add constraint picks_promotion_format check (promotion ~ '^[a-z0-9-]{2,20}$');

-- The 2-lock cap (0005_picks_lock_cap.sql) is per card, and a card belongs to
-- a promotion: count, and serialise, per (user, date, PROMOTION). Without it,
-- two PFL locks on a Saturday that also has a UFC card would clamp the user's
-- first UFC lock to 0 -- another sport silently changing a UFC score. Same
-- body as 0005 otherwise, including its LOCKS_START date and its
-- shared-fighter rule; the trigger also fires when promotion changes.
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
  perform pg_advisory_xact_lock(hashtext('picks_lock:' || new.user_id || '|' || new.event_date || '|' || new.promotion));
  select count(*) into others
    from public.picks p
   where p.user_id = new.user_id
     and p.event_date = new.event_date
     and p.promotion = new.promotion
     and coalesce(p.confidence, 0) > 0
     and p.f1 not in (new.f1, new.f2)
     and p.f2 not in (new.f1, new.f2);
  if others >= 2 then
    new.confidence := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists picks_cap_locks on public.picks;
create trigger picks_cap_locks
  before insert or update of confidence, event_date, f1, f2, user_id, promotion on public.picks
  for each row execute function public.picks_cap_locks();

-- DOWN (only after every client stops sending the field):
-- alter table public.picks drop constraint if exists picks_promotion_format;
-- (re-run 0005_picks_lock_cap.sql first: its trigger doesn't mention promotion)
-- alter table public.picks drop column if exists promotion;
