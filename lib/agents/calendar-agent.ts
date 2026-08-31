/**
 * Calendar agent: timed reminders and what is coming up.
 *
 * Kept separate from the tasks agent because the two want different
 * things. A task is a thing to do some day; a reminder is a thing at a
 * time. Mixing them made the old classifier guess badly between them.
 */
import { z } from 'zod';
import { upcomingEvents } from '../google/calendar';
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

export const calendarAgent: Agent = {
  name: 'calendar',
  description:
    'Waqt ke reminders lagata hai ("jumeraat 3 baje bank call karna yaad dilana") aur ' +
    'Google Calendar ke aane wale events batata hai.',
  instructions:
    '- Reminder ke liye user ka poora jumla set_reminder ko do.\n' +
    '- Agar waqt bataya hi nahi gaya to reminder mat lagao — user se poocho kab.\n' +
    '- Jo tool bataye wahi waqt user ko batao.',
  tools: [setReminder, whatsComing] as unknown as Tool<never>[],
  maxSteps: 3,
};
