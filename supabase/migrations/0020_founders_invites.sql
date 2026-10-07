-- ===========================================================================
-- Founding members and invite links — soft-launch prep
-- ===========================================================================
--
-- FOUNDING MEMBERS store nothing new. A founder is an email account whose
-- login was created before founding_cutoff(): Supabase already records
-- auth.users.created_at, so the badge is derived, never written, and a
-- player can't make themselves one (user_prefs, which players write, would
-- have let them). To move the cutoff, re-run founding_cutoff() with a new
-- date; every badge follows. founders_among() answers only "which of these
-- ids are founders", for the board's badge.
--
-- INVITES are new data: who invited whom. Each account gets one invite code
-- (my_invite(), same 10-character Crockford alphabet as room codes), and a
-- NEW account that opened someone's link claims it once (claim_invite()). An
-- account older than INVITE_NEW_DAYS is an existing player, not an invite.
-- Nobody writes either table directly; only these SECURITY DEFINER RPCs do,
-- and each acts only as the caller (auth.uid()).
--
-- my_invite() reports counts only (joined, playing), never who: "playing"
-- is an invitee with UFC picks on 2 different past cards, the same bar
-- send-push sets before an account may send social pushes (SOCIAL_MIN_CARDS),
-- so a pile of throwaway sign-ups doesn't count. A card is real only if
-- card_bells (0010, written by send-reminders off data.js) has it: a pick on
-- a made-up date is accepted until midnight after it, and would otherwise
-- count once that date passed. Picks on a past card can't be backfilled
-- (0010's lock), so the bar can't be faked after the fact.
--
-- Deleting an account (0014's delete_my_account, re-runnable, lists both
-- tables) removes its code and every invite it is on, either side; the
-- trigger on auth.users below does the same for an install that applies
-- this without re-running 0014, or an admin deleting a login. A deleted
-- account's leftover token can't write here either (0014's guard).
--
-- Additive and safe in any deploy order: until this is applied the app's
-- RPC calls 404 and it shows no badge and no invite link.
--
-- Paste into the Supabase SQL editor to apply, then run the check query in
-- CLAUDE.md ("0020 founders and invites").
-- ===========================================================================

-- ------------------------------------------------------------- founding --
-- Midnight ET, 1 January 2027 (EST, UTC-5).
create or replace function public.founding_cutoff()
returns timestamptz language sql immutable as $$
  select timestamptz '2027-01-01 05:00:00+00'
$$;
grant execute on function public.founding_cutoff() to anon, authenticated;

-- plpgsql (checked when called, not when created) and guarded, so it can be
-- applied before auth.users exists in a test database.
create or replace function public.founders_among(p_ids text[])
returns setof text language plpgsql stable security definer set search_path = public as $$
begin
  if to_regclass('auth.users') is null or p_ids is null then return; end if;
  return query
    select u.id::text from auth.users u
    where u.id in (select x::uuid from unnest(p_ids[1:500]) x
                   where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      and u.created_at < public.founding_cutoff()
      and not coalesce(u.is_anonymous, false)
      and coalesce(u.email, '') <> '';
end $$;
revoke all on function public.founders_among(text[]) from public;
grant execute on function public.founders_among(text[]) to anon, authenticated;

-- --------------------------------------------------------------- invites --
create table if not exists public.invite_codes (
  user_id    text primary key,
  code       text not null unique,
  created_at timestamptz not null default now()
);
create table if not exists public.invites (
  invitee_id text primary key,          -- one inviter per account, ever
  inviter_id text not null,
  claimed_at timestamptz not null default now()
);
create index if not exists invites_inviter_idx on public.invites (inviter_id);

-- RLS on with no policies, and no grants: only the RPCs below touch them.
alter table public.invite_codes enable row level security;
alter table public.invites enable row level security;
revoke all on public.invite_codes, public.invites from anon, authenticated;

-- An account is an invitee only while it is new.
create or replace function public.invite_new_days()
returns integer language sql immutable as $$ select 14 $$;

-- The caller's code (made on first ask), and how many people it brought in.
create or replace function public.my_invite()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me text := auth.uid()::text;
  c text;
  joined integer;
  playing integer;
  founder boolean := false;
  cutoff_day text := to_char((now() at time zone 'America/New_York')::date - 2, 'YYYY-MM-DD');
begin
  if not public.is_account() then raise exception 'link an email first'; end if;
  select code into c from invite_codes where user_id = me;
  while c is null loop
    c := public.new_room_code();
    begin
      insert into invite_codes (user_id, code) values (me, c);
    exception when unique_violation then
      -- a code collision, or a second phone made this account's code first
      c := null;
      select code into c from invite_codes where user_id = me;
    end;
  end loop;
  select count(*) into joined from invites where inviter_id = me;
  select count(*) into playing from invites i
   where i.inviter_id = me
     and (select count(distinct p.event_date) from picks p
           where p.user_id = i.invitee_id and p.promotion = 'ufc'
             and p.event_date ~ '^\d{4}-\d{2}-\d{2}$' and p.event_date <= cutoff_day
             and exists (select 1 from card_bells c where c.event_date = p.event_date)) >= 2;
  founder := exists (select 1 from public.founders_among(array[me]));
  return jsonb_build_object('code', c, 'joined', joined, 'playing', playing,
                            'founder', founder, 'founding_until', public.founding_cutoff());
end $$;
revoke all on function public.my_invite() from public, anon;
grant execute on function public.my_invite() to authenticated;

-- Claim the invite this (new) account arrived through. Returns a status
-- rather than raising, so the app can tell a dead link from a network error:
-- ok | already | self | unknown | existing.
create or replace function public.claim_invite(p_code text)
returns text language plpgsql security definer set search_path = public as $$
declare
  me text := auth.uid()::text;
  who text;
  born timestamptz;
begin
  if not public.is_account() then raise exception 'link an email first'; end if;
  -- FOR SHARE: an inviter deleting their account at this moment either
  -- finishes first (the code is gone: 'unknown') or waits until this claim
  -- commits and then removes it with everything else, never leaving an
  -- invite that points at a deleted account.
  select user_id into who from invite_codes where code = upper(btrim(coalesce(p_code, ''))) for share;
  if who is null then return 'unknown'; end if;
  if who = me then return 'self'; end if;
  if exists (select 1 from invites where invitee_id = me) then return 'already'; end if;
  if to_regclass('auth.users') is not null then
    execute 'select created_at from auth.users where id = $1' into born using auth.uid();
    if born is not null and born < now() - make_interval(days => public.invite_new_days()) then
      return 'existing';
    end if;
  end if;
  insert into invites (invitee_id, inviter_id) values (me, who) on conflict do nothing;
  return 'ok';
end $$;
revoke all on function public.claim_invite(text) from public, anon;
grant execute on function public.claim_invite(text) to authenticated;

-- Deleting the login clears its code and every invite it is part of.
create or replace function public.invites_forget_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.invite_codes where user_id = old.id::text;
  delete from public.invites where invitee_id = old.id::text or inviter_id = old.id::text;
  return old;
end $$;
revoke all on function public.invites_forget_user() from public, anon, authenticated;

do $$
begin
  if to_regclass('auth.users') is not null then
    drop trigger if exists invites_forget_user on auth.users;
    create trigger invites_forget_user after delete on auth.users
      for each row execute function public.invites_forget_user();
  end if;
end $$;

-- A deleted account's leftover token can't write here either (0014's guard).
do $$
declare t text;
begin
  if to_regprocedure('public.refuse_deleted_account()') is not null then
    foreach t in array array['invite_codes', 'invites'] loop
      execute format('drop trigger if exists refuse_deleted_account on public.%I', t);
      execute format('create trigger refuse_deleted_account before insert or update on public.%I
                      for each row execute function public.refuse_deleted_account()', t);
    end loop;
  end if;
end $$;

-- Rollback:
-- drop trigger if exists refuse_deleted_account on public.invites;
-- drop trigger if exists refuse_deleted_account on public.invite_codes;
-- drop trigger if exists invites_forget_user on auth.users;
-- drop function if exists public.invites_forget_user();
-- drop function if exists public.claim_invite(text);
-- drop function if exists public.my_invite();
-- drop function if exists public.invite_new_days();
-- drop table if exists public.invites;
-- drop table if exists public.invite_codes;
-- drop function if exists public.founders_among(text[]);
-- drop function if exists public.founding_cutoff();
