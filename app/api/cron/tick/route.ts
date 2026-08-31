/**
 * The scheduler tick. Runs every 5 minutes from Supabase pg_cron.
 *
 * Replaces the seven fixed cron entries that used to encode each time.
 * Times now live in `settings` and are editable from the dashboard.
 */
import { cronRequestIsAuthorised } from '@/lib/cron-auth';
import { runTick } from '@/lib/scheduler';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function run(request: Request): Promise<Response> {
  if (!cronRequestIsAuthorised(request)) return new Response('Unauthorized', { status: 401 });
  try {
    const result = await runTick();
    if (result !== 'nothing due') log.info('Tick fired jobs', { result });
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Tick failed', { error: message });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
