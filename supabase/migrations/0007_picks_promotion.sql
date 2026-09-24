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

-- DOWN (only after every client stops sending the field):
-- alter table public.picks drop constraint if exists picks_promotion_format;
-- alter table public.picks drop column if exists promotion;
