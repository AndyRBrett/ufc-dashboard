-- Rooms: longer invite codes, and a per-account limit on wrong guesses.
--
-- A 6-hex-digit code is 16.7M possibilities, and join_room answered every
-- guess instantly and without limit, so an account could walk the space.
-- New codes are 10 characters of Crockford base32 (no I, L, O, U: nothing to
-- misread), 2^50 of them; codes already handed out keep working unchanged.
-- Wrong guesses are counted per account and capped (JOIN_MISSES_PER_HOUR).
--
-- One Postgres detail shapes join_room: raising an exception rolls back the
-- whole call, including the row that records the miss, so a miss would never
-- be counted. A wrong code therefore RETURNS NULL (the app reads that as "no
-- such room") and only a throttled caller gets an exception, by which point
-- nothing needs recording.
--
-- Apply after 0006. Rollback at the bottom.

create table if not exists public.room_join_misses (
  user_id text not null,
  at      timestamptz not null default now()
);
create index if not exists room_join_misses_user_at on public.room_join_misses (user_id, at);
alter table public.room_join_misses enable row level security;   -- no policies: only the function below touches it
revoke all on public.room_join_misses from public, anon, authenticated;

-- 10 chars of Crockford base32 from gen_random_uuid()'s bytes. 256 is a
-- multiple of 32, so byte % 32 is uniform. Bytes 6 and 8 carry the UUID's
-- fixed version / variant bits and are skipped: byte 6 alone would give one
-- character only 16 possible values. (No pgcrypto needed.)
create or replace function public.new_room_code()
returns text language plpgsql volatile set search_path = public as $$
declare a constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; b bytea; c text := ''; i int;
begin
  b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  foreach i in array array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11] loop
    c := c || substr(a, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return c;
end $$;

create or replace function public.create_room(p_name text)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare me text := auth.uid()::text; r rooms; c text;
begin
  if me is null then raise exception 'not signed in'; end if;
  -- Rooms belong to ACCOUNTS, not devices: an anonymous uid dies with the
  -- phone's storage, an email-linked uid comes back on any device.
  if not public.is_account() then raise exception 'link an email first'; end if;
  if (select count(*) from rooms where owner_id = me) >= 10 then raise exception 'room limit'; end if;
  loop
    c := public.new_room_code();
    exit when not exists (select 1 from rooms where code = c);
  end loop;
  insert into rooms (name, code, owner_id) values (btrim(p_name), c, me) returning * into r;
  insert into room_members (room_id, user_id) values (r.id, me);
  return r;
end $$;

-- Join by invite code. The code is the only way in: rooms aren't listable.
-- Caps: 50 members per room; 10 wrong codes per account per hour.
create or replace function public.join_room(p_code text)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare me text := auth.uid()::text; r rooms; misses int; want text;
begin
  if me is null then raise exception 'not signed in'; end if;
  if not public.is_account() then raise exception 'link an email first'; end if;
  -- One join at a time per account: without this, a burst of concurrent wrong
  -- guesses each counts the same committed misses before any of their own rows
  -- is visible, and every one of them gets past the cap. Released at commit.
  perform pg_advisory_xact_lock(hashtext('room_join:' || me));
  select count(*) into misses from room_join_misses where user_id = me and at > now() - interval '1 hour';
  if misses >= 10 then raise exception 'too many attempts'; end if;
  want := upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
  select * into r from rooms where rooms.code = want;
  if r.id is null then
    insert into room_join_misses (user_id) values (me);
    delete from room_join_misses where at < now() - interval '1 day';   -- keep the table small
    return null;                                                        -- "no such room"; see header
  end if;
  if (select count(*) from room_members where room_id = r.id) >= 50 then raise exception 'room full'; end if;
  insert into room_members (room_id, user_id) values (r.id, me) on conflict do nothing;
  return r;
end $$;

revoke all on function public.new_room_code() from public, anon, authenticated;
revoke all on function public.create_room(text), public.join_room(text) from public, anon;
grant execute on function public.create_room(text), public.join_room(text) to authenticated;

-- Rollback: re-run 0006_rooms.sql's create_room / join_room, then
-- drop function if exists public.new_room_code();
-- drop table if exists public.room_join_misses;
