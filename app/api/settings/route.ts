/**
 * Saves the schedule from the dashboard settings form.
 */
import { cookies } from 'next/headers';
import { db } from '@/lib/supabase';
import { DASH_COOKIE, sessionToken } from '@/lib/dash-auth';

export const runtime = 'nodejs';

async function authorised(): Promise<boolean> {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return false;
  const store = await cookies();
  return store.get(DASH_COOKIE)?.value === (await sessionToken(password));
}

/** Accepts "9", "9:5", "09:05" and normalises to "09:05". Rejects nonsense. */
function normaliseTime(value: string): string | null {
  const match = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2] ?? '0');
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export async function POST(request: Request): Promise<Response> {
  if (!(await authorised())) return new Response('Unauthorized', { status: 401 });

  const form = await request.formData();
  const update: Record<string, unknown> = {};

  for (const field of ['morning_time', 'night_time', 'weekly_time', 'resurface_time']) {
    const time = normaliseTime(String(form.get(field) ?? ''));
    if (time) update[field] = time;
  }

  const dow = Number(form.get('weekly_dow'));
  if (Number.isInteger(dow) && dow >= 0 && dow <= 6) update.weekly_dow = dow;

  // Comma-separated list; invalid entries are dropped rather than saved.
  const checkins = String(form.get('checkin_times') ?? '')
    .split(',')
    .map((v) => normaliseTime(v))
    .filter((v): v is string => v !== null);
  if (checkins.length > 0) update.checkin_times = checkins;

  if (Object.keys(update).length > 0) {
    update.updated_at = new Date().toISOString();
    const { error } = await db().from('settings').update(update).eq('id', 1);
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.redirect(new URL('/dashboard/settings?saved=1', request.url), 303);
}
