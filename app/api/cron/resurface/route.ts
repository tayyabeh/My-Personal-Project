/**
 * Spaced repetition. Brings a saved learning back at 3 days, 1 week,
 * 2 weeks and 1 month, then retires it.
 */
import { cronRequestIsAuthorised } from '@/lib/cron-auth';
import { resurfaceDue } from '@/lib/features/learnings';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function run(request: Request): Promise<Response> {
  if (!cronRequestIsAuthorised(request)) return new Response('Unauthorized', { status: 401 });
  try {
    const result = await resurfaceDue();
    log.info('Resurface complete', { result });
    return Response.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Resurface failed', { error: message });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
