-- =====================================================================
-- Run ONCE in Supabase: SQL Editor -> New query -> Run. Safe to re-run.
--
-- Moves things that were hard-coded into settings, so they can be changed
-- from WhatsApp instead of needing a code change:
--   daily_tasks       - the tasks added automatically every morning
--   namaz_reminders   - whether prayer reminders are scheduled
--   namaz_minutes_before - how much warning before each prayer
-- =====================================================================

alter table settings add column if not exists daily_tasks text[]
  not null default '{Gym,"Namaz (paanchon waqt)"}';
alter table settings add column if not exists namaz_reminders boolean not null default true;
alter table settings add column if not exists namaz_minutes_before integer not null default 15;

select 'migration 4 complete' as status;
