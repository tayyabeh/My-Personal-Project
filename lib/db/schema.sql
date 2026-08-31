-- =====================================================================
-- Personal AI Manager — database schema
-- Run this once in Supabase:  Dashboard -> SQL Editor -> New query -> Run
-- Safe to re-run: everything uses "if not exists".
--
-- All timestamps are stored in UTC (timestamptz). Your local timezone
-- (Asia/Karachi, UTC+5) is applied only when displaying or scheduling.
-- =====================================================================

create extension if not exists "pgcrypto";  -- gives us gen_random_uuid()

-- ---------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------
create table if not exists tasks (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  description      text,
  status           text not null default 'pending'
                     check (status in ('pending', 'done', 'cancelled')),
  due_date         date,
  priority         text not null default 'normal'
                     check (priority in ('low', 'normal', 'high')),
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,

  -- If this task was carried over from an unfinished task yesterday,
  -- rolled_over_from points at the original and rollover_count counts
  -- how many days in a row it has been pushed forward.
  rolled_over_from uuid references tasks(id) on delete set null,
  rollover_count   integer not null default 0
);

create index if not exists tasks_status_due_idx on tasks (status, due_date);
create index if not exists tasks_rollover_idx   on tasks (rollover_count desc)
  where status = 'pending';

-- ---------------------------------------------------------------------
-- messages  (every message in and out, and the dedupe safety net)
-- ---------------------------------------------------------------------
create table if not exists messages (
  id                  uuid primary key default gen_random_uuid(),
  direction           text not null check (direction in ('inbound', 'outbound')),
  content             text,
  was_voice           boolean not null default false,
  transcript          text,

  -- WhatsApp's own message id. UNIQUE is what makes deduplication work:
  -- if Meta retries a webhook, the second insert fails and we skip it.
  whatsapp_message_id text unique,

  created_at          timestamptz not null default now()
);

create index if not exists messages_created_idx on messages (created_at desc);
create index if not exists messages_inbound_idx on messages (created_at desc)
  where direction = 'inbound';

-- ---------------------------------------------------------------------
-- reminders
-- ---------------------------------------------------------------------
create table if not exists reminders (
  id              uuid primary key default gen_random_uuid(),
  text            text not null,
  trigger_at      timestamptz not null,
  google_event_id text,
  sent            boolean not null default false,
  created_at      timestamptz not null default now()
);

create index if not exists reminders_pending_idx on reminders (trigger_at)
  where sent = false;

-- ---------------------------------------------------------------------
-- learnings  (for the spaced-repetition feature in Phase 3)
-- ---------------------------------------------------------------------
create table if not exists learnings (
  id               uuid primary key default gen_random_uuid(),
  content          text not null,
  topics           text[] not null default '{}',
  created_at       timestamptz not null default now(),
  last_resurfaced  timestamptz,
  resurface_count  integer not null default 0
);

-- ---------------------------------------------------------------------
-- daily_logs  (one row per day, written by the night summary job)
-- ---------------------------------------------------------------------
create table if not exists daily_logs (
  id               uuid primary key default gen_random_uuid(),
  log_date         date not null unique,
  tasks_planned    integer not null default 0,
  tasks_completed  integer not null default 0,
  completion_rate  numeric(5,2) not null default 0,
  motivational_line text,
  mood             text,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- podcasts
-- ---------------------------------------------------------------------
create table if not exists podcasts (
  id         uuid primary key default gen_random_uuid(),
  topic      text not null,
  script     text not null,
  audio_url  text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- settings  (exactly one row, forced by the "id = 1" check)
-- ---------------------------------------------------------------------
create table if not exists settings (
  id                   integer primary key default 1 check (id = 1),
  morning_time         time not null default '07:00',
  night_time           time not null default '22:00',
  timezone             text not null default 'Asia/Karachi',
  google_refresh_token text,
  updated_at           timestamptz not null default now()
);

insert into settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Security: this app is single-user and every query runs from the server
-- using the service_role key, which bypasses RLS. We still turn RLS ON
-- with no policies, so that if the public anon key ever leaks, it can
-- read and write exactly nothing.
-- ---------------------------------------------------------------------
alter table tasks      enable row level security;
alter table messages   enable row level security;
alter table reminders  enable row level security;
alter table learnings  enable row level security;
alter table daily_logs enable row level security;
alter table podcasts   enable row level security;
alter table settings   enable row level security;

-- ---------------------------------------------------------------------
-- expenses  (added in Phase 3; currency is PKR)
-- ---------------------------------------------------------------------
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

-- Escalating reminders (Phase 3)
alter table reminders add column if not exists followup_count integer not null default 0;
alter table reminders add column if not exists last_nudged_at timestamptz;

-- Conversational state and calendar links (Phase 3, later additions)
alter table settings add column if not exists pending_action jsonb;
alter table tasks    add column if not exists google_event_id text;
