-- =====================================================================
-- Run ONCE in Supabase: SQL Editor -> New query -> Run. Safe to re-run.
--
-- Makes the schedule editable from the dashboard instead of being baked
-- into pg_cron. A tick runs every 5 minutes and fires whatever is due,
-- so changing a time takes effect immediately with no SQL to re-run.
-- =====================================================================

alter table settings add column if not exists checkin_times text[]
  not null default '{13:00,16:00,19:00,22:00,01:00}';
alter table settings add column if not exists weekly_time time not null default '21:00';
alter table settings add column if not exists weekly_dow  integer not null default 0; -- 0 = Sunday
alter table settings add column if not exists resurface_time time not null default '18:00';

-- Remembers when each scheduled job last ran, so a 5-minute tick cannot
-- fire the same job repeatedly within its window.
create table if not exists job_runs (
  job         text primary key,
  last_run_at timestamptz not null default now()
);

alter table job_runs enable row level security;

select 'migration 3 complete' as status;
