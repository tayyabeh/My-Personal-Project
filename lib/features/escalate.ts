/**
 * Escalating reminders.
 *
 * If a reminder fired and you never said anything afterwards, it follows
 * up. At most twice, then it stops permanently — a third nudge about the
 * same thing is nagging, and a bot that nags gets muted.
 *
 * "No response" means no inbound message of any kind since the reminder
 * fired. Replying about something else still counts: you saw your phone,
 * so the reminder did its job.
 */
import { db } from '../supabase';
import { messaging, templates } from '../messaging';
import { log } from '../logger';

const MAX_FOLLOWUPS = 2;
const GAP_MINUTES = 25;

export async function escalateUnanswered(): Promise<string> {
  const now = Date.now();

  const { data, error } = await db()
    .from('reminders')
    .select('id, text, trigger_at, followup_count, last_nudged_at')
    .eq('sent', true)
    .lt('followup_count', MAX_FOLLOWUPS)
    // Only look at the last day; older ones are long past caring about.
    .gte('trigger_at', new Date(now - 24 * 60 * 60 * 1000).toISOString());

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return 'nothing to escalate';

  let sent = 0;

  for (const reminder of data) {
    const firedAt = new Date(reminder.trigger_at as string).getTime();
    const lastTouch = reminder.last_nudged_at
      ? new Date(reminder.last_nudged_at as string).getTime()
      : firedAt;

    if (now - lastTouch < GAP_MINUTES * 60 * 1000) continue;

    // Did they say anything at all since the reminder fired?
    const { data: replies } = await db()
      .from('messages')
      .select('id')
      .eq('direction', 'inbound')
      .gte('created_at', new Date(firedAt).toISOString())
      .limit(1);

    if (replies && replies.length > 0) {
      // They responded. Stop following up on this one for good.
      await db().from('reminders').update({ followup_count: MAX_FOLLOWUPS }).eq('id', reminder.id);
      continue;
    }

    const attempt = (reminder.followup_count ?? 0) + 1;
    const isLast = attempt >= MAX_FOLLOWUPS;

    await messaging.send(
      isLast
        ? `Last nudge on this: ${reminder.text}. I won't ask again.`
        : `Still waiting on this one: ${reminder.text}.`,
      templates.reminderAlert(reminder.text),
    );

    await db()
      .from('reminders')
      .update({ followup_count: attempt, last_nudged_at: new Date().toISOString() })
      .eq('id', reminder.id);

    log.info('Reminder escalated', { text: reminder.text, attempt });
    sent++;
  }

  return sent === 0 ? 'nothing due to escalate' : `escalated ${sent}`;
}
