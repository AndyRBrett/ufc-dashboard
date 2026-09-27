-- A lasting per-account daily quota for ai-breakdown (the paid Anthropic / xAI
-- calls).
--
-- The function's own limits are in memory, per edge instance: a cold start
-- resets them and a second instance doesn't share them, so they bound a burst
-- but not a day. This keeps one row per (account, UTC day, bucket) and takes
-- from it atomically: the conditional ON CONFLICT update is the check and the
-- increment in one statement, so two concurrent calls can't both take the
-- last one. Buckets: "all" (every action, AI_DAILY_CAP) and "fight-iq"
-- (IQ_DAILY_CAP).
--
-- Only ai-breakdown touches it, with the service-role key: RLS on and no
-- policies for the table, execute on the function for service_role only.
--
-- Apply any time: until it exists, ai-breakdown falls back to its in-memory
-- limits (and logs it). Rollback at the bottom.

create table if not exists public.ai_usage (
  user_id text not null,
  day     date not null,
  bucket  text not null,
  n       int  not null default 0,
  primary key (user_id, day, bucket)
);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from public, anon, authenticated;

-- Take one from (user, today UTC, bucket) if under cap. true = taken.
create or replace function public.ai_quota_take(p_user text, p_bucket text, p_cap int)
returns boolean language plpgsql security definer set search_path = public as $$
declare got int;
begin
  if p_user is null or p_user = '' or p_cap is null or p_cap < 1 then return false; end if;
  insert into ai_usage (user_id, day, bucket, n)
    values (p_user, (now() at time zone 'utc')::date, p_bucket, 1)
  on conflict (user_id, day, bucket) do update set n = ai_usage.n + 1
    where ai_usage.n < p_cap
  returning n into got;
  if random() < 0.01 then
    delete from ai_usage where day < (now() at time zone 'utc')::date - 30;   -- keep a month
  end if;
  return got is not null;
end $$;

revoke all on function public.ai_quota_take(text, text, int) from public, anon, authenticated;
grant execute on function public.ai_quota_take(text, text, int) to service_role;

-- Rollback:
-- drop function if exists public.ai_quota_take(text, text, int);
-- drop table if exists public.ai_usage;
