/**
 * Settings: show everything, and change one or more values.
 *
 * Consolidates the old settings agent's seven tools into two generic
 * ones. `update_settings` validates a whitelist of editable keys per-key
 * with the same normalisation the old tools used, then writes once.
 */
import { z } from 'zod';
import { db } from '../supabase';
import { VOICES } from '../tts';
import { insertOnce } from '../db/idempotency';
import { ok, fail, type Tool } from './types';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

const showSettings: Tool<Record<string, never>> = {
  name: 'show_settings',
  description: 'Sare waqt/settings dikhao (morning, night, check-ins, weekly, namaz, awaz).',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const { data, error } = await db()
      .from('settings')
      .select(
        'morning_time, night_time, checkin_times, weekly_time, weekly_dow, resurface_time, namaz_reminders, namaz_minutes_before, tts_voice',
      )
      .eq('id', 1)
      .maybeSingle();

    if (error || !data) return fail('show_settings', `Settings nahi mil sakin (${error?.message ?? 'khali'}).`);

    const checkins = ((data.checkin_times as string[] | null) ?? []).map((t) => t.slice(0, 5));
    const body = [
      `Morning greeting : ${hhmm(data.morning_time)}`,
      `Night summary    : ${hhmm(data.night_time)}`,
      `Check-ins        : ${checkins.join(', ') || 'koi nahi'}`,
      `Learning reminder: ${hhmm(data.resurface_time)}`,
      `Weekly review    : ${DAYS[Number(data.weekly_dow ?? 0)]} ${hhmm(data.weekly_time)}`,
      `Namaz reminders  : ${data.namaz_reminders ? 'on' : 'off'} (${data.namaz_minutes_before} min pehle)`,
      `Awaz             : ${data.tts_voice}`,
    ].join('\n');

    return ok({ tool: 'show_settings', effect: 'read', factLine: body });
  },
};

/** The keys update_settings will touch, each with its own validation. */
type Patch = {
  morning_time?: string;
  night_time?: string;
  weekly_time?: string;
  resurface_time?: string;
  checkin_times?: string[];
  weekly_dow?: number;
  namaz_reminders?: boolean;
  namaz_minutes_before?: number;
  tts_voice?: string;
};

const updateSettings: Tool<Patch> = {
  name: 'update_settings',
  description:
    'Settings badlo. Keys: morning_time/night_time/weekly_time/resurface_time ("HH:MM"), ' +
    'checkin_times (string[], poori nayi list), weekly_dow (0-6), namaz_reminders (bool), ' +
    'namaz_minutes_before (num), tts_voice (' + Object.keys(VOICES).join('/') + ').',
  args: 'koi bhi editable key',
  schema: z.object({
    morning_time: z.string().max(10).optional(),
    night_time: z.string().max(10).optional(),
    weekly_time: z.string().max(10).optional(),
    resurface_time: z.string().max(10).optional(),
    checkin_times: z.array(z.string().min(1).max(10)).max(12).optional(),
    weekly_dow: z.number().int().min(0).max(6).optional(),
    namaz_reminders: z.boolean().optional(),
    namaz_minutes_before: z.number().int().min(1).max(120).optional(),
    tts_voice: z.string().min(2).max(20).optional(),
  }),
  async run(patch, ctx) {
    const update: Record<string, unknown> = {};
    const changed: string[] = [];

    for (const key of ['morning_time', 'night_time', 'weekly_time', 'resurface_time'] as const) {
      if (patch[key] !== undefined) {
        const t = normaliseTime(patch[key]!);
        if (!t) return fail('update_settings', `"${patch[key]}" (${key}) samajh nahi aaya. 24-hour do, jaise 22:30.`);
        update[key] = t;
        changed.push(`${key}=${t}`);
      }
    }

    if (patch.checkin_times !== undefined) {
      const cleaned = patch.checkin_times.map(normaliseTime).filter((t): t is string => t !== null);
      if (cleaned.length !== patch.checkin_times.length) {
        return fail('update_settings', `Kuch check-in waqt samajh nahi aaye: ${patch.checkin_times.join(', ')}`);
      }
      update.checkin_times = cleaned;
      changed.push(`checkin_times=[${cleaned.join(',')}]`);
    }

    if (patch.weekly_dow !== undefined) {
      update.weekly_dow = patch.weekly_dow;
      changed.push(`weekly_dow=${DAYS[patch.weekly_dow]}`);
    }
    if (patch.namaz_reminders !== undefined) {
      update.namaz_reminders = patch.namaz_reminders;
      changed.push(`namaz_reminders=${patch.namaz_reminders ? 'on' : 'off'}`);
    }
    if (patch.namaz_minutes_before !== undefined) {
      update.namaz_minutes_before = patch.namaz_minutes_before;
      changed.push(`namaz_minutes_before=${patch.namaz_minutes_before}`);
    }
    if (patch.tts_voice !== undefined) {
      const v = patch.tts_voice.trim().toLowerCase();
      if (!(v in VOICES)) return fail('update_settings', `Awaz "${patch.tts_voice}" available nahi. Ye hain: ${Object.keys(VOICES).join(', ')}.`);
      update.tts_voice = v;
      changed.push(`tts_voice=${v}`);
    }

    if (changed.length === 0) return fail('update_settings', 'Koi valid setting nahi di gayi.');

    const { ok: done } = await insertOnce(
      `${ctx.runId}:update_settings:${changed.join('|')}`,
      { runId: ctx.runId, tool: 'update_settings', effect: 'write' },
      async () => {
        update.updated_at = new Date().toISOString();
        const { error } = await db().from('settings').update(update).eq('id', 1);
        return error ? { ok: false, result: null, error: error.message } : { ok: true, result: { changed } };
      },
    );

    return done
      ? ok({
          tool: 'update_settings',
          effect: 'write',
          factLine: `Badal diya: ${changed.join(', ')}. Agle 5 minute mein lag jayega.`,
          entities: changed,
        })
      : fail('update_settings', 'Settings save nahi ho sakin.');
  },
};

export const settingsTools: Tool<any>[] = [showSettings, updateSettings];
