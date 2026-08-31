/**
 * Calendar tools for events the assistant did not create.
 *
 * The reminder tools only ever knew about rows in our own table, so
 * anything Tayyab added in the Google Calendar app was invisible: it
 * could not be found, edited, or removed. These close that gap by going
 * through the calendar itself rather than our database.
 */
import { z } from 'zod';
import { findEvents, updateEvent, deleteEvent } from '../google/calendar';
import { extractReminder } from '../features/reminders';
import { TIMEZONE } from '../env';
import { scheduleTodaysPrayers, prayerTimesMessage } from '../features/prayer';
import type { Tool } from './types';

function when(iso: string): string {
  if (!iso) return 'waqt nahi';
  // All-day events are a bare date; showing 00:00 for them would mislead.
  if (!iso.includes('T')) return `${iso} (poora din)`;
  return new Date(iso).toLocaleString('en-GB', { timeZone: TIMEZONE });
}

export const findCalendarEvents: Tool<{ query: string }> = {
  name: 'find_calendar_events',
  description:
    'Google Calendar mein kisi bhi event ko naam se dhoondo — chahe wo humne banaya ho ya ' +
    'Tayyab ne khud app mein. Har event ki id milti hai, jisse use badla ya hataya ja sakta hai.',
  args: 'query: string (event ke naam ka koi hissa)',
  schema: z.object({ query: z.string().min(1).max(120) }),
  async run({ query }) {
    const events = await findEvents(query);
    if (events.length === 0) return `Calendar mein "${query}" se koi event nahi mila.`;

    return events
      .map((e) => `id=${e.id} | "${e.summary}" — ${when(e.start)}`)
      .join('\n');
  },
};

export const editCalendarEvent: Tool<{ id: string; title?: string; whenText?: string }> = {
  name: 'edit_calendar_event',
  description:
    'Kisi calendar event ka naam ya waqt badlo. id find_calendar_events se lo. ' +
    'Sirf wahi cheez do jo badalni hai — baaki waise hi rahegi.',
  args: 'id: string, title?: string, whenText?: string (jaise "5 September shaam 6 baje")',
  schema: z.object({
    id: z.string().min(5).max(120),
    title: z.string().min(1).max(200).optional(),
    whenText: z.string().min(2).max(200).optional(),
  }),
  async run({ id, title, whenText }) {
    if (!title && !whenText) return 'FAIL: kya badalna hai? naam ya waqt, kuch to do.';

    let startsAt: Date | undefined;
    if (whenText) {
      const parsed = await extractReminder(`${title ?? 'event'} ${whenText}`);
      if (!parsed) return `FAIL: "${whenText}" se waqt samajh nahi aaya.`;
      startsAt = parsed.when;
    }

    const ok = await updateEvent(id, { title, startsAt });
    if (!ok) return `FAIL: event update nahi hua (id ${id}).`;

    return (
      'Event update ho gaya' +
      (title ? `, naya naam "${title}"` : '') +
      (startsAt ? `, naya waqt ${startsAt.toLocaleString('en-GB', { timeZone: TIMEZONE })}` : '') +
      '.'
    );
  },
};

export const removeCalendarEvent: Tool<{ id: string }> = {
  name: 'delete_calendar_event',
  description:
    'Google Calendar se koi bhi event hata do, us id se jo find_calendar_events ne di. ' +
    'Ye wo events bhi hata sakta hai jo Tayyab ne khud banaye the.',
  args: 'id: string',
  schema: z.object({ id: z.string().min(5).max(120) }),
  async run({ id }) {
    await deleteEvent(id);
    return `Calendar se event hata diya (id ${id}).`;
  },
};

/**
 * Namaz times, and the reminders for them.
 *
 * Lives with the calendar tools because it is the same job: something
 * happens at a time, and Tayyab wants warning before it.
 */
export const namazTimes: Tool<Record<string, never>> = {
  name: 'namaz_times',
  description:
    'Aaj ki namaz timings batao (Karachi ke hisab se) aur 15 minute pehle ke reminders laga do. ' +
    'Jab user namaz ke waqt poochhe ya reminder maange, tab chalao.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const scheduled = await scheduleTodaysPrayers();
    const times = await prayerTimesMessage();
    return `${times}\n\n(${scheduled})`;
  },
};
