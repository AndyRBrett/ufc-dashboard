-- ===========================================================================
-- Native iOS push devices (APNs) — the App Store build
-- ===========================================================================
--
-- Web Push doesn't run inside an iOS app's web view, so the native build
-- (native/, Capacitor) registers an APNs device token instead of a web-push
-- subscription, and send-push delivers to it through Apple directly.
--
-- Its own table, not more columns on push_subs: push_subs is keyed on
-- user_id (one browser per account), its primary key is the on_conflict
-- target the live web register upserts on, and it is one of the core tables
-- check:migrations compares with production's catalog. A token is keyed on
-- itself, so an account can hold a phone and an iPad, and a token that moves
-- to another account (sign out, sign in as someone else) moves with it.
--
-- RLS: nobody writes through the API except to delete their own device
-- (turning notifications off). send-push registers with the service key
-- after checking the caller's session JWT, exactly like push_subs. A DELETE
-- ... WHERE token = … needs SELECT on the columns it filters and a SELECT
-- policy the row passes, so owners can also read their own rows; without
-- that the delete matched nothing and the phone kept getting pushes.
--
-- Deleting an account: apns_devices is in delete_my_account's list (0014,
-- re-runnable), and the trigger below covers an install that applies this
-- without re-running 0014.
--
-- Additive and safe in any deploy order: until this is applied send-push's
-- APNs register answers 502 (the app keeps trying on each open) and the send
-- path, which only runs once the APNS_* secrets are set, finds no devices.
--
-- Paste into the Supabase SQL editor to apply, then run the check query in
-- CLAUDE.md ("0022 apns devices").
-- ===========================================================================

create table if not exists public.apns_devices (
  token        text primary key check (token ~ '^[0-9a-f]{64,200}$'),
  user_id      text not null,
  nickname     text,
  env          text not null default 'production' check (env in ('production', 'sandbox')),
  live_results boolean not null default false,
  updated_at   timestamptz not null default now()
);

create index if not exists apns_devices_user_idx on public.apns_devices (user_id);

alter table public.apns_devices enable row level security;

drop policy if exists apns_devices_select on public.apns_devices;
create policy apns_devices_select on public.apns_devices
  for select to authenticated using (auth.uid()::text = user_id);

drop policy if exists apns_devices_delete on public.apns_devices;
create policy apns_devices_delete on public.apns_devices
  for delete to authenticated using (auth.uid()::text = user_id);

revoke all on public.apns_devices from anon, authenticated;
grant select, delete on public.apns_devices to authenticated;
grant select, insert, update, delete on public.apns_devices to service_role;

-- Deleting the login (delete_my_account, or an admin) forgets its devices.
create or replace function public.apns_devices_forget_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.apns_devices where user_id = old.id::text;
  return old;
end $$;
revoke all on function public.apns_devices_forget_user() from public, anon, authenticated;

do $$
begin
  if to_regclass('auth.users') is not null then
    drop trigger if exists apns_devices_forget_user on auth.users;
    create trigger apns_devices_forget_user after delete on auth.users
      for each row execute function public.apns_devices_forget_user();
  end if;
end $$;

-- Rollback:
--   drop trigger if exists apns_devices_forget_user on auth.users;
--   drop function if exists public.apns_devices_forget_user();
--   drop table if exists public.apns_devices;
