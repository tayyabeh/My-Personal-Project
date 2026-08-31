/**
 * Namaz times for Karachi, and reminders 15 minutes before each.
 *
 * Times come from the Aladhan API, which is free and needs no key. The
 * calculation method is set to 1 — "University of Islamic Sciences,
 * Karachi" — which is the standard used locally, so the times match what
 * mosques in the city actually follow.
 *
 * Reminders are written as ordinary rows in the reminders table, so the
 * existing every-minute job delivers them. Nothing new had to be built
 * for the sending side.
 */
import { db } from '../supabase';
import { log } from '../logger';
import { TIMEZONE } from '../env';

/** Gohar Green City, Karachi. */
const LATITUDE = 24.9056;
const LONGITUDE = 67.1861;

/** University of Islamic Sciences, Karachi. */
const METHOD = 1;

/** Default warning window; the stored setting wins when present. */
const DEFAULT_MINUTES_BEFORE = 15;

/** Whether reminders are wanted, and how much warning. From settings. */
async function prayerSettings(): Promise<{ on: boolean; minutesBefore: number }> {
  const { data } = await db()
    .from('settings')
    .select('namaz_reminders, namaz_minutes_before')
    .eq('id', 1)
    .maybeSingle();

  return {
    on: data?.namaz_reminders ?? true,
    minutesBefore: Number(data?.namaz_minutes_before ?? DEFAULT_MINUTES_BEFORE),
  };
}

/** The five daily prayers, in order. Sunrise and midnight are not prayers. */
const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'] as const;

export interface PrayerTime {
  name: string;
  /** "HH:MM" in Karachi time. */
  at: string;
}

/**
 * Timings Tayyab has set himself, if any.
 *
 * These win over the API. Aladhan returns azan times calculated from the
 * sun; his mosque holds jamaat later — often by 20 to 40 minutes — and
 * jamaat is the time he actually has to be there. A calculated time that
 * is right in principle and wrong in practice is worse than useless.
 */
export async function customPrayerTimes(): Promise<PrayerTime[] | null> {
  const { data } = await db().from('settings').select('prayer_times').eq('id', 1).maybeSingle();
  const stored = data?.prayer_times as Record<string, string> | null | undefined;
  if (!stored) return null;

  const times = PRAYERS.map((name) => ({ name, at: (stored[name] ?? '').trim() })).filter((p) =>
    /^\d{2}:\d{2}$/.test(p.at),
  );

  return times.length > 0 ? times : null;
}

/** His own times when set, otherwise the calculated ones. */
export async function fetchPrayerTimes(): Promise<PrayerTime[]> {
  const own = await customPrayerTimes();
  if (own) return own;

  const url =
    `https://api.aladhan.com/v1/timings?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&method=${METHOD}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Prayer times unavailable (HTTP ${response.status})`);

  const json = (await response.json()) as { data?: { timings?: Record<string, string> } };
  const timings = json.data?.timings;
  if (!timings) throw new Error('Prayer times response had no timings');

  return PRAYERS.map((name) => ({
    name,
    // Aladhan sometimes appends a timezone note, e.g. "04:53 (PKT)".
    at: (timings[name] ?? '').trim().split(' ')[0],
  })).filter((p) => /^\d{2}:\d{2}$/.test(p.at));
}

/** Today's date in Karachi, as YYYY-MM-DD. */
function todayInKarachi(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

/**
 * Build a real Date for a Karachi wall-clock time today.
 *
 * Karachi is UTC+5 with no daylight saving, so the offset can be written
 * directly and there is no need for a timezone library.
 */
function karachiTime(hhmm: string): Date {
  return new Date(`${todayInKarachi()}T${hhmm}:00+05:00`);
}

/**
 * Create today's namaz reminders, 15 minutes before each prayer.
 *
 * Skips prayers already past, and skips any that are already scheduled —
 * so running this twice in a day cannot produce duplicates.
 */
export async function scheduleTodaysPrayers(): Promise<string> {
  const settings = await prayerSettings();
  if (!settings.on) return 'namaz reminders are switched off';

  let prayers: PrayerTime[];
  try {
    prayers = await fetchPrayerTimes();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Could not fetch prayer times', { error: message });
    return `FAIL: ${message}`;
  }

  const dayStart = `${todayInKarachi()}T00:00:00+05:00`;
  const dayEnd = `${todayInKarachi()}T23:59:59+05:00`;

  const { data: existing } = await db()
    .from('reminders')
    .select('text')
    .gte('trigger_at', new Date(dayStart).toISOString())
    .lte('trigger_at', new Date(dayEnd).toISOString());

  const alreadyThere = new Set((existing ?? []).map((r) => String(r.text)));

  const rows: Array<{ text: string; trigger_at: string; sent: boolean }> = [];
  const now = Date.now();

  for (const prayer of prayers) {
    const prayerAt = karachiTime(prayer.at);
    const remindAt = new Date(prayerAt.getTime() - settings.minutesBefore * 60_000);

    // A reminder for a prayer that has already passed is just noise.
    if (remindAt.getTime() <= now) continue;

    const text = `${prayer.name} ki namaz — ${prayer.at}`;
    if (alreadyThere.has(text)) continue;

    rows.push({ text, trigger_at: remindAt.toISOString(), sent: false });
  }

  if (rows.length === 0) return 'no new prayer reminders needed';

  const { error } = await db().from('reminders').insert(rows);
  if (error) return `FAIL: ${error.message}`;

  log.info('Prayer reminders scheduled', { count: rows.length });
  return `${rows.length} namaz reminders set: ${rows.map((r) => r.text).join(', ')}`;
}

/** Today's times, formatted for a message. */
export async function prayerTimesMessage(): Promise<string> {
  const [prayers, settings] = await Promise.all([fetchPrayerTimes(), prayerSettings()]);

  return (
    'Aaj Karachi ki namaz timings:\n' +
    prayers.map((p) => `• ${p.name}: ${p.at}`).join('\n') +
    '\n\n' +
    (settings.on
      ? `${settings.minutesBefore} minute pehle reminder aa jayega.`
      : 'Reminders abhi band hain — "namaz reminders on kar do" kaho to laga dunga.')
  );
}

/**
 * Save Tayyab's own timings. Accepts "5:30", "05:30", "17:00".
 *
 * Times are stored exactly as given, in 24-hour form. Nothing is inferred
 * about which prayer a bare hour belongs to — "5:30" for Asr means 17:30,
 * and only the caller knows that, so the caller must say it.
 */
export async function saveCustomPrayerTimes(
  times: Partial<Record<string, string>>,
): Promise<string> {
  const cleaned: Record<string, string> = {};

  for (const name of PRAYERS) {
    const raw = times[name];
    if (!raw) continue;

    const match = /^(\d{1,2})\s*[:.]?\s*(\d{2})$/.exec(String(raw).trim());
    if (!match) return `FAIL: "${name}" ka waqt samajh nahi aaya ("${raw}").`;

    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) return `FAIL: "${raw}" theek waqt nahi hai.`;

    cleaned[name] = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  if (Object.keys(cleaned).length === 0) return 'FAIL: koi waqt nahi mila.';

  // Merge, so setting one prayer does not wipe the rest.
  const existing = (await customPrayerTimes()) ?? [];
  const merged: Record<string, string> = {};
  for (const p of existing) merged[p.name] = p.at;
  Object.assign(merged, cleaned);

  const { error } = await db()
    .from('settings')
    .update({ prayer_times: merged, updated_at: new Date().toISOString() })
    .eq('id', 1);

  if (error) return `FAIL: ${error.message}`;

  return (
    'Tumhari timings save ho gayin:\n' +
    PRAYERS.filter((n) => merged[n]).map((n) => `• ${n}: ${merged[n]}`).join('\n') +
    '\n\nAb reminders inhi ke hisab se aayenge, calculated waqt ke nahi.'
  );
}

/** Go back to the calculated times. */
export async function clearCustomPrayerTimes(): Promise<string> {
  const { error } = await db()
    .from('settings')
    .update({ prayer_times: null, updated_at: new Date().toISOString() })
    .eq('id', 1);

  if (error) return `FAIL: ${error.message}`;
  return 'Tumhari timings hata deen. Ab Karachi ke calculated waqt istemal honge.';
}
