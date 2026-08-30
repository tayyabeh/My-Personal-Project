/**
 * Night summary job.
 *
 * Triggered by Supabase pg_cron (not Vercel Cron — the Hobby plan allows
 * only 2 cron jobs at once-per-day granularity, and fires them within the
 * scheduled hour rather than at the minute).
 */
import { cronRequestIsAuthorised } from '@/lib/cron-auth';
import { runNightSummary } from '@/lib/features/summary';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function run(request: Request): Promise<Response> {
  if (!cronRequestIsAuthorised(request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const result = await runNightSummary();
    log.info('Night summary complete', { result });
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Night summary failed', { error: message });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
