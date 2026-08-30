/**
 * Recent context, loaded before each model call so the assistant feels
 * like it knows you.
 *
 * Deliberately small. Groq's free tier limits TOKENS per minute far more
 * tightly than requests, and gpt-oss is a reasoning model that spends
 * extra tokens thinking. A fat context here is what will rate-limit you,
 * so this stays to roughly a few hundred tokens.
 */
import { db } from './supabase';
import { TIMEZONE } from './env';

export interface TaskRow {
  id: string;
  title: string;
  status: string;
  rollover_count: number;
}

/** Today's date in Karachi, as YYYY-MM-DD. */
export function todayLocal(): string {
  // en-CA formats as YYYY-MM-DD, which is exactly what Postgres wants.
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

/** Every task still open. These are the candidates for completion matching. */
export async function pendingTasks(): Promise<TaskRow[]> {
  const { data, error } = await db()
    .from('tasks')
    .select('id, title, status, rollover_count')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Could not load pending tasks: ${error.message}`);
  return (data ?? []) as TaskRow[];
}

/** How often tasks got finished over the last week, as a percentage. */
export async function recentCompletionRate(days = 7): Promise<number | null> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db()
    .from('tasks')
    .select('status')
    .gte('created_at', since);

  if (error || !data || data.length === 0) return null;

  const done = data.filter((row) => row.status === 'done').length;
  return Math.round((done / data.length) * 100);
}

/**
 * A compact summary the model can read. Keep it short — this string is
 * prepended to prompts.
 */
export async function contextSummary(): Promise<string> {
  const [tasks, rate] = await Promise.all([pendingTasks(), recentCompletionRate()]);

  const lines: string[] = [`Today is ${todayLocal()} (Asia/Karachi).`];

  if (tasks.length === 0) {
    lines.push('No pending tasks.');
  } else {
    lines.push(`Pending tasks (${tasks.length}):`);
    // Cap the list so a long backlog cannot blow up the prompt.
    for (const task of tasks.slice(0, 20)) {
      const nagged = task.rollover_count > 0 ? ` [rolled over ${task.rollover_count}x]` : '';
      lines.push(`- ${task.title}${nagged}`);
    }
  }

  if (rate !== null) lines.push(`Completion rate over the last 7 days: ${rate}%.`);

  return lines.join('\n');
}
