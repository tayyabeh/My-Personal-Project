-- =====================================================================
-- Run ONCE in Supabase: SQL Editor -> New query -> Run. Safe to re-run.
--
-- A general store the assistant can use for ANY new kind of data without
-- a schema change.
--
-- Why this instead of letting the agent create tables: a language model
-- holding DDL on the only database is a bad trade. One wrong statement
-- drops the tasks, the messages and the history, and Supabase's free tier
-- has no point-in-time recovery to undo it. A jsonb column gives the same
-- flexibility with none of that risk — a new "kind" costs nothing and
-- cannot damage what already exists.
-- =====================================================================

create table if not exists records (
  id          uuid primary key default gen_random_uuid(),
  -- What sort of thing this is: 'weight', 'mood', 'expense_note', anything.
  kind        text not null,
  -- The thing itself. Shape is up to whatever created it.
  data        jsonb not null default '{}'::jsonb,
  -- When it happened, which is not always when it was written down.
  happened_at timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create index if not exists records_kind_idx on records (kind, happened_at desc);
create index if not exists records_time_idx on records (happened_at desc);

alter table records enable row level security;

select 'migration 5 complete' as status;
