/**
 * Daytime check-in job.
 *
 * Runs several times across Tayyab's waking hours (roughly 10am to 5am)
 * so pending tasks stay visible. Sends nothing when the list is empty or
 * the 24-hour window has closed — see runCheckIn for why.
 */
import { cronRequestIsAuthorised } from '@/lib/cron-auth';
import { runCheckIn } from '@/lib/features/summary';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function run(request: Request): Promise<Response> {
  if (!cronRequestIsAuthorised(request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const result = await runCheckIn();
    log.info('Check-in complete', { result });
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Check-in failed', { error: message });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
