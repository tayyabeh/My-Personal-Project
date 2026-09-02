/**
 * Google sign-in and token handling.
 *
 * Deliberately written with plain fetch rather than the googleapis
 * package, which is enormous and would bloat the Vercel bundle. The REST
 * endpoints we need are simple.
 *
 * How it works, once:
 *   1. You open /api/google/connect and approve access.
 *   2. Google sends you back to /api/google/callback with a code.
 *   3. We swap that code for a refresh token and store it in `settings`.
 *
 * After that the refresh token is used to mint short-lived access tokens
 * as needed. It does not expire, because the OAuth consent screen is now
 * published "In production" rather than "Testing".
 */
import { env, optional, required } from '../env';
import { db } from '../supabase';
import { log } from '../logger';

/** Everything the assistant will eventually need, requested in one go. */
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
  'email',
];

function clientId(): string {
  return required('GOOGLE_CLIENT_ID');
}
function clientSecret(): string {
  return required('GOOGLE_CLIENT_SECRET');
}
function redirectUri(): string {
  return optional('GOOGLE_REDIRECT_URI', `${env.appBaseUrl()}/api/google/callback`);
}

/** The URL that starts the consent flow. */
export function consentUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    // "offline" is what makes Google return a refresh token at all.
    access_type: 'offline',
    // "consent" forces the refresh token to be re-issued even if you have
    // approved before. Without it, a second sign-in returns nothing and
    // you are left wondering why the token is missing.
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Swap the one-time code for a refresh token and store it. */
export async function exchangeCode(code: string): Promise<void> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${await response.text()}`);
  }

  const json = (await response.json()) as { refresh_token?: string };
  if (!json.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. This usually means the account was already ' +
        'connected — revoke access at myaccount.google.com/permissions and try again.',
    );
  }

  const { error } = await db()
    .from('settings')
    .update({ google_refresh_token: json.refresh_token, updated_at: new Date().toISOString() })
    .eq('id', 1);

  if (error) throw new Error(`Could not save refresh token: ${error.message}`);
  log.info('Google account connected');
}

/** Have we been connected yet? */
export async function isConnected(): Promise<boolean> {
  const { data } = await db()
    .from('settings')
    .select('google_refresh_token')
    .eq('id', 1)
    .maybeSingle();
  return Boolean(data?.google_refresh_token);
}

/**
 * A fresh access token. These last about an hour, so we mint one per use
 * rather than caching across invocations.
 */
export async function accessToken(signal?: AbortSignal): Promise<string> {
  const { data, error } = await db()
    .from('settings')
    .select('google_refresh_token')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new Error(`Could not read refresh token: ${error.message}`);

  const refreshToken = data?.google_refresh_token as string | null;
  if (!refreshToken) {
    throw new Error('NOT_CONNECTED');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId(),
      client_secret: clientSecret(),
      grant_type: 'refresh_token',
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Could not refresh Google token: ${await response.text()}`);
  }

  const json = (await response.json()) as { access_token: string };
  return json.access_token;
}
