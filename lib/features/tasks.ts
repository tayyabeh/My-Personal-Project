/**
 * Task capture and completion.
 *
 * Two separate single-purpose prompts. Extraction never has to think
 * about matching, and matching never has to think about extraction.
 */
import { z } from 'zod';
import { completeJson } from '../llm/json';
import { db } from '../supabase';
import { pendingTasks, todayLocal, type TaskRow } from '../context';
import { log } from '../logger';
import { createAllDayEvent } from '../google/calendar';

// ---------------------------------------------------------------------
// Extracting tasks from speech
// ---------------------------------------------------------------------

const ExtractionSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        priority: z.enum(['low', 'normal', 'high']).default('normal'),
        /** True when the wording was garbled and we had to guess. */
        uncertain: z.boolean().default(false),
      }),
    )
    .max(20),
});

const EXTRACT_SYSTEM = `You extract individual tasks from a person speaking casually.

Reply ONLY with JSON:
{"tasks":[{"title":"...","priority":"low|normal|high","uncertain":true|false}]}

Rules:
- One entry per distinct task. Split "do X and Y" into two tasks.
- Drop filler words (um, uh, like, so). Write each title as a short imperative.
- priority "high" only if they clearly signal urgency or importance.
- priority "low" for things framed as optional ("if I get time", "maybe").
- Set uncertain=true when the speech is garbled or you had to guess the
  meaning. This input often comes from imperfect speech-to-text.
- If there are no real tasks, return {"tasks":[]}.`;

const EXTRACT_EXAMPLES: Array<[string, unknown]> = [
  [
    'gotta email sara the invoice and umm the other thing',
    {
      tasks: [
        { title: 'Email Sara the invoice', priority: 'normal', uncertain: false },
        { title: 'The other thing', priority: 'low', uncertain: true },
      ],
    },
  ],
  [
    'need to book the flight tomorrow morning its important',
    { tasks: [{ title: 'Book the flight', priority: 'high', uncertain: false }] },
  ],
  [
    'so today finish the client proposal call my brother and go to the gym maybe groceries if theres time',
    {
      tasks: [
        { title: 'Finish the client proposal', priority: 'normal', uncertain: false },
        { title: 'Call my brother', priority: 'normal', uncertain: false },
        { title: 'Go to the gym', priority: 'normal', uncertain: false },
        { title: 'Pick up groceries', priority: 'low', uncertain: false },
      ],
    },
  ],
];

export interface ExtractedTask {
  title: string;
  priority: 'low' | 'normal' | 'high';
  uncertain: boolean;
}

export async function extractTasks(
  text: string,
): Promise<{ ok: true; tasks: ExtractedTask[] } | { ok: false; error: string }> {
  const messages = [
    { role: 'system' as const, content: EXTRACT_SYSTEM },
    ...EXTRACT_EXAMPLES.flatMap(([input, output]) => [
      { role: 'user' as const, content: input },
      { role: 'assistant' as const, content: JSON.stringify(output) },
    ]),
    { role: 'user' as const, content: text },
  ];

  const result = await completeJson(ExtractionSchema, messages, {
    temperature: 0.2,
    maxTokens: 900,
  });

  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, tasks: result.data.tasks as ExtractedTask[] };
}

/**
 * Write confident tasks to the database, and mirror them onto Google
 * Calendar as all-day entries.
 *
 * The database write is what matters; the calendar copy is a convenience.
 * So calendar failures are logged and swallowed rather than losing the
 * task, and they run after the insert, never before it.
 */
export async function saveTasks(
  tasks: ExtractedTask[],
): Promise<{ titles: string[]; onCalendar: number }> {
  if (tasks.length === 0) return { titles: [], onCalendar: 0 };

  const dueDate = todayLocal();
  const rows = tasks.map((task) => ({
    title: task.title,
    priority: task.priority,
    status: 'pending',
    due_date: dueDate,
  }));

  const { data, error } = await db().from('tasks').insert(rows).select('id, title');
  if (error) throw new Error(`Could not save tasks: ${error.message}`);

  const saved = data ?? [];
  let onCalendar = 0;

  for (const row of saved) {
    try {
      const eventId = await createAllDayEvent(row.title as string, dueDate);
      if (eventId) {
        await db().from('tasks').update({ google_event_id: eventId }).eq('id', row.id);
        onCalendar++;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // NOT_CONNECTED simply means Google is not linked; not worth noise.
      if (message !== 'NOT_CONNECTED') {
        log.warn('Could not add task to calendar', { title: row.title, error: message });
      }
      break; // if one fails they will all fail; do not retry the rest
    }
  }

  return { titles: saved.map((row) => row.title as string), onCalendar };
}

// ---------------------------------------------------------------------
// Matching a loose completion phrase to a pending task
// ---------------------------------------------------------------------

const MatchSchema = z.object({
  /** 1-based index into the numbered list, or null when nothing matches. */
  match: z.number().int().positive().nullable(),
});

const MATCH_SYSTEM = `The user says they finished something. Decide which
task from their pending list they mean.

Reply ONLY with JSON: {"match": <number>} using the 1-based number from
the list, or {"match": null} if nothing clearly matches.

Match on meaning, not exact words — "done with the proposal" matches
"Finish the client proposal". If two tasks are equally plausible, or none
fit, return null rather than guessing.`;

export async function matchCompletion(
  text: string,
  tasks: TaskRow[],
): Promise<TaskRow | null> {
  if (tasks.length === 0) return null;

  const numbered = tasks.map((task, index) => `${index + 1}. ${task.title}`).join('\n');

  const messages = [
    { role: 'system' as const, content: MATCH_SYSTEM },
    {
      role: 'user' as const,
      content: `Pending tasks:\n1. Finish the client proposal\n2. Call my brother\n3. Go to the gym\n\nUser said: "done with the proposal"`,
    },
    { role: 'assistant' as const, content: JSON.stringify({ match: 1 }) },
    {
      role: 'user' as const,
      content: `Pending tasks:\n1. Finish the client proposal\n2. Call my brother\n\nUser said: "finished washing the car"`,
    },
    { role: 'assistant' as const, content: JSON.stringify({ match: null }) },
    { role: 'user' as const, content: `Pending tasks:\n${numbered}\n\nUser said: "${text}"` },
  ];

  const result = await completeJson(MatchSchema, messages, { temperature: 0, maxTokens: 200 });
  if (!result.ok || result.data.match === null) return null;

  // Guard against the model inventing an index outside the list.
  const task = tasks[result.data.match - 1];
  if (!task) {
    log.warn('Model returned an out-of-range task index', { index: result.data.match });
    return null;
  }
  return task;
}

/** Mark a task done. */
export async function completeTask(taskId: string): Promise<void> {
  const { error } = await db()
    .from('tasks')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('id', taskId);

  if (error) throw new Error(`Could not complete task: ${error.message}`);
}

/** A short human-readable list of what is still open. */
export async function pendingSummary(): Promise<string> {
  const tasks = await pendingTasks();
  if (tasks.length === 0) return 'Kuch pending nahi. List clear hai.';

  const lines = tasks.slice(0, 15).map((task) => {
    const nagged = task.rollover_count > 0 ? ` (${task.rollover_count} dafa tala)` : '';
    return `• ${task.title}${nagged}`;
  });

  const more = tasks.length > 15 ? `\n…aur ${tasks.length - 15} baaki.` : '';
  return `${tasks.length} pending:\n${lines.join('\n')}${more}`;
}
