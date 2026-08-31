-- =====================================================================
-- Run this ONCE in Supabase: SQL Editor -> New query -> Run.
-- Adds the expenses table (Phase 3). Safe to re-run.
-- =====================================================================

create table if not exists expenses (
  id          uuid primary key default gen_random_uuid(),
  amount      numeric(12,2) not null,
  category    text not null default 'other',
  description text,
  spent_on    date not null default (now() at time zone 'Asia/Karachi')::date,
  created_at  timestamptz not null default now()
);

create index if not exists expenses_date_idx on expenses (spent_on desc);
alter table expenses enable row level security;

select 'expenses table ready' as status;
