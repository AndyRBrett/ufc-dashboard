-- ===========================================================================
-- Index notif_log for the push dedup lookup — UFC Dashboard
-- ===========================================================================
--
-- The send-push edge function dedups every notification with
--   SELECT … FROM notif_log WHERE event_date = $1 AND type = $2
-- on each call. notif_log has no index, so that lookup is a sequential scan.
-- It's fast while the table is small, but the table only grows (notably one
-- row per trash-talk/nudge, which use a unique type per send), so the scan
-- cost rises linearly with history and turns table size into per-push latency.
--
-- A composite index on (event_date, type) keeps the dedup lookup fast
-- regardless of how large notif_log gets. It also backs the INSERT's
-- on-conflict path. Created concurrently-safe via IF NOT EXISTS so this
-- migration is idempotent and safe to re-run.
-- ---------------------------------------------------------------------------
create index if not exists notif_log_event_date_type_idx
  on public.notif_log (event_date, type);
