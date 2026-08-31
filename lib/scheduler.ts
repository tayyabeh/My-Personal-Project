/**
 * The scheduler.
 *
 * Times used to be baked into pg_cron expressions, which meant changing
 * the morning greeting needed editing SQL and re-running it. Tayyab asked
 * to set his own times, so instead pg_cron just ticks every 5 minutes and
 * this decides what is actually due, reading the times from `settings`.
 *
 * Changing a time on the dashboard now takes effect on the next tick.
 */
import { db } from './supabase';
import { log } from './logger';
import { TIMEZONE } from './env';
import { runMorningGreeting, runNightSummary, runCheckIn } from './features/summary';
import { runWeeklyReview } from './features/weekly-review';
import { resurfaceDue } from './features/learnings';

/** Minutes since local midnight, plus the local weekday. */
function localNow(): { minutes: number; weekday: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
    weekday: days[get('weekday')] ?? 0,
  };
}

/** "13:00" or "13:00:00" -> minutes since midnight. */
function toMinutes(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

/**
 * Is this job due, and has it not already run?
 *
 * The window has to be at least as wide as the tick interval or a job
 * whose minute falls between ticks would never fire. `minGapHours` then
 * stops the same job firing on every tick inside that window.
 */
async function claimJob(job: string, minGapHours: number): Promise<boolean> {
  const { data } = await db().from('job_runs').select('last_run_at').eq('job', job).maybeSingle();

  if (data?.last_run_at) {
    const since = Date.now() - new Date(data.last_run_at as string).getTime();
    if (since < minGapHours * 60 * 60 * 1000) return false;
  }

  const { error } = await db()
    .from('job_runs')
    .upsert({ job, last_run_at: new Date().toISOString() }, { onConflict: 'job' });

  if (error) {
    log.error('Could not claim scheduled job', { job, error: error.message });
    return false;
  }
  return true;
}

/** Tick width in minutes. Must match the pg_cron interval. */
const WINDOW = 10;

function isDue(nowMinutes: number, scheduled: number): boolean {
  // Handles times just after midnight, where "now" wraps past the target.
  const diff = (nowMinutes - scheduled + 1440) % 1440;
  return diff < WINDOW;
}

export async function runTick(): Promise<string> {
  const { data: settings, error } = await db()
    .from('settings')
    .select('morning_time, night_time, checkin_times, weekly_time, weekly_dow, resurface_time')
    .eq('id', 1)
    .maybeSingle();

  if (error) throw new Error(`Could not read settings: ${error.message}`);
  if (!settings) return 'no settings row';

  const { minutes, weekday } = localNow();
  const fired: string[] = [];

  const maybe = async (
    job: string,
    time: string | null | undefined,
    gapHours: number,
    run: () => Promise<string>,
  ) => {
    if (!time) return;
    const scheduled = toMinutes(String(time));
    if (scheduled === null || !isDue(minutes, scheduled)) return;
    if (!(await claimJob(job, gapHours))) return;

    try {
      fired.push(`${job}: ${await run()}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Scheduled job failed', { job, error: message });
      fired.push(`${job}: FAILED ${message}`);
    }
  };

  await maybe('morning', settings.morning_time as string, 12, runMorningGreeting);
  await maybe('night', settings.night_time as string, 12, runNightSummary);
  await maybe('resurface', settings.resurface_time as string, 12, resurfaceDue);

  // Each check-in time is its own job, so one firing does not block the rest.
  const checkins = (settings.checkin_times as string[] | null) ?? [];
  for (const time of checkins) {
    await maybe(`checkin-${time}`, time, 12, runCheckIn);
  }

  if (weekday === Number(settings.weekly_dow ?? 0)) {
    // 6 days, so it cannot fire twice on the same weekly slot.
    await maybe('weekly', settings.weekly_time as string, 24 * 6, runWeeklyReview);
  }

  return fired.length === 0 ? 'nothing due' : fired.join('; ');
}
