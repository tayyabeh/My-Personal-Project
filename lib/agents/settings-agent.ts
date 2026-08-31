/**
 * Settings agent: change the schedule from WhatsApp.
 *
 * The dashboard at /dashboard/settings already edits these, but that
 * means opening a browser to move the morning message by an hour. Both
 * routes now write to the same `settings` row, and the scheduler tick
 * reads it every 5 minutes, so a change made either way takes effect
 * within 5 minutes with nothing to redeploy.
 */
import { z } from 'zod';
import { db } from '../supabase';
import type { Agent, Tool } from './types';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Which settings column each spoken name maps to. */
const SLOTS = {
  morning: 'morning_time',
  night: 'night_time',
  weekly: 'weekly_time',
  learning: 'resurface_time',
} as const;

type SlotName = keyof typeof SLOTS;

/** Accepts "9", "9:5", "21:30". Returns "HH:MM" or null. */
function normaliseTime(value: string): string | null {
  const match = /^(\d{1,2})\s*[:.]?\s*(\d{1,2})?$/.exec(String(value).trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2] ?? '0');
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function hhmm(value: unknown): string {
  const text = String(value ?? '');
  return /^\d{2}:\d{2}/.test(text) ? text.slice(0, 5) : text;
}

const showSchedule: Tool<Record<string, never>> = {
  name: 'show_schedule',
  description: 'Abhi ke sare waqt dikhao: morning, night, check-ins, weekly review, learning.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const { data, error } = await db()
      .from('settings')
      .select('morning_time, night_time, checkin_times, weekly_time, weekly_dow, resurface_time')
      .eq('id', 1)
      .maybeSingle();

    if (error || !data) return `FAIL: settings nahi mil sakin (${error?.message ?? 'khali'})`;

    const checkins = ((data.checkin_times as string[] | null) ?? []).map((t) => t.slice(0, 5));

    return [
      `Morning greeting : ${hhmm(data.morning_time)}`,
      `Night summary    : ${hhmm(data.night_time)}`,
      `Check-ins        : ${checkins.join(', ') || 'koi nahi'}`,
      `Learning reminder: ${hhmm(data.resurface_time)}`,
      `Weekly review    : ${DAYS[Number(data.weekly_dow ?? 0)]} ${hhmm(data.weekly_time)}`,
    ].join('\n');
  },
};

const setTime: Tool<{ which: SlotName; time: string }> = {
  name: 'set_time',
  description:
    'Kisi ek cheez ka waqt badlo. which: morning | night | weekly | learning. ' +
    'time 24-hour mein, jaise "10:00" ya "22:30".',
  args: 'which: "morning"|"night"|"weekly"|"learning", time: string',
  schema: z.object({
    which: z.enum(['morning', 'night', 'weekly', 'learning']),
    time: z.string().min(1).max(10),
  }),
  async run({ which, time }) {
    const normalised = normaliseTime(time);
    if (!normalised) return `FAIL: "${time}" samajh nahi aaya. 24-hour format do, jaise 22:30.`;

    const { error } = await db()
      .from('settings')
      .update({ [SLOTS[which]]: normalised, updated_at: new Date().toISOString() })
      .eq('id', 1);

    if (error) return `FAIL: ${error.message}`;
    return `${which} ka waqt ${normalised} kar diya. Agle 5 minute mein lag jayega.`;
  },
};

const setCheckins: Tool<{ times: string[] }> = {
  name: 'set_checkins',
  description:
    'Din bhar ke check-in waqt badlo. Poori nayi list do — ye purani list ko badal deti hai, ' +
    'usme jorti nahi. Khali list dene se check-ins band ho jayenge.',
  args: 'times: string[]  (jaise ["13:00","17:00","21:00"])',
  schema: z.object({ times: z.array(z.string().min(1).max(10)).max(12) }),
  async run({ times }) {
    const cleaned = times.map(normaliseTime).filter((t): t is string => t !== null);

    if (cleaned.length !== times.length) {
      return `FAIL: kuch waqt samajh nahi aaye. Diye the: ${times.join(', ')}`;
    }

    const { error } = await db()
      .from('settings')
      .update({ checkin_times: cleaned, updated_at: new Date().toISOString() })
      .eq('id', 1);

    if (error) return `FAIL: ${error.message}`;

    return cleaned.length === 0
      ? 'Check-ins band kar diye.'
      : `Check-ins ab ye hain: ${cleaned.join(', ')}. Agle 5 minute mein lag jayenge.`;
  },
};

const setWeeklyDay: Tool<{ day: number }> = {
  name: 'set_weekly_day',
  description: 'Weekly review ka din badlo. 0 = Sunday, 1 = Monday, ... 6 = Saturday.',
  args: 'day: number (0-6)',
  schema: z.object({ day: z.number().int().min(0).max(6) }),
  async run({ day }) {
    const { error } = await db()
      .from('settings')
      .update({ weekly_dow: day, updated_at: new Date().toISOString() })
      .eq('id', 1);

    if (error) return `FAIL: ${error.message}`;
    return `Weekly review ab ${DAYS[day]} ko hoga.`;
  },
};

export const settingsAgent: Agent = {
  name: 'settings',
  description:
    'Messages ke waqt badalta hai: morning greeting, night summary, din ke check-ins, ' +
    'weekly review ka din aur waqt, learning reminder. Waqt dikhata bhi hai.',
  instructions:
    '- Waqt badalne se pehle agar shak ho to show_schedule chala kar dekh lo abhi kya hai.\n' +
    '- "subah ka message 11 baje kar do" = set_time(morning, "11:00").\n' +
    '- Check-ins ki poori nayi list deni hoti hai, ek waqt jorna nahi hota. Agar user ek ' +
    'waqt jorna chahta hai to pehle show_schedule se purani list lo, usme jodo, phir set karo.\n' +
    '- Jo tool bataye wahi user ko batao. Waqt badla hai ye tab kaho jab tool ne haan kaha ho.',
  tools: [showSchedule, setTime, setCheckins, setWeeklyDay] as unknown as Tool<never>[],
  maxSteps: 4,
};
