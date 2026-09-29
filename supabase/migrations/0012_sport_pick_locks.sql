-- Pick locks for the other sports, the way UFC's work (0010).
--
-- 0010 refuses a pick once its bout has started, but only for UFC rows: it
-- says "Other sports keep their own client-side lock", so a PFL / RIZIN / DWCS
-- pick could be added, switched, re-methoded, un-locked or deleted with a direct
-- REST call after the result was known. Those boards now score by the UFC
-- rules (winner, method, 🔒, underdog), which is more to rewrite, so the
-- database now polices them exactly as it polices UFC.
--
-- The lock times come the same way: send-reminders (service key) writes them
-- every few minutes, by the app's own rule for these cards (sportLockMs in
-- index.html: the feed's `time` in ET when it has one, else a per-promotion UTC
-- hour), into two NEW tables. New tables, not a promotion column on 0010's
-- pick_locks / card_bells: their primary keys are the ON CONFLICT targets the
-- live UFC sync uses, and changing them would break that upsert until the
-- function was redeployed, on a week when a card is live.
--
-- Fallbacks are UFC's: a bout with no row answers to its card's bell (a
-- respelled name can't outlast its card), and a card with no row at all locks at
-- midnight ET after its date, so a missing sync fails open only until the card
-- is over. Refusal is per operation, for anon/authenticated only, with
-- LOCK_GRACE (5 minutes), and identical to 0010's:
--   INSERT after the lock -> skipped (NULL), never an error
--   UPDATE after the lock -> pick, method, 🔒 and the row's identity kept
--   DELETE after the lock -> skipped
-- bonus_pick (fight of the night) is UFC-only and still freezes only there.
--
-- Apply after 0010. Order against the function deploy doesn't matter: until
-- the tables have rows the fallback above applies, and a function deployed
-- first just gets a 404 on the new tables (it reports it and carries on).
-- Rollback at the bottom.

create table if not exists public.sport_pick_locks (
  promotion  text not null,
  event_date text not null,
  a          text not null,          -- lower(btrim(name)), a < b
  b          text not null,
  lock_at    timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (promotion, event_date, a, b)
);
create table if not exists public.sport_card_bells (
  promotion  text not null,
  event_date text not null,
  first_bell timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (promotion, event_date)
);
alter table public.sport_pick_locks enable row level security;   -- no policies: service role writes, the trigger reads
alter table public.sport_card_bells enable row level security;
revoke all on public.sport_pick_locks, public.sport_card_bells from public, anon, authenticated;

-- When a non-UFC bout's picks close. Never NULL.
create or replace function public.sport_pick_lock_at(p_promo text, p_date text, p_f1 text, p_f2 text)
returns timestamptz language sql stable security definer set search_path = public as $$
  select coalesce(
    (select l.lock_at from sport_pick_locks l
      where l.promotion = p_promo and l.event_date = p_date
        and l.a = least(lower(btrim(p_f1)), lower(btrim(p_f2)))
        and l.b = greatest(lower(btrim(p_f1)), lower(btrim(p_f2)))),
    (select c.first_bell from sport_card_bells c
      where c.promotion = p_promo and c.event_date = p_date),      -- unmatched name: the card's bell
    -- No schedule at all: locked from midnight ET after the card date.
    case when p_date ~ '^\d{4}-\d{2}-\d{2}$'
         then ((p_date::date + 1)::timestamp at time zone 'America/New_York') end,
    '-infinity'::timestamptz          -- a date we can't read is locked
  )
$$;

-- One entry point for the trigger: UFC's own function for UFC, ours for the rest.
create or replace function public.pick_lock_for(p_promo text, p_date text, p_f1 text, p_f2 text)
returns timestamptz language sql stable security definer set search_path = public as $$
  select case when coalesce(p_promo, 'ufc') = 'ufc'
              then public.pick_lock_at(p_date, p_f1, p_f2)
              else public.sport_pick_lock_at(p_promo, p_date, p_f1, p_f2) end
$$;

-- 0010's trigger function, with the promotion carve-out removed: every row is
-- policed, each against its own promotion's lock time. The UFC path is the same
-- statements as before (pick_lock_for('ufc', …) is pick_lock_at).
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

  if tg_op = 'INSERT' then
    if now() >= pick_lock_for(new.promotion, new.event_date, new.f1, new.f2) + grace then
      return null;
    end if;
    if coalesce(new.promotion, 'ufc') = 'ufc' and now() >= card_first_bell(new.event_date) + grace then
      new.bonus_pick := (select p.bonus_pick from picks p
                          where p.user_id = new.user_id and p.event_date = new.event_date
                            and p.promotion = new.promotion
                          order by p.updated_at desc limit 1);
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if now() >= pick_lock_for(old.promotion, old.event_date, old.f1, old.f2) + grace then
      return null;
    end if;
    return old;
  end if;

  -- UPDATE: a locked bout keeps its pick, method, lock and identity. Moving a
  -- row onto a locked bout (or another promotion's) counts too, or f1/f2/promotion
  -- could carry a pick past the bell.
  locked := now() >= pick_lock_for(old.promotion, old.event_date, old.f1, old.f2) + grace
         or now() >= pick_lock_for(new.promotion, new.event_date, new.f1, new.f2) + grace;
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
  if coalesce(old.promotion, 'ufc') = 'ufc' and now() >= card_first_bell(old.event_date) + grace then
    new.bonus_pick := old.bonus_pick;
  end if;
  return new;
end $$;

-- The trigger runs as the caller, so the caller must be able to ask when a bout
-- locks. That reveals nothing the app doesn't already show.
revoke all on function public.sport_pick_lock_at(text, text, text, text), public.pick_lock_for(text, text, text, text) from public;
grant execute on function public.sport_pick_lock_at(text, text, text, text), public.pick_lock_for(text, text, text, text) to anon, authenticated;

-- Rollback: put 0010's trigger function back (re-run its
-- `create or replace function public.picks_enforce_lock()` block), then
-- drop function if exists public.pick_lock_for(text, text, text, text),
--   public.sport_pick_lock_at(text, text, text, text);
-- drop table if exists public.sport_pick_locks, public.sport_card_bells;
