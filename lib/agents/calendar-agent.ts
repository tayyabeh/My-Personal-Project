/**
 * Calendar agent: timed reminders and what is coming up.
 *
 * Kept separate from the tasks agent because the two want different
 * things. A task is a thing to do some day; a reminder is a thing at a
 * time. Mixing them made the old classifier guess badly between them.
 *
 * Reminders and calendar events are two views of one thing here: setting
 * a reminder writes a row AND an event. So cancelling or rescheduling has
 * to touch both, or the user sees a ghost entry in the app they actually
 * look at — which is exactly what happened when a wrongly-dated birthday
 * could not be removed.
 */
import { z } from 'zod';
import { db } from '../supabase';
import { upcomingEvents, deleteEvent, createEvent } from '../google/calendar';
import { extractReminder, saveReminder, humanTime } from '../features/reminders';
import type { Agent, Tool } from './types';

const setReminder: Tool<{ text: string }> = {
  name: 'set_reminder',
  description:
    'Kisi khaas waqt ka reminder lagao. User ka poora jumla do — waqt main khud nikaal ' +
    'lunga. Calendar pe event bhi ban jayega. Agar waqt na bataya gaya ho to 9 baje ' +
    'subah maan liya jayega, is liye pehle user se waqt poochna behtar hai.',
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

const listReminders: Tool<Record<string, never>> = {
  name: 'list_reminders',
  description:
    'Wo sare reminders dikhao jo abhi tak bheje nahi gaye. Har ek ki id bhi milti hai, ' +
    'jisse use cancel ya reschedule kiya ja sakta hai.',
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
    'event bhi hat jayega. Jab user kahe "ye hata do", "ye cancel karo", "calendar se ' +
    'nikaal do" — tab yahi chalao.',
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

    return `Reminder cancel kar diya aur Calendar se bhi hata diya: "${data.text}"`;
  },
};

/**
 * Change a reminder's time.
 *
 * Recreates the calendar event rather than patching it, because the
 * original may have been rejected or deleted by hand, and PATCHing a
 * missing event fails where creating a new one just works.
 */
const rescheduleReminder: Tool<{ id: string; when: string }> = {
  name: 'reschedule_reminder',
  description:
    'Kisi reminder ka waqt badlo. id list_reminders se lo. when poore jumle mein do, ' +
    'jaise "3 September 2026 raat 11 baje" — waqt main khud nikaal lunga.',
  args: 'id: string, when: string',
  schema: z.object({
    id: z.string().min(8).max(60),
    when: z.string().min(3).max(300),
  }),
  async run({ id, when }) {
    const { data, error } = await db()
      .from('reminders')
      .select('text, google_event_id')
      .eq('id', id)
      .maybeSingle();

    if (error) return `FAIL: ${error.message}`;
    if (!data) return `Is id ka koi reminder nahi mila: ${id}`;

    const parsed = await extractReminder(`${data.text} ${when}`);
    if (!parsed) return `FAIL: "${when}" se waqt samajh nahi aaya.`;

    if (data.google_event_id) await deleteEvent(data.google_event_id as string);

    let eventId: string | null = null;
    try {
      eventId = (await createEvent(data.text as string, parsed.when)).id;
    } catch {
      // The reminder itself still moves; only the calendar copy is lost.
    }

    const { error: updateError } = await db()
      .from('reminders')
      .update({ trigger_at: parsed.when.toISOString(), google_event_id: eventId, sent: false })
      .eq('id', id);

    if (updateError) return `FAIL: ${updateError.message}`;

    return (
      `"${data.text}" ab ${humanTime(parsed.when)} pe hai. ` +
      (eventId ? 'Calendar bhi update ho gaya.' : 'Calendar update nahi ho saka.')
    );
  },
};

const whatsComing: Tool<{ hours: number }> = {
  name: 'upcoming_events',
  description: 'Google Calendar se aane wale events dekho.',
  args: 'hours: number (kitne ghante aage tak dekhna hai)',
  schema: z.object({ hours: z.number().int().min(1).max(2400).default(24) }),
  async run({ hours }) {
    const events = await upcomingEvents(hours);
    if (events.length === 0) return `Agle ${hours} ghante mein koi event nahi.`;

    return events
      .map(
        (e) =>
          `• ${e.summary} — ${new Date(e.start).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })}`,
      )
      .join('\n');
  },
};

export const calendarAgent: Agent = {
  name: 'calendar',
  description:
    'Waqt ke reminders lagata hai, pehle se lage reminders dikhata, cancel karta aur ' +
    'unka waqt badalta hai, aur Google Calendar ke aane wale events batata hai. ' +
    'Calendar se koi cheez hatani ho to bhi yahi.',
  instructions:
    '- Reminder ke liye user ka poora jumla set_reminder ko do.\n' +
    '- Agar waqt bataya hi nahi gaya to reminder mat lagao — user se poocho kab.\n' +
    '- Jo tool bataye wahi waqt user ko batao.\n' +
    '- "mere reminders dikhao" = list_reminders.\n' +
    '- Kuch hatana ya waqt badalna ho to PEHLE list_reminders chala kar sahi id lo, phir ' +
    'cancel_reminder ya reschedule_reminder. Id kabhi andaze se mat banao.\n' +
    '- Jo reminder humne lagaya tha, uska calendar event bhi hum hata sakte hain. Ye mat ' +
    'kaho ke "main calendar se nahi hata sakta" — cancel_reminder dono hata deta hai.\n' +
    '- Agar user pichli baat pe "haan", "ok krdo" kahe, to pichle message mein jo kaam tay ' +
    'hua tha wahi kar do. Dobara mat poocho.',
  tools: [
    setReminder,
    listReminders,
    cancelReminder,
    rescheduleReminder,
    whatsComing,
  ] as unknown as Tool<never>[],
  // list -> cancel/reschedule -> reply, with headroom for a retry.
  maxSteps: 5,
};
