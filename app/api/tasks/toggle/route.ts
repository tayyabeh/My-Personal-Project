/**
 * Tick a task off (or back on) from the dashboard.
 *
 * Behind the middleware-protected origin, but we re-check the cookie here
 * too — middleware only guards /dashboard paths, not this API route.
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

export async function POST(request: Request): Promise<Response> {
  if (!(await authorised())) return new Response('Unauthorized', { status: 401 });

  const { id, done } = (await request.json()) as { id?: string; done?: boolean };
  if (!id) return Response.json({ ok: false, error: 'missing id' }, { status: 400 });

  const { error } = await db()
    .from('tasks')
    .update({
      status: done ? 'done' : 'pending',
      completed_at: done ? new Date().toISOString() : null,
    })
    .eq('id', id);

  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
