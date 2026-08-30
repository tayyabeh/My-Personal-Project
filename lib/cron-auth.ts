/**
 * Guards the scheduled-job endpoints.
 *
 * These URLs are public on the internet, so without this anyone could
 * trigger your night summary. Supabase pg_cron sends the shared secret
 * in a header; anything without it is refused.
 */
import { env } from './env';
import { log } from './logger';

export function cronRequestIsAuthorised(request: Request): boolean {
  const secret = env.cronSecret();

  const bearer = request.headers.get('authorization');
  if (bearer === `Bearer ${secret}`) return true;

  // Alternative header, simpler to configure from pg_net.
  if (request.headers.get('x-cron-secret') === secret) return true;

  log.warn('Rejected unauthorised cron request');
  return false;
}
