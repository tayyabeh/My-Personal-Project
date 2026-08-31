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
import { pendingTasks, recentCompletionRate } from '../context';
import { ROMAN_URDU } from '../lang';
import { pickQuote, formatQuote } from './quotes';
import { scheduleTodaysPrayers } from './prayer';

/** A date offset from now, in Karachi, as YYYY-MM-DD. */
function localDate(dayOffset = 0): string {
  const when = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
  return when.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
}

/** The current hour in Karachi, 0-23. */
function localHour(): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Karachi',
      hour: '2-digit',
      hour12: false,
    }).format(new Date()),
  );
}

/**
 * Which day the night summary is actually closing out.
 *
 * Tayyab sleeps around 5am, so his summary runs after midnight — by which
 * point the calendar date has already rolled over. Running at 3am on the
 * 1st should summarise the 31st, not the empty new day. Anything before
 * 6am is treated as the tail of the previous day.
 */
function dayBeingSummarised(): string {
  return localHour() < 6 ? localDate(-1) : localDate(0);
}

/** Where unfinished work rolls to: the day after the one being closed. */
function rolloverTarget(): string {
  return localHour() < 6 ? localDate(0) : localDate(1);
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
            'Ek chhoti si line likho, personal assistant ke liye. Ek jumla, 20 lafz se ' +
            'kam. Seedhi aur sachi baat, chaploosi nahi, koi emoji nahi. Jo bataya gaya ' +
            'hai us se bahar koi baat mat banao.\n\n' + ROMAN_URDU,
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
  const today = dayBeingSummarised();

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
        due_date: rolloverTarget(),
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
      ? `Aaj koi task log nahi hua. ${line}`
      : `Aaj: ${planned} mein se ${completed} ho gaye (${rate}%).` +
        (unfinished.length > 0
          ? `\n\nKal pe chale gaye:\n${unfinished.map((t) => `• ${t.title}`).join('\n')}`
          : '') +
        `\n\n${line}`;

  await messaging.send(body, templates.nightSummary(completed, planned, line));

  return `night summary sent: ${completed}/${planned} (${rate}%), ${unfinished.length} rolled over`;
}

// ---------------------------------------------------------------------
// Morning greeting
// ---------------------------------------------------------------------

/**
 * Two tasks Tayyab wants on the list every single day.
 *
 * Added by the morning job rather than left to him to remember, which is
 * the whole point of asking for them to be fixed.
 */
const DAILY_TASKS = ['Gym', 'Namaz (paanchon waqt)'];

/** Add the fixed tasks, skipping any already open today. */
async function ensureDailyTasks(): Promise<string[]> {
  const today = localDate(0);

  const { data: existing } = await db()
    .from('tasks')
    .select('title')
    .eq('due_date', today);

  const alreadyThere = new Set((existing ?? []).map((t) => String(t.title)));
  const missing = DAILY_TASKS.filter((title) => !alreadyThere.has(title));

  if (missing.length === 0) return [];

  const { error } = await db().from('tasks').insert(
    missing.map((title) => ({
      title,
      priority: 'high',
      status: 'pending',
      due_date: today,
    })),
  );

  if (error) {
    log.error('Could not add the fixed daily tasks', { error: error.message });
    return [];
  }
  return missing;
}

/**
 * The morning, in two messages.
 *
 * Tayyab asked for the greeting and the question to arrive separately —
 * one to read, one to answer. A single message asking "what are your
 * tasks" underneath a quote gets skimmed past.
 */
export async function runMorningGreeting(): Promise<string> {
  const [tasks, rate] = await Promise.all([pendingTasks(), recentCompletionRate()]);

  // Anything already carried forward is worth naming explicitly — those
  // are the things being avoided.
  const rolled = tasks.filter((task) => task.rollover_count > 0);

  // Quotes come from a checked list in code, never from the model. Asked
  // for real quotes, a model invents fluent ones and misattributes them.
  const { data: recent } = await db()
    .from('messages')
    .select('content')
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
    .limit(12);

  const quote = pickQuote((recent ?? []).map((m) => String(m.content ?? '')));

  const line = await generateLine(
    `Write one short opening line for the user's morning. ` +
      (rate !== null ? `Their completion rate over the last week is ${rate}%. ` : '') +
      (rolled.length > 0
        ? `They have been avoiding: ${rolled.map((t) => t.title).join(', ')}. Nudge them honestly. `
        : 'They have a clean slate. ') +
      `Do not congratulate them for work they have not done.`,
  );

  // Message 1 — greeting and the quote.
  await messaging.send(
    `Subah bakhair!\n\n${formatQuote(quote)}\n\n${line}`,
    templates.morningGreeting(line),
  );

  // Fixed tasks and namaz reminders, before asking what else is planned.
  const added = await ensureDailyTasks();
  const prayers = await scheduleTodaysPrayers();

  // Message 2 — the actual question.
  const parts: string[] = [];
  if (added.length > 0) parts.push(`Aaj ke pakke tasks laga diye: ${added.join(', ')}.`);
  if (rolled.length > 0) {
    parts.push(
      `Ab tak taale hue:\n${rolled.map((t) => `• ${t.title} (${t.rollover_count}x)`).join('\n')}`,
    );
  }
  parts.push('Aaj aur kya karna hai? Bata do, main yaad dilata rahunga.');

  await messaging.sendText(parts.join('\n\n'));

  return `morning sent (quote: ${quote.who}), ${added.length} fixed tasks, ${prayers}`;
}

// ---------------------------------------------------------------------
// Daytime check-ins
// ---------------------------------------------------------------------

/**
 * A short nudge during the day so tasks stay front of mind.
 *
 * Two deliberate choices:
 *  - If nothing is pending, we send nothing. A reminder about an empty
 *    list is just noise, and noise is how people start ignoring the bot.
 *  - If the 24-hour window has closed we skip rather than fall back to a
 *    template. A nudge is not worth spending a template on, and the next
 *    real message reopens the window anyway.
 */
export async function runCheckIn(): Promise<string> {
  const tasks = await pendingTasks();

  if (tasks.length === 0) {
    return 'skipped: nothing pending';
  }

  if (!(await messaging.windowIsOpen())) {
    log.info('Check-in skipped, 24-hour window closed');
    return 'skipped: window closed';
  }

  // Lead with whatever has slipped most often — that is the thing being
  // avoided, and the whole point of asking repeatedly.
  const sorted = [...tasks].sort((a, b) => b.rollover_count - a.rollover_count);
  const worst = sorted[0];

  const line = await generateLine(
    `Write one short nudge asking whether the user has made progress. ` +
      `They have ${tasks.length} task(s) still open. ` +
      (worst.rollover_count > 0
        ? `The worst offender is "${worst.title}", carried over ${worst.rollover_count} times. Mention it directly. `
        : '') +
      `Do not congratulate them. Do not assume anything is finished.`,
  );

  const body =
    `${line}\n\n` +
    sorted
      .slice(0, 6)
      .map((t) => `• ${t.title}${t.rollover_count > 0 ? ` (${t.rollover_count}x)` : ''}`)
      .join('\n') +
    `\n\nBatao inmein se kuch ho gaya?`;

  await messaging.sendText(body);

  return `check-in sent for ${tasks.length} pending task(s)`;
}
