/**
 * The morning greeting and the night summary.
 *
 * Both go out through messaging.send(), which picks freeform or template
 * automatically depending on whether the 24-hour window is open. Neither
 * of these functions knows or cares which happened.
 */
import { db } from '../supabase';
import { llm } from '../llm';
import { log } from '../logger';
import { messaging, templates } from '../messaging';
import { pendingTasks, recentCompletionRate, todayLocal } from '../context';

/** Tomorrow's date in Karachi, as YYYY-MM-DD. */
function tomorrowLocal(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return tomorrow.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
}

/**
 * A fresh line each time, grounded in real numbers — never from a static
 * list, and never congratulating you for work you did not do.
 */
async function generateLine(prompt: string): Promise<string> {
  try {
    const line = await llm().complete(
      [
        {
          role: 'system',
          content:
            'You write a single short line for a personal assistant. One sentence, ' +
            'maximum 20 words. Direct and honest, never gushing, no emoji, no exclamation ' +
            'marks unless genuinely warranted. Do not invent facts beyond what you are told.',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0.85, maxTokens: 200 },
    );
    return line.replace(/^["']|["']$/g, '').trim();
  } catch (error) {
    log.error('Could not generate line, using fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'Here is where things stand.';
  }
}

// ---------------------------------------------------------------------
// Night summary
// ---------------------------------------------------------------------

export async function runNightSummary(): Promise<string> {
  const today = todayLocal();

  // Everything that was on the plate for today.
  const { data: todaysTasks, error } = await db()
    .from('tasks')
    .select('id, title, status, rollover_count')
    .eq('due_date', today);

  if (error) throw new Error(`Could not load today's tasks: ${error.message}`);

  const tasks = todaysTasks ?? [];
  const planned = tasks.length;
  const completed = tasks.filter((task) => task.status === 'done').length;
  const rate = planned === 0 ? 0 : Math.round((completed / planned) * 100);
  const unfinished = tasks.filter((task) => task.status === 'pending');

  // Roll unfinished work forward. We bump the existing rows in place
  // rather than creating copies, so a task keeps one identity and its
  // rollover_count is a truthful record of how often it has slipped.
  for (const task of unfinished) {
    const { error: rollError } = await db()
      .from('tasks')
      .update({
        due_date: tomorrowLocal(),
        rollover_count: (task.rollover_count ?? 0) + 1,
      })
      .eq('id', task.id);

    if (rollError) log.error('Rollover failed', { id: task.id, error: rollError.message });
  }

  const line = await generateLine(
    `The user completed ${completed} of ${planned} tasks today (${rate}%). ` +
      `${unfinished.length} rolled over to tomorrow. ` +
      (unfinished.length > 0 ? `Still open: ${unfinished.map((t) => t.title).join(', ')}. ` : '') +
      `Write one honest closing line for the day. If the rate is poor, say so plainly without being harsh.`,
  );

  // One row per day; re-running the job updates rather than duplicates.
  const { error: logError } = await db().from('daily_logs').upsert(
    {
      log_date: today,
      tasks_planned: planned,
      tasks_completed: completed,
      completion_rate: rate,
      motivational_line: line,
    },
    { onConflict: 'log_date' },
  );
  if (logError) log.error('Could not write daily log', { error: logError.message });

  const body =
    planned === 0
      ? `No tasks logged today. ${line}`
      : `Today: ${completed} of ${planned} done (${rate}%).` +
        (unfinished.length > 0
          ? `\n\nRolled to tomorrow:\n${unfinished.map((t) => `• ${t.title}`).join('\n')}`
          : '') +
        `\n\n${line}`;

  await messaging.send(body, templates.nightSummary(completed, planned, line));

  return `night summary sent: ${completed}/${planned} (${rate}%), ${unfinished.length} rolled over`;
}

// ---------------------------------------------------------------------
// Morning greeting
// ---------------------------------------------------------------------

export async function runMorningGreeting(): Promise<string> {
  const [tasks, rate] = await Promise.all([pendingTasks(), recentCompletionRate()]);

  // Anything already carried forward is worth naming explicitly — those
  // are the things being avoided.
  const rolled = tasks.filter((task) => task.rollover_count > 0);

  const line = await generateLine(
    `Write one motivational opening line for the user's morning. ` +
      (rate !== null ? `Their completion rate over the last week is ${rate}%. ` : '') +
      (rolled.length > 0
        ? `They have been avoiding: ${rolled.map((t) => t.title).join(', ')}. Nudge them honestly about it. `
        : 'They have a clean slate. ') +
      `Do not congratulate them for work they have not done.`,
  );

  const body =
    `Good morning! ${line}` +
    (rolled.length > 0
      ? `\n\nStill carried over:\n${rolled
          .map((t) => `• ${t.title} (${t.rollover_count}x)`)
          .join('\n')}`
      : '') +
    `\n\nWhat are your tasks for today?`;

  await messaging.send(body, templates.morningGreeting(line));

  return `morning greeting sent, ${rolled.length} rolled-over tasks mentioned`;
}
