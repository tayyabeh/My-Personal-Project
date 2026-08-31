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

const MINUTES_BEFORE = 15;

/** The five daily prayers, in order. Sunrise and midnight are not prayers. */
const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'] as const;

export interface PrayerTime {
  name: string;
  /** "HH:MM" in Karachi time. */
  at: string;
}

export async function fetchPrayerTimes(): Promise<PrayerTime[]> {
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
    const remindAt = new Date(prayerAt.getTime() - MINUTES_BEFORE * 60_000);

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
  const prayers = await fetchPrayerTimes();
  return (
    'Aaj Karachi ki namaz timings:\n' +
    prayers.map((p) => `• ${p.name}: ${p.at}`).join('\n') +
    `\n\n${MINUTES_BEFORE} minute pehle reminder aa jayega.`
  );
}
