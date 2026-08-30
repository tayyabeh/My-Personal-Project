/**
 * The weekly review.
 *
 * The spec called this the most important feature in the whole system, and
 * asked for a manager rather than a cheerleader. So this deliberately
 * does the opposite of what a habit app normally does:
 *
 *  - It is prose, not a bullet list. Patterns live in sentences.
 *  - It reports what actually happened, including nothing happening.
 *  - It names the task you have dropped nine times, plainly, with the number.
 *  - It never congratulates work that is not in the database.
 *
 * Every number handed to the model is computed in code. The model's only
 * job is to interpret them.
 */
import { db } from '../supabase';
import { llm } from '../llm';
import { log } from '../logger';
import { messaging, templates } from '../messaging';
import { TIMEZONE } from '../env';

interface WeekFacts {
  completed: string[];
  stillOpen: Array<{ title: string; rollover_count: number }>;
  chronic: Array<{ title: string; rollover_count: number }>;
  created: number;
  dailyRates: number[];
  averageRate: number | null;
  daysLogged: number;
  daysWithNothingDone: number;
  learnings: string[];
}

async function gatherWeek(): Promise<WeekFacts> {
  const client = db();
  const weekAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weekAgoDate = weekAgoIso.slice(0, 10);

  const [completedRes, openRes, createdRes, logsRes, learningsRes] = await Promise.all([
    client
      .from('tasks')
      .select('title')
      .eq('status', 'done')
      .gte('completed_at', weekAgoIso),
    client
      .from('tasks')
      .select('title, rollover_count')
      .eq('status', 'pending')
      .order('rollover_count', { ascending: false }),
    client.from('tasks').select('id').gte('created_at', weekAgoIso),
    client
      .from('daily_logs')
      .select('log_date, completion_rate, tasks_completed')
      .gte('log_date', weekAgoDate)
      .order('log_date'),
    client.from('learnings').select('content').gte('created_at', weekAgoIso),
  ]);

  const logs = logsRes.data ?? [];
  const dailyRates = logs.map((l) => Number(l.completion_rate) || 0);
  const stillOpen = (openRes.data ?? []) as Array<{ title: string; rollover_count: number }>;

  return {
    completed: (completedRes.data ?? []).map((t) => t.title as string),
    stillOpen,
    // Three or more slips is not bad luck, it is a pattern worth naming.
    chronic: stillOpen.filter((t) => t.rollover_count >= 3),
    created: (createdRes.data ?? []).length,
    dailyRates,
    averageRate:
      dailyRates.length > 0
        ? Math.round(dailyRates.reduce((a, b) => a + b, 0) / dailyRates.length)
        : null,
    daysLogged: logs.length,
    daysWithNothingDone: logs.filter((l) => (l.tasks_completed ?? 0) === 0).length,
    learnings: (learningsRes.data ?? []).map((l) => l.content as string),
  };
}

function factSheet(facts: WeekFacts): string {
  const lines: string[] = [];

  lines.push(`Tasks created this week: ${facts.created}`);
  lines.push(`Tasks completed this week: ${facts.completed.length}`);
  if (facts.completed.length > 0) {
    lines.push(`Completed: ${facts.completed.join('; ')}`);
  }

  if (facts.averageRate !== null) {
    lines.push(`Average daily completion rate: ${facts.averageRate}%`);
    lines.push(`Daily rates in order: ${facts.dailyRates.join('%, ')}%`);
    lines.push(`Days logged: ${facts.daysLogged}`);
    lines.push(`Days where nothing at all was completed: ${facts.daysWithNothingDone}`);
  } else {
    lines.push('No daily logs exist for this week yet.');
  }

  if (facts.chronic.length > 0) {
    lines.push(
      `Repeatedly avoided (task, times carried over): ` +
        facts.chronic.map((t) => `"${t.title}" ${t.rollover_count} times`).join('; '),
    );
  } else if (facts.stillOpen.length > 0) {
    lines.push(`Still open: ${facts.stillOpen.map((t) => t.title).join('; ')}`);
  } else {
    lines.push('Nothing is currently open.');
  }

  if (facts.learnings.length > 0) {
    lines.push(`Things they noted learning: ${facts.learnings.join('; ')}`);
  }

  return lines.join('\n');
}

export async function runWeeklyReview(): Promise<string> {
  const facts = await gatherWeek();

  // Nothing to review is itself worth saying, but not worth a paragraph
  // of invented insight.
  if (facts.created === 0 && facts.completed.length === 0 && facts.daysLogged === 0) {
    await messaging.send(
      "Weekly review: there's nothing to review. No tasks were logged at all this week. " +
        'If you want this to be useful, it needs something to work with.',
      templates.nightSummary(0, 0, 'Nothing was logged this week.'),
    );
    return 'weekly review: no data';
  }

  const review = await llm().complete(
    [
      {
        role: 'system',
        content:
          'You are writing a weekly review for one person, delivered on WhatsApp.\n\n' +
          'Write in flowing prose, NOT a bullet list. Three short paragraphs at most, ' +
          'around 150 words total.\n\n' +
          'You are a manager, not a cheerleader. Rules you must follow:\n' +
          '- Use ONLY the numbers given below. Never invent a task, a number, or an event.\n' +
          '- If a task has been carried over many times, say so directly and say the number. ' +
          'Do not soften it into encouragement.\n' +
          '- If the week was poor, say it was poor. Do not open with praise you had to invent.\n' +
          '- If something genuinely went well, say that too, once, without inflating it.\n' +
          '- Look for a PATTERN across the week rather than restating the numbers. Which kinds ' +
          'of task get done and which get pushed? Is the rate rising or falling?\n' +
          '- End with one specific thing to change next week, not a platitude.\n' +
          '- Be blunt about the facts and the pattern, but criticise the behaviour, never ' +
          'the person. Do not make sweeping judgements about their character, discipline or ' +
          'ability. "You cleared the easy items and left the hard one" is right; "this shows ' +
          'your inability to prioritise" is not.\n' +
          '- No emoji. No exclamation marks. Address them as "you".',
      },
      { role: 'user', content: `Here is the week's data:\n\n${factSheet(facts)}` },
    ],
    { temperature: 0.7, maxTokens: 900 },
  );

  const heading = `Weekly review — ${new Date().toLocaleDateString('en-GB', {
    timeZone: TIMEZONE,
    day: 'numeric',
    month: 'long',
  })}\n\n`;

  await messaging.send(
    heading + review,
    templates.nightSummary(
      facts.completed.length,
      facts.created,
      'Your weekly review is ready.',
    ),
  );

  log.info('Weekly review sent', {
    completed: facts.completed.length,
    chronic: facts.chronic.length,
  });

  return `weekly review sent: ${facts.completed.length} completed, ${facts.chronic.length} chronic`;
}
