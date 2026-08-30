/**
 * Reminders: "remind me to call the bank Thursday at 3pm".
 *
 * Two halves. The model only ever does the language part — turning vague
 * wording into a date and a title. Everything after that is ordinary code,
 * because a model doing arithmetic on dates is a model getting it wrong.
 */
import { z } from 'zod';
import { completeJson } from '../llm/json';
import { db } from '../supabase';
import { log } from '../logger';
import { TIMEZONE } from '../env';
import { createEvent } from '../google/calendar';

const ReminderSchema = z.object({
  title: z.string().min(1).max(200),
  /** ISO 8601 with the +05:00 offset, e.g. 2026-09-03T15:00:00+05:00 */
  when: z.string().min(10),
});

/** Now, written the way we want the model to answer, so it can copy the shape. */
function nowInKarachi(): { iso: string; human: string } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'long',
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const iso = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00+05:00`;
  return { iso, human: `${get('weekday')} ${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}` };
}

export async function extractReminder(
  text: string,
): Promise<{ title: string; when: Date } | null> {
  const now = nowInKarachi();

  const messages = [
    {
      role: 'system' as const,
      content:
        `You turn a reminder request into a title and an exact time.\n\n` +
        `Right now it is ${now.human} in Asia/Karachi (UTC+5). Current time as ISO: ${now.iso}\n\n` +
        `Reply ONLY with JSON: {"title":"...","when":"YYYY-MM-DDTHH:MM:00+05:00"}\n\n` +
        `Rules:\n` +
        `- "when" must always be in the FUTURE relative to the time above.\n` +
        `- A weekday with no date means the NEXT occurrence of that weekday.\n` +
        `- If no time is given, assume 09:00.\n` +
        `- The title is what to do, without the reminder wording.\n` +
        `- Always use the +05:00 offset.`,
    },
    { role: 'user' as const, content: 'remind me to call the bank on Thursday at 3pm' },
    {
      role: 'assistant' as const,
      content: JSON.stringify({ title: 'Call the bank', when: '2026-09-03T15:00:00+05:00' }),
    },
    { role: 'user' as const, content: 'kal subah 8 baje dawai leni hai yaad dilana' },
    {
      role: 'assistant' as const,
      content: JSON.stringify({ title: 'Take medicine', when: '2026-09-01T08:00:00+05:00' }),
    },
    { role: 'user' as const, content: text },
  ];

  const result = await completeJson(ReminderSchema, messages, { temperature: 0, maxTokens: 300 });
  if (!result.ok) {
    log.warn('Reminder extraction failed', { error: result.error });
    return null;
  }

  const when = new Date(result.data.when);
  if (Number.isNaN(when.getTime())) {
    log.warn('Reminder had an unparseable date', { when: result.data.when });
    return null;
  }

  // The model was told to return a future time; trust but verify.
  if (when.getTime() <= Date.now()) {
    log.warn('Reminder was in the past, rejecting', { when: when.toISOString() });
    return null;
  }

  return { title: result.data.title, when };
}

/**
 * Save a reminder. Tries Google Calendar too, but a missing Google
 * connection must not lose the reminder — the local row is what the
 * reminder job actually reads.
 */
export async function saveReminder(
  title: string,
  when: Date,
): Promise<{ calendarLink: string | null; calendarError: string | null }> {
  let googleEventId: string | null = null;
  let calendarLink: string | null = null;
  let calendarError: string | null = null;

  try {
    const event = await createEvent(title, when);
    googleEventId = event.id;
    calendarLink = event.htmlLink ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    calendarError = message === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : message;
    log.warn('Calendar event not created', { error: message });
  }

  const { error } = await db().from('reminders').insert({
    text: title,
    trigger_at: when.toISOString(),
    google_event_id: googleEventId,
    sent: false,
  });

  if (error) throw new Error(`Could not save reminder: ${error.message}`);

  return { calendarLink, calendarError };
}

/** Format a time the way a person reads it. */
export function humanTime(when: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(when);
}
