/**
 * Morning greeting job.
 *
 * Triggered by Supabase pg_cron. See the night route for why we are not
 * using Vercel Cron.
 */
import { cronRequestIsAuthorised } from '@/lib/cron-auth';
import { runMorningGreeting } from '@/lib/features/summary';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function run(request: Request): Promise<Response> {
  if (!cronRequestIsAuthorised(request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const result = await runMorningGreeting();
    log.info('Morning greeting complete', { result });
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Morning greeting failed', { error: message });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
