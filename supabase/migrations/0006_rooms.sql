-- Watch Party rooms (task #4). Approved by Andy 2026-09-24.
-- v2: creating or joining a room requires an email-linked account, so
-- membership follows the person across phones (no ghost members).
-- Same conventions as 0003_challenges.sql: user ids are auth.uid()::text
-- (anonymous auth), RLS on, explicit grants, idempotent.

-- ----------------------------------------------------------------- tables --
create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 40),
  code        text not null unique,                 -- invite code, 6 chars
  owner_id    text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    text not null,
  joined_at  timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists room_members_user on public.room_members (user_id);

-- ---------------------------------------------------------------- helpers --
-- An email-linked (non-anonymous) session: rooms are for accounts only.
-- A missing claim counts as anonymous, so this fails closed.
create or replace function public.is_account()
returns boolean language sql stable set search_path = public as $$
  select auth.uid() is not null and not coalesce((auth.jwt()->>'is_anonymous')::boolean, true)
$$;

-- SECURITY DEFINER so the membership check inside RLS doesn't recurse into
-- room_members' own policy. Membership only counts from an account session, so reading a room or its
-- roster needs an email login too, not just a row in room_members.
create or replace function public.is_room_member(r uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_account()
     and exists (select 1 from room_members where room_id = r and user_id = auth.uid()::text)
$$;

-- Create a room: caller becomes owner and first member. Caps: 10 owned rooms.
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
    c := upper(substr(md5(gen_random_uuid()::text), 1, 6));   -- no pgcrypto needed
    exit when not exists (select 1 from rooms where code = c);
  end loop;
  insert into rooms (name, code, owner_id) values (btrim(p_name), c, me) returning * into r;
  insert into room_members (room_id, user_id) values (r.id, me);
  return r;
end $$;

-- Join by invite code. The code is the only way in: rooms aren't listable.
-- Caps: 50 members per room.
create or replace function public.join_room(p_code text)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare me text := auth.uid()::text; r rooms;
begin
  if me is null then raise exception 'not signed in'; end if;
  -- Rooms belong to ACCOUNTS, not devices: an anonymous uid dies with the
  -- phone's storage, an email-linked uid comes back on any device.
  if not public.is_account() then raise exception 'link an email first'; end if;
  select * into r from rooms where code = upper(btrim(p_code));
  if r.id is null then raise exception 'no such room'; end if;
  if (select count(*) from room_members where room_id = r.id) >= 50 then raise exception 'room full'; end if;
  insert into room_members (room_id, user_id) values (r.id, me) on conflict do nothing;
  return r;
end $$;

-- -------------------------------------------------------------------- RLS --
alter table public.rooms        enable row level security;
alter table public.room_members enable row level security;

drop policy if exists rooms_select on public.rooms;
create policy rooms_select on public.rooms for select to authenticated
  using (public.is_room_member(id));                 -- members only: hides codes
drop policy if exists rooms_update on public.rooms;
create policy rooms_update on public.rooms for update to authenticated
  using (public.is_account() and owner_id = auth.uid()::text) with check (owner_id = auth.uid()::text);
drop policy if exists rooms_delete on public.rooms;
create policy rooms_delete on public.rooms for delete to authenticated
  using (public.is_account() and owner_id = auth.uid()::text);

drop policy if exists room_members_select on public.room_members;
create policy room_members_select on public.room_members for select to authenticated
  using (public.is_room_member(room_id));            -- see your rooms' rosters
drop policy if exists room_members_leave on public.room_members;
create policy room_members_leave on public.room_members for delete to authenticated
  using (public.is_account() and user_id = auth.uid()::text   -- leave
         or public.is_account() and exists (select 1 from rooms where id = room_id and owner_id = auth.uid()::text)); -- owner kicks

revoke all on public.rooms, public.room_members from anon, authenticated;
grant select, delete         on public.rooms        to authenticated;
grant update (name)          on public.rooms        to authenticated;
grant select, delete         on public.room_members to authenticated;
-- inserts only through the two functions above
revoke all on function public.create_room(text), public.join_room(text), public.is_room_member(uuid), public.is_account() from public, anon;
grant execute on function public.create_room(text), public.join_room(text) to authenticated;
grant execute on function public.is_room_member(uuid), public.is_account() to authenticated;

-- ------------------------------------------------------------------- DOWN --
-- drop function if exists public.join_room(text);
-- drop function if exists public.create_room(text);
-- drop table if exists public.room_members;
-- drop table if exists public.rooms;
-- drop function if exists public.is_room_member(uuid);
-- drop function if exists public.is_account();
