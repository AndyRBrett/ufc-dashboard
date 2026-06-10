-- ===========================================================================
-- Spoiler-free push by default — UFC Dashboard
-- ===========================================================================
--
-- Result notifications (sent by scrape.py via the send-push edge function)
-- previously revealed the winner on the lock screen ("Your pick WON! 🔥 —
-- X def. Y"). Anyone watching a delayed broadcast got spoiled.
--
-- New behavior: every subscriber is spoiler-free by default. Result pushes
-- say only that a fight they picked is final. Users who want live winner/
-- loser alerts opt in via the "Live Result Spoilers" toggle in the ⋯ More
-- menu, which re-registers their subscription with live_results = true.
--
-- The send-push function tolerates this column being absent (it falls back
-- to spoiler-free for everyone), so this can be applied before or after the
-- function deploy. Paste into the Supabase SQL editor to apply.
-- ===========================================================================

alter table public.push_subs
  add column if not exists live_results boolean not null default false;
