/**
 * Fires due reminders. Runs every minute from Supabase pg_cron.
 *
 * This is the job that made pg_cron necessary in the first place: Vercel's
 * Hobby plan caps cron at once per day, which is useless for this.
 */
import { cronRequestIsAuthorised } from '@/lib/cron-auth';
import { db } from '@/lib/supabase';
import { log } from '@/lib/logger';
import { messaging, templates } from '@/lib/messaging';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function run(request: Request): Promise<Response> {
  if (!cronRequestIsAuthorised(request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const now = Date.now();
    // Fire 5 minutes ahead. The lower bound is an hour back so that a
    // missed run (deploy, outage) still delivers rather than silently
    // dropping the reminder.
    const upperBound = new Date(now + 6 * 60 * 1000).toISOString();
    const lowerBound = new Date(now - 60 * 60 * 1000).toISOString();

    const { data, error } = await db()
      .from('reminders')
      .select('id, text, trigger_at')
      .eq('sent', false)
      .lte('trigger_at', upperBound)
      .gte('trigger_at', lowerBound);

    if (error) throw new Error(error.message);

    const due = data ?? [];
    if (due.length === 0) return Response.json({ ok: true, result: 'nothing due' });

    for (const reminder of due) {
      // Marked sent BEFORE sending. If the send fails we would rather lose
      // one reminder than risk a loop that messages every single minute.
      await db().from('reminders').update({ sent: true }).eq('id', reminder.id);

      await messaging.send(
        `Reminder: ${reminder.text} starts in 5 minutes.`,
        templates.reminderAlert(reminder.text),
      );
      log.info('Reminder fired', { text: reminder.text });
    }

    return Response.json({ ok: true, result: `fired ${due.length}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Reminder job failed', { error: message });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
