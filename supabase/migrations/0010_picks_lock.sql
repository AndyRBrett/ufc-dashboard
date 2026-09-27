-- Pick locks, enforced where the rows land.
--
-- The app stops a pick once its bout's segment has started (fightLocked in
-- index.html), but the database took a pick at any time: anyone could write a
-- row after the bell, or change a pick once the result was in, with a direct
-- REST call. This makes the server refuse the same things the app does.
--
-- Where the lock times come from. The card lives in data.js, not the database,
-- so send-reminders (every few minutes, service key) writes each upcoming
-- card's per-bout lock times into pick_locks and its first and last bells into
-- card_bells, computed by the app's own isMainCardBout / isEarlyPrelimBout from
-- the bundled scoring.js. A bout with no row falls back to its card's last
-- bell, and a card with no row at all locks at midnight ET after its date, so
-- a missing sync fails open only until the card is over.
--
-- What "refuse" means, per operation, for anon/authenticated callers only
-- (our own functions and the SQL editor are trusted):
--   INSERT after the lock   -> skipped (returns NULL). Not an error: syncPick
--                              upserts, and a batch must not fail over one row.
--   UPDATE after the lock   -> the pick, method, lock and the row's identity
--                              are kept as they were; anything else (a
--                              nickname rename across every row) still applies.
--   DELETE after the lock   -> skipped, so a losing 🔒 can't be deleted to
--                              dodge its -1. Deleting an account goes through
--                              delete_my_picks() instead.
--   bonus_pick (fight of the night) freezes at the card's first bell.
--
-- LOCK_GRACE (5 minutes) lets a pick made just before the bell on a slow
-- connection still land. Anything later is refused: a phone that was offline
-- through the bell loses picks it never uploaded. That was the trade accepted
-- when this was switched on (2026-09-27).
--
-- Only promotion = 'ufc'. Other sports keep their own client-side lock.
--
-- Apply after 0007. Rollback at the bottom.

create table if not exists public.pick_locks (
  event_date text not null,
  a          text not null,          -- lower(btrim(name)), a < b
  b          text not null,
  lock_at    timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (event_date, a, b)
);
create table if not exists public.card_bells (
  event_date text primary key,
  first_bell timestamptz not null,
  last_bell  timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.pick_locks enable row level security;   -- no policies: service role writes, the trigger reads
alter table public.card_bells enable row level security;
revoke all on public.pick_locks, public.card_bells from public, anon, authenticated;

-- When a bout's picks close. Never NULL.
create or replace function public.pick_lock_at(p_date text, p_f1 text, p_f2 text)
returns timestamptz language sql stable security definer set search_path = public as $$
  select coalesce(
    (select l.lock_at from pick_locks l
      where l.event_date = p_date
        and l.a = least(lower(btrim(p_f1)), lower(btrim(p_f2)))
        and l.b = greatest(lower(btrim(p_f1)), lower(btrim(p_f2)))),
    (select c.last_bell from card_bells c where c.event_date = p_date),
    -- No schedule at all: locked from midnight ET after the card date.
    case when p_date ~ '^\d{4}-\d{2}-\d{2}$'
         then ((p_date::date + 1)::timestamp at time zone 'America/New_York') end,
    '-infinity'::timestamptz          -- a date we can't read is locked
  )
$$;

create or replace function public.card_first_bell(p_date text)
returns timestamptz language sql stable security definer set search_path = public as $$
  select coalesce(
    (select c.first_bell from card_bells c where c.event_date = p_date),
    case when p_date ~ '^\d{4}-\d{2}-\d{2}$'
         then ((p_date::date + 1)::timestamp at time zone 'America/New_York') end,
    '-infinity'::timestamptz
  )
$$;

create or replace function public.picks_enforce_lock()
returns trigger language plpgsql set search_path = public as $$
declare
  grace constant interval := interval '5 minutes';   -- LOCK_GRACE
  r public.picks;
  locked boolean;
begin
  -- Only what the app's users send is policed; our own functions (service_role)
  -- and security-definer RPCs (which run as the owner) are trusted.
  if current_user not in ('anon', 'authenticated') then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  r := case when tg_op = 'DELETE' then old else new end;
  if coalesce(r.promotion, 'ufc') <> 'ufc' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'INSERT' then
    if now() >= pick_lock_at(new.event_date, new.f1, new.f2) + grace then
      return null;
    end if;
    if now() >= card_first_bell(new.event_date) + grace then
      new.bonus_pick := (select p.bonus_pick from picks p
                          where p.user_id = new.user_id and p.event_date = new.event_date
                            and p.promotion = new.promotion
                          order by p.updated_at desc limit 1);
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if now() >= pick_lock_at(old.event_date, old.f1, old.f2) + grace then
      return null;
    end if;
    return old;
  end if;

  -- UPDATE: a locked bout keeps its pick, method, lock and identity. Moving a
  -- row onto a locked bout counts too, or f1/f2 could carry a pick past the bell.
  locked := now() >= pick_lock_at(old.event_date, old.f1, old.f2) + grace
         or now() >= pick_lock_at(new.event_date, new.f1, new.f2) + grace;
  if locked then
    new.pick := old.pick;
    new.method := old.method;
    new.confidence := old.confidence;
    new.event_date := old.event_date;
    new.f1 := old.f1;
    new.f2 := old.f2;
    new.user_id := old.user_id;
    new.promotion := old.promotion;
  end if;
  if now() >= card_first_bell(old.event_date) + grace then
    new.bonus_pick := old.bonus_pick;
  end if;
  return new;
end $$;

drop trigger if exists picks_enforce_lock on public.picks;
-- Named to sort after picks_cap_locks, so a locked row's confidence is put back
-- after the cap has looked at it.
create trigger picks_enforce_lock
  before insert or update or delete on public.picks
  for each row execute function public.picks_enforce_lock();

-- Deleting an account removes every pick, locked or not. Runs as the owner, so
-- the trigger lets it through; it can only ever touch the caller's own rows.
create or replace function public.delete_my_picks()
returns integer language plpgsql security definer set search_path = public as $$
declare me text := auth.uid()::text; n integer;
begin
  if me is null then raise exception 'not signed in'; end if;
  delete from picks where user_id = me;
  get diagnostics n = row_count;
  return n;
end $$;

-- The trigger runs as the caller, so the caller must be able to ask when a bout
-- locks. That reveals nothing the app doesn't already show.
revoke all on function public.pick_lock_at(text, text, text), public.card_first_bell(text) from public;
grant execute on function public.pick_lock_at(text, text, text), public.card_first_bell(text) to anon, authenticated;
revoke all on function public.delete_my_picks() from public, anon;
grant execute on function public.delete_my_picks() to authenticated;

-- Rollback:
-- drop trigger if exists picks_enforce_lock on public.picks;
-- drop function if exists public.picks_enforce_lock(), public.delete_my_picks(),
--   public.pick_lock_at(text, text, text), public.card_first_bell(text);
-- drop table if exists public.pick_locks, public.card_bells;
