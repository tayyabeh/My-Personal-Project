-- =====================================================================
-- Run ONCE in Supabase: SQL Editor -> New query -> Run. Safe to re-run.
--
-- Lets Tayyab set his own namaz timings.
--
-- The Aladhan API returns azan times calculated from the sun. Mosques
-- hold jamaat later than that — often by 20 to 40 minutes — and jamaat is
-- the time he actually needs to be there. So his own times must win over
-- the calculation when he has given them.
--
-- Stored as jsonb like {"Fajr":"05:30","Dhuhr":"13:55",...}. Null means
-- fall back to the API.
-- =====================================================================

alter table settings add column if not exists prayer_times jsonb;

select 'migration 6 complete' as status;
