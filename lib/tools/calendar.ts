/**
 * Calendar: timed reminders, calendar events, and namaz.
 *
 * Reminders and calendar events are two views of one thing — setting a
 * reminder writes a row AND an event, so cancelling or rescheduling has
 * to touch both or the user sees a ghost entry in the app they look at.
 */
import { z } from 'zod';
import { db } from '../supabase';
import { TIMEZONE } from '../env';
import {
  upcomingEvents,
  findEvents,
  createEvent,
  updateEvent,
  deleteEvent,
} from '../google/calendar';
import { extractReminder, saveReminder, humanTime } from '../features/reminders';
import {
  scheduleTodaysPrayers,
  prayerTimesMessage,
  saveCustomPrayerTimes,
  clearCustomPrayerTimes,
} from '../features/prayer';
import { insertOnce } from '../db/idempotency';
import { ok, fail, type Tool } from './types';

function whenText(iso: string): string {
  if (!iso) return 'waqt nahi';
  if (!iso.includes('T')) return `${iso} (poora din)`;
  return new Date(iso).toLocaleString('en-GB', { timeZone: TIMEZONE });
}

const upcoming: Tool<{ hours: number }> = {
  name: 'upcoming_events',
  description: 'Aane wale calendar events (hours aage tak).',
  args: 'hours: number',
  schema: z.object({ hours: z.number().int().min(1).max(2400).default(24) }),
  async run({ hours }, ctx) {
    const events = await upcomingEvents(hours, ctx.signal);
    if (events.length === 0) {
      return ok({ tool: 'upcoming_events', effect: 'read', factLine: `Agle ${hours} ghante mein koi event nahi.`, numbers: [hours, 0] });
    }
    const lines = events.map(
      (e) => `• ${e.summary} — ${new Date(e.start).toLocaleString('en-GB', { timeZone: TIMEZONE })}`,
    );
    return ok({
      tool: 'upcoming_events',
      effect: 'read',
      factLine: `Agle ${hours} ghante mein ${events.length} event.`,
      numbers: [hours, events.length],
      entities: events.map((e) => e.summary),
      observation: lines.join('\n'),
    });
  },
};

const findCalendarEvents: Tool<{ query: string }> = {
  name: 'find_events',
  description: 'Calendar event naam se dhoondo (id ke saath).',
  args: 'query: string',
  schema: z.object({ query: z.string().min(1).max(120) }),
  async run({ query }, ctx) {
    const events = await findEvents(query, 120, 7, ctx.signal);
    if (events.length === 0) {
      return ok({ tool: 'find_events', effect: 'read', factLine: `Calendar mein "${query}" se koi event nahi mila.` });
    }
    return ok({
      tool: 'find_events',
      effect: 'read',
      factLine: `${events.length} event mile.`,
      numbers: [events.length],
      entities: events.map((e) => e.summary),
      observation: events.map((e) => `id=${e.id} | "${e.summary}" — ${whenText(e.start)}`).join('\n'),
    });
  },
};

const createCalendarEvent: Tool<{ title: string; whenText: string; durationMinutes?: number }> = {
  name: 'create_event',
  description: 'Naya calendar event banao (title + whenText jumla).',
  args: 'title: string, whenText: string, durationMinutes?: number',
  schema: z.object({
    title: z.string().min(1).max(200),
    whenText: z.string().min(2).max(300),
    durationMinutes: z.number().int().min(5).max(600).optional(),
  }),
  async run({ title, whenText: when, durationMinutes }, ctx) {
    const parsed = await extractReminder(`${title} ${when}`);
    if (!parsed) return fail('create_event', `"${when}" se waqt samajh nahi aaya.`);

    const { ok: done, result } = await insertOnce(
      `${ctx.runId}:create_event:${title}:${parsed.when.toISOString()}`,
      { runId: ctx.runId, tool: 'create_event', effect: 'write' },
      async () => {
        const event = await createEvent(title, parsed.when, durationMinutes ?? 30, ctx.signal);
        return { ok: true, result: { id: event.id, link: event.htmlLink }, target: event.id };
      },
    );

    if (!done) return fail('create_event', 'Event ban nahi saka.');
    return ok({
      tool: 'create_event',
      effect: 'write',
      factLine: `Event ban gaya: "${title}" — ${humanTime(parsed.when)}.`,
      entities: [title],
      observation: (result as { link?: string })?.link ?? '',
    });
  },
};

const updateCalendarEvent: Tool<{ id: string; title?: string; whenText?: string }> = {
  name: 'update_event',
  description: 'Event ka naam/waqt badlo (id find_events se, sirf jo badalna hai).',
  args: 'id: string, title?: string, whenText?: string',
  schema: z.object({
    id: z.string().min(5).max(120),
    title: z.string().min(1).max(200).optional(),
    whenText: z.string().min(2).max(200).optional(),
  }),
  async run({ id, title, whenText: when }, ctx) {
    if (!title && !when) return fail('update_event', 'Kya badalna hai? naam ya waqt, kuch to do.');

    let startsAt: Date | undefined;
    if (when) {
      const parsed = await extractReminder(`${title ?? 'event'} ${when}`);
      if (!parsed) return fail('update_event', `"${when}" se waqt samajh nahi aaya.`);
      startsAt = parsed.when;
    }

    const { ok: done } = await insertOnce(
      `${ctx.runId}:update_event:${id}:${title ?? ''}:${startsAt?.toISOString() ?? ''}`,
      { runId: ctx.runId, tool: 'update_event', effect: 'write', target: id },
      async () => {
        const updated = await updateEvent(id, { title, startsAt }, ctx.signal);
        return { ok: updated, result: { id }, error: updated ? undefined : 'update returned false' };
      },
    );

    if (!done) return fail('update_event', `Event update nahi hua (id ${id}).`);
    return ok({
      tool: 'update_event',
      effect: 'write',
      factLine:
        'Event update ho gaya' +
        (title ? `, naya naam "${title}"` : '') +
        (startsAt ? `, naya waqt ${startsAt.toLocaleString('en-GB', { timeZone: TIMEZONE })}` : '') +
        '.',
      entities: title ? [title] : [],
    });
  },
};

const deleteCalendarEvent: Tool<{ id: string }> = {
  name: 'delete_event',
  description: 'Calendar event hatao (id find_events se).',
  args: 'id: string',
  schema: z.object({ id: z.string().min(5).max(120) }),
  async run({ id }, ctx) {
    // deleteEvent never throws and returns void, so confirm the delete by
    // checking the event is actually gone afterwards.
    const { ok: done } = await insertOnce(
      `${ctx.runId}:delete_event:${id}`,
      { runId: ctx.runId, tool: 'delete_event', effect: 'write', target: id },
      async () => {
        await deleteEvent(id, ctx.signal);
        const still = await findEvents(id, 400, 400, ctx.signal).catch(() => []);
        const gone = !still.some((e) => e.id === id);
        return { ok: gone, result: { id }, error: gone ? undefined : 'event still present after delete' };
      },
    );

    return done
      ? ok({ tool: 'delete_event', effect: 'write', factLine: `Calendar se event hata diya (id ${id}).`, entities: [id] })
      : fail('delete_event', `Event hataya nahi ja saka (id ${id}).`);
  },
};

const setReminder: Tool<{ text: string }> = {
  name: 'set_reminder',
  description: 'Waqt ka reminder lagao (poora jumla). Calendar event bhi banega. Waqt na ho to poocho.',
  args: 'text: string',
  schema: z.object({ text: z.string().min(3).max(500) }),
  async run({ text }, ctx) {
    const parsed = await extractReminder(text);
    if (!parsed) return fail('set_reminder', 'Waqt samajh nahi aaya. User se poocho kab.');

    const { ok: done, result } = await insertOnce(
      `${ctx.runId}:set_reminder:${parsed.title}:${parsed.when.toISOString()}`,
      { runId: ctx.runId, tool: 'set_reminder', effect: 'write' },
      async () => {
        const saved = await saveReminder(parsed.title, parsed.when);
        return { ok: true, result: saved };
      },
    );

    if (!done) return fail('set_reminder', 'Reminder save nahi ho saka.');
    const calendarError = (result as { calendarError: string | null })?.calendarError;
    return ok({
      tool: 'set_reminder',
      effect: 'write',
      factLine:
        `Reminder set: "${parsed.title}" — ${humanTime(parsed.when)}. 5 minute pehle message jayega. ` +
        (calendarError === 'NOT_CONNECTED'
          ? 'Calendar pe nahi gaya (Google connect nahi).'
          : calendarError
            ? 'Calendar ne reject kar diya.'
            : 'Google Calendar pe bhi laga diya.'),
      entities: [parsed.title],
    });
  },
};

const listReminders: Tool<Record<string, never>> = {
  name: 'list_reminders',
  description: 'Pending reminders + id dikhao.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const { data, error } = await db()
      .from('reminders')
      .select('id, text, trigger_at')
      .eq('sent', false)
      .order('trigger_at');

    if (error) return fail('list_reminders', error.message);
    if (!data || data.length === 0) {
      return ok({ tool: 'list_reminders', effect: 'read', factLine: 'Koi pending reminder nahi hai.', numbers: [0] });
    }
    return ok({
      tool: 'list_reminders',
      effect: 'read',
      factLine: `${data.length} pending reminder.`,
      numbers: [data.length],
      observation: data
        .map((r) => `id=${r.id} | "${r.text}" — ${new Date(r.trigger_at as string).toLocaleString('en-GB', { timeZone: TIMEZONE })}`)
        .join('\n'),
    });
  },
};

const cancelReminder: Tool<{ id: string }> = {
  name: 'cancel_reminder',
  description: 'Reminder cancel karo (id list_reminders se). Calendar event bhi hatega.',
  args: 'id: string',
  schema: z.object({ id: z.string().min(8).max(60) }),
  async run({ id }, ctx) {
    const { data, error } = await db()
      .from('reminders')
      .select('text, google_event_id')
      .eq('id', id)
      .maybeSingle();

    if (error) return fail('cancel_reminder', error.message);
    if (!data) return fail('cancel_reminder', `Is id ka koi reminder nahi mila: ${id}`);

    const { ok: done } = await insertOnce(
      `${ctx.runId}:cancel_reminder:${id}`,
      { runId: ctx.runId, tool: 'cancel_reminder', effect: 'write', target: id },
      async () => {
        if (data.google_event_id) await deleteEvent(data.google_event_id as string, ctx.signal);
        const { error: delError } = await db().from('reminders').delete().eq('id', id);
        return delError ? { ok: false, result: null, error: delError.message } : { ok: true, result: { id } };
      },
    );

    return done
      ? ok({ tool: 'cancel_reminder', effect: 'write', factLine: `Reminder cancel kar diya aur Calendar se bhi hata diya: "${data.text}"`, entities: [String(data.text)] })
      : fail('cancel_reminder', 'Cancel nahi ho saka.');
  },
};

const rescheduleReminder: Tool<{ id: string; when: string }> = {
  name: 'reschedule_reminder',
  description: 'Reminder ka waqt badlo (id + naya waqt jumle mein).',
  args: 'id: string, when: string',
  schema: z.object({ id: z.string().min(8).max(60), when: z.string().min(3).max(300) }),
  async run({ id, when }, ctx) {
    const { data, error } = await db()
      .from('reminders')
      .select('text, google_event_id')
      .eq('id', id)
      .maybeSingle();

    if (error) return fail('reschedule_reminder', error.message);
    if (!data) return fail('reschedule_reminder', `Is id ka koi reminder nahi mila: ${id}`);

    const parsed = await extractReminder(`${data.text} ${when}`);
    if (!parsed) return fail('reschedule_reminder', `"${when}" se waqt samajh nahi aaya.`);

    const { ok: done, result } = await insertOnce(
      `${ctx.runId}:reschedule_reminder:${id}:${parsed.when.toISOString()}`,
      { runId: ctx.runId, tool: 'reschedule_reminder', effect: 'write', target: id },
      async () => {
        if (data.google_event_id) await deleteEvent(data.google_event_id as string, ctx.signal);
        let eventId: string | null = null;
        try {
          eventId = (await createEvent(data.text as string, parsed.when, 30, ctx.signal)).id;
        } catch {
          // reminder still moves; only the calendar copy is lost
        }
        const { error: updateError } = await db()
          .from('reminders')
          .update({ trigger_at: parsed.when.toISOString(), google_event_id: eventId, sent: false })
          .eq('id', id);
        return updateError
          ? { ok: false, result: null, error: updateError.message }
          : { ok: true, result: { onCalendar: Boolean(eventId) } };
      },
    );

    if (!done) return fail('reschedule_reminder', 'Waqt badal nahi saka.');
    const onCalendar = (result as { onCalendar: boolean })?.onCalendar;
    return ok({
      tool: 'reschedule_reminder',
      effect: 'write',
      factLine: `"${data.text}" ab ${humanTime(parsed.when)} pe hai. ` + (onCalendar ? 'Calendar bhi update ho gaya.' : 'Calendar update nahi ho saka.'),
      entities: [String(data.text)],
    });
  },
};

const namazTimes: Tool<Record<string, never>> = {
  name: 'namaz_times',
  description: 'Aaj ki namaz timings + reminders laga do.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run(_args, ctx) {
    const scheduled = await insertOnce(
      `${ctx.runId}:namaz_times`,
      { runId: ctx.runId, tool: 'namaz_times', effect: 'write' },
      async () => {
        const msg = await scheduleTodaysPrayers();
        return { ok: !msg.startsWith('FAIL'), result: { msg } };
      },
    );
    const times = await prayerTimesMessage();
    const scheduledMsg = (scheduled.result as { msg: string })?.msg ?? '';
    return ok({
      tool: 'namaz_times',
      effect: scheduled.ok ? 'write' : 'read',
      factLine: times,
      observation: `${times}\n\n(${scheduledMsg})`,
    });
  },
};

const setNamazTimes: Tool<{
  Fajr?: string;
  Dhuhr?: string;
  Asr?: string;
  Maghrib?: string;
  Isha?: string;
  clear?: boolean;
}> = {
  name: 'set_namaz_times',
  description: 'Apni jamaat timings set karo (HH:MM, 24-hour: Asr 5=17:00). clear:true = calculated pe wapas.',
  args: 'Fajr?/Dhuhr?/Asr?/Maghrib?/Isha? "HH:MM"; ya clear:true',
  schema: z.object({
    Fajr: z.string().max(8).optional(),
    Dhuhr: z.string().max(8).optional(),
    Asr: z.string().max(8).optional(),
    Maghrib: z.string().max(8).optional(),
    Isha: z.string().max(8).optional(),
    clear: z.boolean().optional(),
  }),
  async run({ clear, ...times }, ctx) {
    const key = clear ? `${ctx.runId}:set_namaz_times:clear` : `${ctx.runId}:set_namaz_times:${JSON.stringify(times)}`;
    const { ok: done, result } = await insertOnce(
      key,
      { runId: ctx.runId, tool: 'set_namaz_times', effect: 'write' },
      async () => {
        const msg = clear ? await clearCustomPrayerTimes() : await saveCustomPrayerTimes(times as Record<string, string>);
        if (msg.startsWith('FAIL')) return { ok: false, result: { msg }, error: msg };
        const rescheduled = await scheduleTodaysPrayers();
        return { ok: true, result: { msg: `${msg}\n\n(${rescheduled})` } };
      },
    );

    const msg = (result as { msg: string })?.msg ?? '';
    return done
      ? ok({ tool: 'set_namaz_times', effect: 'write', factLine: msg })
      : fail('set_namaz_times', msg || 'Timings save nahi ho sakin.');
  },
};

export const calendarTools: Tool<any>[] = [
  upcoming,
  findCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  setReminder,
  listReminders,
  cancelReminder,
  rescheduleReminder,
  namazTimes,
  setNamazTimes,
];
