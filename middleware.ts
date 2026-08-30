/**
 * Guards the dashboard.
 *
 * Anything under /dashboard requires the session cookie. Everything else
 * — the WhatsApp webhook, cron jobs, privacy pages — is untouched.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { DASH_COOKIE, sessionToken } from '@/lib/dash-auth';

export async function middleware(request: NextRequest) {
  const password = process.env.DASHBOARD_PASSWORD;

  // With no password configured, refuse rather than expose the data.
  if (!password) {
    return new NextResponse('DASHBOARD_PASSWORD is not set.', { status: 503 });
  }

  const cookie = request.cookies.get(DASH_COOKIE)?.value;
  if (cookie && cookie === (await sessionToken(password))) {
    return NextResponse.next();
  }

  const login = new URL('/login', request.url);
  login.searchParams.set('next', request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
