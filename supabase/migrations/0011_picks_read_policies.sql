-- picks: one read policy per role, kept in version control.
--
-- The live table had four SELECT policies, all `using (true)`: picks_select
-- (anon), picks_select_auth (authenticated), and two made in the dashboard
-- that no migration records ("Enable read access for all users" and
-- "public read", both on the public role). Reading picks is public by design
-- (the leaderboard), so none of them widened access; but the two dashboard ones
-- were drift, and a policy nobody can see in the repo is one nobody reviews.
--
-- This replaces all four with the two that say what is meant. Access is
-- unchanged: anon and authenticated can still read every pick, and no one can
-- write through a SELECT policy. Runs in one transaction, so there is no moment
-- with no read policy at all.

drop policy if exists "Enable read access for all users" on public.picks;
drop policy if exists "public read"                      on public.picks;
drop policy if exists picks_select                       on public.picks;
drop policy if exists picks_select_auth                  on public.picks;

create policy picks_select      on public.picks for select to anon          using (true);
create policy picks_select_auth on public.picks for select to authenticated using (true);
