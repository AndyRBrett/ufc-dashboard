-- ===========================================================================
-- Challenges / side bets — UFC Dashboard
-- ===========================================================================
--
-- A user calls out a rival on a single fight (f1/f2 set) or a whole card
-- (f1/f2 null) with a stake ("Loser spins the wheel 🎡"). The target accepts
-- or declines. There is intentionally NO stored winner/resolution: the outcome
-- is derived client-side from picks + fight results, which every phone
-- computes identically — so there is nothing for a malicious client to forge.
--
-- Names are denormalized because anonymous-auth user_ids rotate when device
-- storage resets; the leaderboard's base-nickname identity keeps old
-- challenges renderable (the same accepted trade-off trash-talk targeting has).
--
-- RLS: read is public (the leaderboard is public by design and the activity
-- feed shows challenges); only the signed-in challenger can create a challenge
-- as themselves; only the target can respond, only while it is pending, and
-- only by setting status/responded_at (column-level grant stops the target
-- from rewriting the terms).
-- ===========================================================================

create table if not exists public.challenges (
  id              uuid primary key default gen_random_uuid(),
  challenger_id   text not null,
  challenger_name text not null,
  target_id       text not null,
  target_name     text not null,
  event_date      text not null,
  event_name      text not null,
  f1              text,             -- null + null f2 => whole-card challenge
  f2              text,
  stake           text not null default 'Loser spins the wheel 🎡',
  status          text not null default 'pending'
                    check (status in ('pending','accepted','declined')),
  created_at      timestamptz not null default now(),
  responded_at    timestamptz
);

alter table public.challenges enable row level security;

drop policy if exists challenges_select on public.challenges;
create policy challenges_select on public.challenges
  for select using (true);

drop policy if exists challenges_insert on public.challenges;
create policy challenges_insert on public.challenges
  for insert to authenticated
  with check (auth.uid()::text = challenger_id and target_id <> challenger_id);

drop policy if exists challenges_update on public.challenges;
create policy challenges_update on public.challenges
  for update to authenticated
  using (auth.uid()::text = target_id and status = 'pending')
  with check (status in ('accepted','declined'));

-- Column-level guard: the target responds but cannot rewrite the terms.
revoke all    on public.challenges from anon, authenticated;
grant  select on public.challenges to anon, authenticated;
grant  insert on public.challenges to authenticated;
grant  update (status, responded_at) on public.challenges to authenticated;
