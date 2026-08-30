/**
 * Dashboard access.
 *
 * One password, one cookie, no signup — this app has exactly one user.
 *
 * The cookie holds a hash of the password rather than the password
 * itself, so a leaked cookie does not hand over the password you might
 * have reused elsewhere. Uses Web Crypto because the middleware that
 * checks it runs on the edge runtime, where node:crypto is unavailable.
 */
export const DASH_COOKIE = 'dash_session';

export async function sessionToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`personal-ai-manager:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
