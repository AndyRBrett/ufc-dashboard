-- Block and report: the App Store's user-generated-content rule (guideline
-- 1.2) asks for a way to report objectionable content and to block abusive
-- users. Roasts, challenges, nudges, nicknames and room names are all other
-- people's words reaching your phone, so both exist here, and both are
-- enforced on the server, not only in the app.
--
--   user_blocks      one row per (blocker, blocked). Only the blocker can see,
--                    add or remove it; the blocked person is never told.
--                    send-push reads it (service role) and drops every social
--                    push between the two, in either direction; a challenge
--                    between them can't be created (challenges_insert below).
--   content_reports  insert-only for the app: a reporter can file, never read
--                    back, and only as themselves. Read them in the Supabase
--                    dashboard (Table editor → content_reports, status 'open').
--                    REPORTS_PER_DAY per reporter, so a script can't flood it.
--
-- Same conventions as 0003 / 0006: ids are auth.uid()::text, RLS on, explicit
-- grants, idempotent. Blocking works for anonymous accounts too: the person
-- being harassed is not required to link an email first.
--
-- Apply any time. Until it exists, send-push treats the missing table as "no
-- blocks" and the app keeps its blocks on the device. Rollback at the bottom.

create table if not exists public.user_blocks (
  blocker_id  text not null,
  blocked_id  text not null check (char_length(blocked_id) between 1 and 128),
  blocked_name text check (blocked_name is null or char_length(blocked_name) <= 60),  -- for the unblock list
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists user_blocks_blocked on public.user_blocks (blocked_id);

create table if not exists public.content_reports (
  id            bigserial primary key,
  reporter_id   text not null,
  reported_id   text check (reported_id is null or char_length(reported_id) <= 128),
  reported_name text check (reported_name is null or char_length(reported_name) <= 60),
  kind          text not null check (kind in ('roast','challenge','nickname','room','other')),
  content       text check (content is null or char_length(content) <= 2000),
  reason        text check (reason is null or char_length(reason) <= 300),
  status        text not null default 'open' check (status in ('open','actioned','dismissed')),
  created_at    timestamptz not null default now()
);
create index if not exists content_reports_open on public.content_reports (status, created_at);

-- Either of the two has blocked the other. SECURITY DEFINER because each
-- side can only see its own rows, and a challenge policy has to look at the
-- target's.
create or replace function public.is_blocked_between(a text, b text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_blocks
                 where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a))
$$;

-- A report cap per reporter per day, counted server-side.
create or replace function public.content_reports_cap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from content_reports
      where reporter_id = new.reporter_id and created_at > now() - interval '1 day') >= 20 then
    raise exception 'report limit reached, try again tomorrow';
  end if;
  return new;
end $$;
drop trigger if exists content_reports_cap on public.content_reports;
create trigger content_reports_cap before insert on public.content_reports
  for each row execute function public.content_reports_cap();

-- -------------------------------------------------------------------- RLS --
alter table public.user_blocks     enable row level security;
alter table public.content_reports enable row level security;

drop policy if exists user_blocks_select on public.user_blocks;
create policy user_blocks_select on public.user_blocks for select to authenticated
  using (blocker_id = auth.uid()::text);
drop policy if exists user_blocks_insert on public.user_blocks;
create policy user_blocks_insert on public.user_blocks for insert to authenticated
  with check (blocker_id = auth.uid()::text);
drop policy if exists user_blocks_delete on public.user_blocks;
create policy user_blocks_delete on public.user_blocks for delete to authenticated
  using (blocker_id = auth.uid()::text);

drop policy if exists content_reports_insert on public.content_reports;
create policy content_reports_insert on public.content_reports for insert to authenticated
  with check (reporter_id = auth.uid()::text and status = 'open');

revoke all on public.user_blocks, public.content_reports from anon, authenticated;
grant select, insert, delete on public.user_blocks to authenticated;
grant insert (reporter_id, reported_id, reported_name, kind, content, reason)
  on public.content_reports to authenticated;
grant usage on sequence public.content_reports_id_seq to authenticated;

-- A blocked pair can't challenge each other (0003's policy, plus the block).
drop policy if exists challenges_insert on public.challenges;
create policy challenges_insert on public.challenges
  for insert to authenticated
  with check (auth.uid()::text = challenger_id and target_id <> challenger_id
              and not public.is_blocked_between(challenger_id, target_id));

revoke all on function public.is_blocked_between(text, text), public.content_reports_cap() from public, anon;
grant execute on function public.is_blocked_between(text, text) to authenticated;

-- ------------------------------------------------------------------- DOWN --
-- drop policy if exists challenges_insert on public.challenges;
-- create policy challenges_insert on public.challenges for insert to authenticated
--   with check (auth.uid()::text = challenger_id and target_id <> challenger_id);
-- drop table if exists public.content_reports;
-- drop table if exists public.user_blocks;
-- drop function if exists public.content_reports_cap();
-- drop function if exists public.is_blocked_between(text, text);
