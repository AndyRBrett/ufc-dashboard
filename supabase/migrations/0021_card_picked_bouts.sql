-- Who has picked which bouts on a card, without what they picked.
--
-- 0017 hides another player's pick until its bout locks, and the app builds the
-- board and the "hasn't finished picks" nudge list from the rows it can read.
-- So before the first bell everyone else's picks for tonight read as nothing:
-- This Event listed only the viewer, and the nudge list offered to nudge a
-- player who had picked the whole card (2026-10-10: T had all 12 in, the board
-- showed only AB and called T 0/5).
--
-- This answers just the part that was never secret: the player, the bout and
-- when it was saved. Never the pick, the method or the 🔒, which stay behind
-- 0017's lock. UFC only, like the board it feeds. Read as the owner, so it sees
-- every row; that is the point, and why it returns only these columns.
--
-- Apply after 0017. Rollback at the bottom.

create or replace function public.card_picked_bouts(p_date text)
returns table (user_id text, nickname text, f1 text, f2 text, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.user_id, p.nickname, p.f1, p.f2, p.updated_at
    from picks p
   where p.event_date = p_date
     and coalesce(p.promotion, 'ufc') = 'ufc'
     and p.pick is not null and p.pick <> '' and p.pick <> '-'
$$;
revoke all on function public.card_picked_bouts(text) from public;
grant execute on function public.card_picked_bouts(text) to anon, authenticated;

-- Rollback:
-- drop function if exists public.card_picked_bouts(text);
