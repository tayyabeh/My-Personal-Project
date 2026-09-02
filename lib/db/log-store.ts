/**
 * Persisted error logs.
 *
 * Vercel's own logs are not reachable from inside this app — that gap is
 * what made an earlier timeout bug so hard to pin down. `error`-level
 * logs are additionally written here (`records`, kind 'log'), so
 * `/api/diag?logs=1` can show a production-only failure without needing
 * the Vercel dashboard.
 */
import { db } from '../supabase';

export async function writeLog(
  level: string,
  message: string,
  fields?: Record<string, unknown>,
): Promise<void> {
  const { error } = await db()
    .from('records')
    .insert({ kind: 'log', data: { level, message, fields: fields ?? {} } });

  if (error) throw new Error(error.message);
}

export interface LogRow {
  happened_at: string;
  data: { level: string; message: string; fields: Record<string, unknown> };
}

export async function recentLogs(limit = 50): Promise<LogRow[]> {
  const { data, error } = await db()
    .from('records')
    .select('data, happened_at')
    .eq('kind', 'log')
    .order('happened_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data as unknown as LogRow[];
}

/**
 * Keep only the newest 500 log rows. Called unconditionally from the
 * scheduler tick — cheap, and matches the existing `job_runs` pattern of
 * app-level housekeeping rather than a DB trigger.
 */
export async function pruneLogs(keep = 500): Promise<void> {
  const { data } = await db()
    .from('records')
    .select('happened_at')
    .eq('kind', 'log')
    .order('happened_at', { ascending: false })
    .range(keep - 1, keep - 1)
    .maybeSingle();

  if (!data) return;

  await db().from('records').delete().eq('kind', 'log').lt('happened_at', data.happened_at as string);
}
