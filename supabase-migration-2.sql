-- =====================================================================
-- Run ONCE in Supabase: SQL Editor -> New query -> Run. Safe to re-run.
--
-- Adds:
--   settings.pending_action  - lets the bot ask a question and remember
--                              it is waiting for the answer
--   tasks.google_event_id    - so a task can appear on Google Calendar
-- =====================================================================

alter table settings add column if not exists pending_action jsonb;
alter table tasks    add column if not exists google_event_id text;

select 'migration 2 complete' as status;
