/**
 * Calendar agent: timed reminders and what is coming up.
 *
 * Kept separate from the tasks agent because the two want different
 * things. A task is a thing to do some day; a reminder is a thing at a
 * time. Mixing them made the old classifier guess badly between them.
 */
import { z } from 'zod';
import { db } from '../supabase';
import { upcomingEvents, deleteEvent } from '../google/calendar';
import { extractReminder, saveReminder, humanTime } from '../features/reminders';
import type { Agent, Tool } from './types';

const setReminder: Tool<{ text: string }> = {
  name: 'set_reminder',
  description:
    'Kisi khaas waqt ka reminder lagao. User ka poora jumla do — waqt main khud nikaal ' +
    'lunga. Calendar pe event bhi ban jayega.',
  args: 'text: string',
  schema: z.object({ text: z.string().min(3).max(500) }),
  async run({ text }) {
    const parsed = await extractReminder(text);
    if (!parsed) return 'FAIL: waqt samajh nahi aaya. User se poocho kab.';

    const { calendarError } = await saveReminder(parsed.title, parsed.when);

    return (
      `Reminder set: "${parsed.title}" — ${humanTime(parsed.when)}. 5 minute pehle message jayega. ` +
      (calendarError === 'NOT_CONNECTED'
        ? 'Calendar pe NAHI gaya (Google connect nahi).'
        : calendarError
          ? 'Calendar ne reject kar diya.'
          : 'Google Calendar pe bhi laga diya.')
    );
  },
};

const whatsComing: Tool<{ hours: number }> = {
  name: 'upcoming_events',
  description: 'Google Calendar se aane wale events dekho.',
  args: 'hours: number (kitne ghante aage tak dekhna hai)',
  schema: z.object({ hours: z.number().int().min(1).max(720).default(24) }),
  async run({ hours }) {
    const events = await upcomingEvents(hours);
    if (events.length === 0) return `Agle ${hours} ghante mein koi event nahi.`;

    return events
      .map((e) => `• ${e.summary} — ${new Date(e.start).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })}`)
      .join('\n');
  },
};

/**
 * Reminders we set ourselves, which is not the same as calendar events.
 * The bot could list events but had no way to show its own pending
 * reminders, so it correctly said it had no tool for that.
 */
const listReminders: Tool<Record<string, never>> = {
  name: 'list_reminders',
  description:
    'Wo sare reminders dikhao jo abhi tak bheje nahi gaye. Har ek ki id bhi milti hai, ' +
    'jisse use cancel kiya ja sakta hai.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const { data, error } = await db()
      .from('reminders')
      .select('id, text, trigger_at')
      .eq('sent', false)
      .order('trigger_at');

    if (error) return `FAIL: ${error.message}`;
    if (!data || data.length === 0) return 'Koi pending reminder nahi hai.';

    return data
      .map(
        (r) =>
          `id=${r.id} | "${r.text}" — ${new Date(r.trigger_at as string).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })}`,
      )
      .join('\n');
  },
};

const cancelReminder: Tool<{ id: string }> = {
  name: 'cancel_reminder',
  description:
    'Ek reminder cancel karo, us id se jo list_reminders ne di. Google Calendar wala ' +
    'event bhi hat jayega.',
  args: 'id: string',
  schema: z.object({ id: z.string().min(8).max(60) }),
  async run({ id }) {
    const { data, error } = await db()
      .from('reminders')
      .select('text, google_event_id')
      .eq('id', id)
      .maybeSingle();

    if (error) return `FAIL: ${error.message}`;
    if (!data) return `Is id ka koi reminder nahi mila: ${id}`;

    // Calendar first; a leftover event is worse than a leftover row
    // because it is the one the user actually looks at.
    if (data.google_event_id) await deleteEvent(data.google_event_id as string);

    const { error: delError } = await db().from('reminders').delete().eq('id', id);
    if (delError) return `FAIL: ${delError.message}`;

    return `Reminder cancel kar diya: "${data.text}"`;
  },
};

export const calendarAgent: Agent = {
  name: 'calendar',
  description:
    'Waqt ke reminders lagata hai, pehle se lage reminders dikhata aur cancel karta hai, ' +
    'aur Google Calendar ke aane wale events batata hai.',
  instructions:
    '- Reminder ke liye user ka poora jumla set_reminder ko do.\n' +
    '- Agar waqt bataya hi nahi gaya to reminder mat lagao — user se poocho kab.\n' +
    '- Jo tool bataye wahi waqt user ko batao.\n' +
    '- "mere reminders dikhao" = list_reminders. Ye calendar events se alag cheez hai.\n' +
    '- Cancel karne se pehle list_reminders chala kar id lo. Id andaze se mat banao.',
  tools: [setReminder, listReminders, cancelReminder, whatsComing] as unknown as Tool<never>[],
  // list -> cancel -> reply needs three, so allow a little headroom.
  maxSteps: 4,
};
