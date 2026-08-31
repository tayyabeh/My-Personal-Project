/**
 * Tasks agent.
 *
 * The old flow could add tasks but had no way to act on a follow-up like
 * "ab inko calendar pe daal do" — that fell to the chat handler, which
 * cheerfully agreed and did nothing. Pushing to the calendar is a real
 * tool here, so agreeing means doing.
 */
import { z } from 'zod';
import { db } from '../supabase';
import { pendingTasks, todayLocal } from '../context';
import { extractTasks, saveTasks, matchCompletion, completeTask } from '../features/tasks';
import { createAllDayEvent } from '../google/calendar';
import type { Agent, Tool } from './types';

const listTasks: Tool<Record<string, never>> = {
  name: 'list_tasks',
  description: 'Sare pending tasks dekho, unki id aur kitni dafa tale gaye hain ke saath.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const tasks = await pendingTasks();
    if (tasks.length === 0) return 'Koi pending task nahi.';
    return tasks
      .map(
        (t, i) =>
          `${i + 1}. id=${t.id} | ${t.title}${t.rollover_count > 0 ? ` (${t.rollover_count} dafa tala)` : ''}`,
      )
      .join('\n');
  },
};

const addTasks: Tool<{ text: string }> = {
  name: 'add_tasks',
  description:
    'User ke jumle se tasks nikaal kar save karo. Poora jumla do, khud se list mat banao.',
  args: 'text: string',
  schema: z.object({ text: z.string().min(2).max(2000) }),
  async run({ text }) {
    const extracted = await extractTasks(text);
    if (!extracted.ok) return `FAIL: tasks nikaal nahi paya (${extracted.error})`;
    if (extracted.tasks.length === 0) return 'Is jumle mein koi task nahi mila.';

    const confident = extracted.tasks.filter((t) => !t.uncertain);
    const unsure = extracted.tasks.filter((t) => t.uncertain);
    const { titles, onCalendar } = await saveTasks(confident);

    return (
      `${titles.length} save hue: ${titles.join(', ') || 'koi nahi'}. ` +
      `Calendar pe gaye: ${onCalendar}.` +
      (unsure.length > 0
        ? ` In pe yaqeen nahi tha, save NAHI kiye: ${unsure.map((t) => t.title).join(', ')}`
        : '')
    );
  },
};

const finishTask: Tool<{ text: string }> = {
  name: 'complete_task',
  description: 'Koi task done mark karo. User ke lafz do, main khud match kar lunga.',
  args: 'text: string',
  schema: z.object({ text: z.string().min(1).max(500) }),
  async run({ text }) {
    const tasks = await pendingTasks();
    if (tasks.length === 0) return 'Koi pending task hi nahi.';

    const match = await matchCompletion(text, tasks);
    if (!match) {
      return `Kaunsa task hai samajh nahi aaya. Pending: ${tasks.map((t) => t.title).join(', ')}`;
    }

    await completeTask(match.id);
    return `"${match.title}" done mark ho gaya. ${tasks.length - 1} baaki.`;
  },
};

/**
 * Backfills calendar entries for tasks that predate the calendar feature.
 * This is the exact gap Tayyab hit: three tasks existed, only the newest
 * had an event, and the other two looked missing.
 */
const pushToCalendar: Tool<Record<string, never>> = {
  name: 'push_tasks_to_calendar',
  description:
    'Har us pending task ko Google Calendar pe daalo jo abhi tak wahan nahi hai. Jab user ' +
    'kahe "inko calendar pe add karo" to yahi chalao.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const { data, error } = await db()
      .from('tasks')
      .select('id, title, due_date, google_event_id')
      .eq('status', 'pending');

    if (error) return `FAIL: ${error.message}`;

    const missing = (data ?? []).filter((t) => !t.google_event_id);
    if (missing.length === 0) return 'Sare pending tasks pehle se Calendar pe hain.';

    const added: string[] = [];
    for (const task of missing) {
      const eventId = await createAllDayEvent(
        task.title as string,
        (task.due_date as string) ?? todayLocal(),
      );
      if (eventId) {
        await db().from('tasks').update({ google_event_id: eventId }).eq('id', task.id);
        added.push(task.title as string);
      }
    }

    return added.length === 0
      ? 'FAIL: Calendar pe koi task add nahi ho saka.'
      : `${added.length} tasks Calendar pe add ho gaye: ${added.join(', ')}`;
  },
};

export const tasksAgent: Agent = {
  name: 'tasks',
  description:
    'Tasks sambhalta hai: naye tasks likhna, done mark karna, pending list dena, aur ' +
    'tasks ko Google Calendar pe daalna.',
  instructions:
    '- Naye tasks ke liye user ka poora jumla add_tasks ko do.\n' +
    '- "calendar pe daalo" jaisi baat pe push_tasks_to_calendar chalao — sirf haan mat kaho.\n' +
    '- Jawab mein wahi ginti batao jo tool ne di. Apni taraf se number mat banao.',
  tools: [listTasks, addTasks, finishTask, pushToCalendar] as unknown as Tool<never>[],
  maxSteps: 4,
};
