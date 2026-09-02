-- =====================================================================
-- Run ONCE in Supabase: SQL Editor -> New query -> Run. Safe to re-run.
--
-- Phase 1 — honesty core.
--
-- `runs` is one row per WhatsApp message actually processed by the agent
-- loop. Its own UNIQUE constraint on whatsapp_message_id is defense in
-- depth on top of the one `messages` already has: it is what makes the
-- run itself, not just the inbound message, provably exactly-once.
--
-- `write_ops` is the idempotency ledger every write tool claims before
-- doing anything to the world — a DB insert or a Google API call alike.
-- Google writes cannot get a UNIQUE constraint of their own (there is no
-- natural key on "create this calendar event"), so this table is what
-- stands in for one.
-- =====================================================================

create table if not exists runs (
  id                   uuid primary key default gen_random_uuid(),
  whatsapp_message_id  text not null unique,
  to_number            text not null,
  input                text not null,
  status               text not null default 'running'
                         check (status in ('running', 'done', 'failed', 'timeout')),
  reply                text,
  steps                jsonb not null default '[]'::jsonb,
  error                text,
  started_at           timestamptz not null default now(),
  finished_at          timestamptz,
  created_at           timestamptz not null default now()
);

create index if not exists runs_started_idx on runs (started_at desc);
alter table runs enable row level security;

create table if not exists write_ops (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references runs(id) on delete cascade,
  idempotency_key text not null unique,
  tool            text not null,
  effect          text not null,
  target          text,
  result          jsonb not null default '{}'::jsonb,
  ok              boolean not null default false,
  error           text,
  created_at      timestamptz not null default now()
);

create index if not exists write_ops_run_idx on write_ops (run_id, created_at desc);
alter table write_ops enable row level security;

-- Lets set_voice pick among tts.ts's fixed VOICES set, instead of every
-- podcast/voice reply hard-coding the same default.
alter table settings add column if not exists tts_voice text not null default 'diana';

select 'migration 7 complete' as status;
