/**
 * Dashboard login. Sets the session cookie when the password matches.
 */
import { cookies } from 'next/headers';
import { DASH_COOKIE, sessionToken } from '@/lib/dash-auth';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const password = String(form.get('password') ?? '');
  const next = String(form.get('next') || '/dashboard');
  const expected = process.env.DASHBOARD_PASSWORD;

  if (!expected || password !== expected) {
    return Response.redirect(new URL('/login?error=1', request.url), 303);
  }

  const store = await cookies();
  store.set(DASH_COOKIE, await sessionToken(expected), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 90, // 90 days; it is only ever this one device
  });

  // Only allow relative paths, so this cannot be turned into an open redirect.
  const target = next.startsWith('/') ? next : '/dashboard';
  return Response.redirect(new URL(target, request.url), 303);
}
