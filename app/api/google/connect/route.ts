/**
 * Starts the Google sign-in flow.
 *
 * Open this once in a browser to connect Calendar, Gmail and Drive:
 *   /api/google/connect?key=YOUR_DASHBOARD_PASSWORD
 *
 * The password matters: without it, anyone who found this URL could
 * connect THEIR Google account and overwrite the stored refresh token.
 */
import { createHmac } from 'node:crypto';
import { optional, required } from '@/lib/env';
import { consentUrl } from '@/lib/google/oauth';

export const runtime = 'nodejs';

/** A value we can recognise when Google hands it back, proving we started this. */
export function makeState(): string {
  return createHmac('sha256', required('CRON_SECRET')).update('google-oauth').digest('hex');
}

export async function GET(request: Request): Promise<Response> {
  const key = new URL(request.url).searchParams.get('key');
  const expected = optional('DASHBOARD_PASSWORD');

  if (!expected || key !== expected) {
    return new Response(
      'Add ?key=YOUR_DASHBOARD_PASSWORD to this URL. The password is the DASHBOARD_PASSWORD ' +
        'environment variable.',
      { status: 401 },
    );
  }

  return Response.redirect(consentUrl(makeState()), 302);
}
