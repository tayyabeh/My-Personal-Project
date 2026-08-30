/**
 * Weekly review. Runs Sunday evening from Supabase pg_cron.
 */
import { cronRequestIsAuthorised } from '@/lib/cron-auth';
import { runWeeklyReview } from '@/lib/features/weekly-review';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function run(request: Request): Promise<Response> {
  if (!cronRequestIsAuthorised(request)) {
    return new Response('Unauthorized', { status: 401 });
  }
  try {
    const result = await runWeeklyReview();
    log.info('Weekly review complete', { result });
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Weekly review failed', { error: message });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
