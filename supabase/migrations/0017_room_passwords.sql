-- Rooms: a temporary password, typed inside the app.
--
-- An invite link (?join=CODE) opens in the phone's browser. On iOS that is
-- Safari, never the app on the Home Screen, and Safari has its own storage,
-- so the person landed in a second copy of the app with no account. The fix
-- is something short enough to say out loud or type: any member makes a
-- 6-character password for their room, it works for 24 hours, and anyone
-- signed in types it into 👥 Rooms -> Join in the app they already use.
--
-- Same alphabet as 0008's codes (Crockford base32: no I, L, O, U), so it goes
-- in the same Join box. 32^6 is about 10^9; with join_room's 10 wrong guesses
-- per account per hour, a 24-hour lifetime and at most one live password per
-- room, guessing one is out of reach. A password never equals a live code or
-- another live password, so a typed string names one room.
--
-- Members can already read and share the permanent code, so letting any
-- member make (or end) a password grants nothing new. The columns are not in
-- rooms' column UPDATE grant: they change only through the two functions.
--
-- Additive and safe in any deploy order: before this runs, the app's select
-- of the new columns fails and the room list keeps its old shape (see
-- roomsLoad's fallback). Apply after 0008. Rollback at the bottom.

alter table public.rooms add column if not exists pass text;
alter table public.rooms add column if not exists pass_expires timestamptz;
create unique index if not exists rooms_pass_key on public.rooms (pass) where pass is not null;

create or replace function public.new_room_pass()
returns text language plpgsql volatile set search_path = public as $$
declare a constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; b bytea; c text := ''; i int;
begin
  b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
  foreach i in array array[0, 1, 2, 3, 4, 5] loop                  -- see 0008: bytes 6 and 8 are fixed bits
    c := c || substr(a, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return c;
end $$;

-- Make (or replace) the room's password. Members only; 24 hours.
create or replace function public.set_room_pass(p_room uuid)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare me text := auth.uid()::text; r rooms; c text;
begin
  if me is null then raise exception 'not signed in'; end if;
  if not public.is_account() then raise exception 'link an email first'; end if;
  if not public.is_room_member(p_room) then raise exception 'not a member'; end if;
  -- Expired passwords free their value for reuse (the unique index would
  -- otherwise keep them taken forever).
  update rooms set pass = null, pass_expires = null where pass is not null and pass_expires <= now();
  loop
    c := public.new_room_pass();
    exit when not exists (select 1 from rooms where code = c or pass = c);
  end loop;
  update rooms set pass = c, pass_expires = now() + interval '24 hours' where id = p_room returning * into r;
  return r;
end $$;

-- End it early. Members only.
create or replace function public.clear_room_pass(p_room uuid)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare r rooms;
begin
  if not public.is_room_member(p_room) then raise exception 'not a member'; end if;
  update rooms set pass = null, pass_expires = null where id = p_room returning * into r;
  return r;
end $$;

-- 0008's pruning of day-old misses, as its own function. Same statement;
-- split out only because the Supabase MCP tool would not deliver a request
-- holding both the miss insert and this delete (it timed out every time,
-- before reaching the database), and this file is what was applied.
create or replace function public.room_join_misses_prune()
returns void language sql security definer set search_path = public as $$
  delete from room_join_misses where at < now() - interval '1 day';
$$;

-- join_room as in 0008, plus: a string that isn't a code may be a live
-- password. Commonly mistyped letters are read as the digits they look like
-- (O -> 0, I and L -> 1), which no code or password contains.
create or replace function public.join_room(p_code text)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare me text := auth.uid()::text; r rooms; misses int; want text;
begin
  if me is null then raise exception 'not signed in'; end if;
  if not public.is_account() then raise exception 'link an email first'; end if;
  perform pg_advisory_xact_lock(hashtext('room_join:' || me));
  select count(*) into misses from room_join_misses where user_id = me and at > now() - interval '1 hour';
  if misses >= 10 then raise exception 'too many attempts'; end if;
  want := translate(upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g')), 'OIL', '011');
  select * into r from rooms where rooms.code = want;
  if r.id is null then
    select * into r from rooms where rooms.pass = want and rooms.pass_expires > now();
  end if;
  if r.id is null then
    insert into room_join_misses (user_id) values (me);
    perform public.room_join_misses_prune();
    return null;                                                        -- "no such room"; see 0008
  end if;
  if (select count(*) from room_members where room_id = r.id) >= 50 then raise exception 'room full'; end if;
  insert into room_members (room_id, user_id) values (r.id, me) on conflict do nothing;
  return r;
end $$;

revoke all on function public.new_room_pass(), public.room_join_misses_prune() from public, anon, authenticated;
revoke all on function public.set_room_pass(uuid), public.clear_room_pass(uuid), public.join_room(text) from public, anon;
grant execute on function public.set_room_pass(uuid), public.clear_room_pass(uuid), public.join_room(text) to authenticated;

-- Rollback: re-run 0008_rooms_codes_throttle.sql's join_room, then
-- drop function if exists public.clear_room_pass(uuid);
-- drop function if exists public.set_room_pass(uuid);
-- drop function if exists public.new_room_pass();
-- drop function if exists public.room_join_misses_prune();
-- alter table public.rooms drop column if exists pass_expires, drop column if exists pass;
