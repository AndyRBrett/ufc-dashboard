-- A room can choose to show its members' picks before they lock.
--
-- 0017 hides every player's pick from everyone else until its bout locks, and
-- that stays the rule everywhere: the main board, the Lab, every other room.
-- A room's owner can now switch show_picks on (default off), and then the
-- room's members see each other's picks for a card inside that room's board,
-- through room_early_picks() only. The picks_select policy is untouched, so
-- nothing outside the room can read an unlocked pick, and switching it off
-- hides them again on the next load.
--
-- Owner only, through set_room_show_picks(): show_picks is not in rooms'
-- column UPDATE grant. room_early_picks() answers only a member of a room with
-- the switch on, only for that room's members, UFC rows only, like the board.
--
-- Apply after 0006 (and 0017). Rollback at the bottom.

alter table public.rooms add column if not exists show_picks boolean not null default false;

create or replace function public.set_room_show_picks(p_room uuid, p_on boolean)
returns public.rooms language plpgsql security definer set search_path = public as $$
declare me text := auth.uid()::text; r rooms;
begin
  if me is null then raise exception 'not signed in'; end if;
  if not public.is_account() then raise exception 'link an email first'; end if;
  update rooms set show_picks = coalesce(p_on, false)
   where id = p_room and owner_id = me returning * into r;
  if r.id is null then raise exception 'only the room owner can change this'; end if;
  return r;
end $$;

create or replace function public.room_early_picks(p_room uuid, p_date text)
returns table (user_id text, event_name text, event_date text, f1 text, f2 text, pick text, method text,
               confidence integer, nickname text, updated_at timestamptz, bonus_pick text)
language sql stable security definer set search_path = public as $$
  select p.user_id, p.event_name, p.event_date, p.f1, p.f2, p.pick, p.method,
         p.confidence, p.nickname, p.updated_at, p.bonus_pick
    from picks p
    join room_members m on m.room_id = p_room and m.user_id = p.user_id
   where p.event_date = p_date
     and coalesce(p.promotion, 'ufc') = 'ufc'
     and public.is_room_member(p_room)
     and exists (select 1 from rooms r where r.id = p_room and r.show_picks)
$$;

revoke all on function public.set_room_show_picks(uuid, boolean), public.room_early_picks(uuid, text) from public, anon;
grant execute on function public.set_room_show_picks(uuid, boolean), public.room_early_picks(uuid, text) to authenticated;

-- Rollback:
-- drop function if exists public.room_early_picks(uuid, text);
-- drop function if exists public.set_room_show_picks(uuid, boolean);
-- alter table public.rooms drop column if exists show_picks;
