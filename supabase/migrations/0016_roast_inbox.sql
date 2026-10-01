-- ===========================================================================
-- Roast inbox — UFC Dashboard
-- ===========================================================================
--
-- A trash-talk roast used to exist only inside its push payload. Getting it
-- from the notification onto the page went notificationclick -> a cache
-- stash or a postMessage -> the page, and on iOS either hop can be lost: the
-- tap opened the app and showed nothing. It was patched three times
-- (#235, #236, #237) and still failed on 2026-10-01.
--
-- So send-push now also leaves the roast here, one row per recipient, and the
-- app reads its own unseen rows on open, on foreground, when a push arrives
-- and on a slow poll. The notification only has to wake the app.
--
-- RLS: a recipient reads and marks seen only their own rows. Nobody but
-- send-push (service role) inserts, so a roast's text and title are always
-- the server-built ones send-push vouched for. Owners may delete their rows.
--
-- Retention: send-push prunes rows older than 7 days at most hourly on ANY
-- call (every app open re-registers through it), so it doesn't wait on the
-- next roast. A deleted account's rows go with its login: delete_my_account
-- (0014) deletes the auth.users row, and the trigger below clears its inbox.
--
-- Additive and safe in any deploy order: without this table send-push's
-- insert fails quietly and the app's read 404s quietly, i.e. push-only as
-- before.
--
-- Paste into the Supabase SQL editor to apply.
-- ===========================================================================

create table if not exists public.roast_inbox (
  id           bigserial primary key,
  recipient_id text not null,
  title        text not null default '',
  body         text not null,
  created_at   timestamptz not null default now(),
  seen_at      timestamptz
);

create index if not exists roast_inbox_recipient_idx
  on public.roast_inbox (recipient_id, created_at desc);

alter table public.roast_inbox enable row level security;

drop policy if exists roast_inbox_select on public.roast_inbox;
create policy roast_inbox_select on public.roast_inbox
  for select to authenticated using (auth.uid()::text = recipient_id);

drop policy if exists roast_inbox_update on public.roast_inbox;
create policy roast_inbox_update on public.roast_inbox
  for update to authenticated
  using (auth.uid()::text = recipient_id)
  with check (auth.uid()::text = recipient_id);

drop policy if exists roast_inbox_delete on public.roast_inbox;
create policy roast_inbox_delete on public.roast_inbox
  for delete to authenticated using (auth.uid()::text = recipient_id);

-- Only seen_at may change: a recipient can't rewrite what they were sent.
revoke update on public.roast_inbox from anon, authenticated;
grant update (seen_at) on public.roast_inbox to authenticated;
grant select, delete on public.roast_inbox to authenticated;

-- Deleting the login (delete_my_account, or an admin) clears its inbox.
create or replace function public.roast_inbox_forget_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.roast_inbox where recipient_id = old.id::text;
  return old;
end $$;
revoke all on function public.roast_inbox_forget_user() from public, anon, authenticated;

do $$
begin
  if to_regclass('auth.users') is not null then
    drop trigger if exists roast_inbox_forget_user on auth.users;
    create trigger roast_inbox_forget_user after delete on auth.users
      for each row execute function public.roast_inbox_forget_user();
  end if;
end $$;

-- Rollback:
-- drop trigger if exists roast_inbox_forget_user on auth.users;
-- drop function if exists public.roast_inbox_forget_user();
-- drop table if exists public.roast_inbox;
