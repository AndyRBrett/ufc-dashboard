-- A challenge's stake can be marked paid.
--
-- "Pay up — spin now 🎡" opened the wheel and nothing else: no challenge ever
-- recorded that its loser had spun, so a settled bet sat on "lost" with the
-- Pay up button forever (UFC 333, 2026-10-24). paid_at says when, paid_spin
-- what the wheel landed on, and both sides see it.
--
-- Written only through mark_challenge_paid(), by either party, once, and only
-- on an accepted challenge: the outcome itself is still derived client-side
-- (0003), so the server can't tell who lost and doesn't try; a winner marking
-- their own bet paid just saves the loser the spin. The columns get no update
-- grant, so a direct REST write can't touch them. delete_my_account() already
-- deletes the caller's challenges whole.
--
-- Apply after 0003. Rollback at the bottom.

alter table public.challenges add column if not exists paid_at timestamptz;
alter table public.challenges add column if not exists paid_spin text;

create or replace function public.mark_challenge_paid(p_id uuid, p_spin text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare me text := auth.uid()::text; n int;
begin
  if me is null then return false; end if;
  update challenges
     set paid_at = now(), paid_spin = nullif(left(trim(coalesce(p_spin, '')), 80), '')
   where id = p_id and status = 'accepted' and paid_at is null
     and me in (challenger_id, target_id);
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.mark_challenge_paid(uuid, text) from public, anon;
grant execute on function public.mark_challenge_paid(uuid, text) to authenticated;

-- Rollback:
-- drop function if exists public.mark_challenge_paid(uuid, text);
-- alter table public.challenges drop column if exists paid_spin, drop column if exists paid_at;
