/**
 * Regenerates supabase-cron.sql.
 *
 * Written as a real file rather than an inline `node -e` string because
 * the previous inline version mangled the `$$` dollar-quote delimiters
 * down to a single `$` through two layers of shell escaping, which made
 * Postgres reject the whole script.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const BASE = 'https://my-personal-project-dr2h.vercel.app';
const SECRET = env.CRON_SECRET;

// [jobname, endpoint, cron (UTC), human label]
const JOBS = [
  ['morning-greeting', 'morning', '0 5 * * *', '10:00 am daily'],
  ['checkin-1', 'checkin', '0 8 * * *', '01:00 pm daily'],
  ['checkin-2', 'checkin', '0 11 * * *', '04:00 pm daily'],
  ['checkin-3', 'checkin', '0 14 * * *', '07:00 pm daily'],
  ['checkin-4', 'checkin', '0 17 * * *', '10:00 pm daily'],
  ['checkin-5', 'checkin', '0 20 * * *', '01:00 am daily'],
  ['night-summary', 'night', '0 22 * * *', '03:00 am daily'],
  ['reminder-check', 'reminders', '* * * * *', 'every minute'],
  ['resurface-learnings', 'resurface', '0 13 * * *', '06:00 pm daily'],
  ['weekly-review', 'weekly', '0 16 * * 0', 'Sunday 09:00 pm'],
];

const D = '$$'; // dollar-quote delimiter, kept in one place so it cannot be mangled

let sql = `-- =====================================================================
-- Scheduled jobs, via Supabase pg_cron + pg_net.
--
-- Run this in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: it unschedules the old jobs first.
--
-- pg_cron works in UTC. Karachi is UTC+5 with no daylight saving, so every
-- hour below is the local time minus 5. Fitted to waking hours of roughly
-- 10am to 5am.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

`;

sql += '-- Clear any previous versions of these jobs.\n';
for (const [name] of JOBS) {
  sql += `select cron.unschedule('${name}') where exists (select 1 from cron.job where jobname = '${name}');\n`;
}
sql += '\n';

for (const [name, endpoint, schedule, label] of JOBS) {
  const headers = `{"Content-Type": "application/json", "x-cron-secret": "${SECRET}"}`;
  sql += `-- ${name} -> ${label} (Karachi)\n`;
  sql += `select cron.schedule('${name}', '${schedule}', ${D}\n`;
  sql += `  select net.http_post(\n`;
  sql += `    url     := '${BASE}/api/cron/${endpoint}',\n`;
  sql += `    headers := '${headers}'::jsonb\n`;
  sql += `  );\n`;
  sql += `${D});\n\n`;
}

sql += '-- Confirm they registered:\nselect jobname, schedule, active from cron.job order by jobname;\n';

writeFileSync('supabase-cron.sql', sql);

console.log(`Wrote supabase-cron.sql with ${JOBS.length} jobs.`);
