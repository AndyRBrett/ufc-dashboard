-- picks: only email accounts write picks.
--
-- Anonymous sign-up is open: anyone who loads the site gets a uid, and until
-- now that uid could put a nickname and a pick on everyone's board (one did,
-- 2026-09-30: an anonymous session from a VPN exit, one pick, keyboard-mash
-- name). Rooms already require an account (0006); picks now do too.
--
-- INSERT and UPDATE need is_account(). Linking an email keeps the same
-- user_id, so an anonymous player's old rows are still theirs and still
-- score; they just can't add to or change them until they link. DELETE stays
-- owner-only without the account test: removing your own row adds nothing to
-- the board, and the pick lock (0010) still refuses it once the bout starts.
--
-- is_account() is redefined here, identically to 0006, so this file applies
-- on its own.

create or replace function public.is_account()
returns boolean language sql stable set search_path = public as $$
  select auth.uid() is not null and not coalesce((auth.jwt()->>'is_anonymous')::boolean, true)
$$;

drop policy if exists picks_insert on public.picks;
drop policy if exists picks_update on public.picks;
create policy picks_insert on public.picks for insert to authenticated
  with check (auth.uid()::text = user_id and public.is_account());
create policy picks_update on public.picks for update to authenticated
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id and public.is_account());
