/**
 * Tasks and the daily routine.
 *
 * The old tasks agent could add and complete, but had no delete, cancel,
 * rename or merge — which is exactly how "purane pending tasks delete kar
 * diye" got said with no tool behind it. Those are real tools here now,
 * so a claim to have deleted something is backed by a write_op or it does
 * not survive the honesty filter.
 */
import { z } from 'zod';
import { db } from '../supabase';
import { pendingTasks, todayLocal, type TaskRow } from '../context';
import { extractTasks, saveTasks, matchCompletion, completeTask } from '../features/tasks';
import { createAllDayEvent, deleteEvent } from '../google/calendar';
import { insertOnce } from '../db/idempotency';
import { ok, fail, type Tool } from './types';

const listTasks: Tool<Record<string, never>> = {
  name: 'list_tasks',
  description: 'Pending tasks + id dikhao.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const tasks = await pendingTasks();
    if (tasks.length === 0) {
      return ok({ tool: 'list_tasks', effect: 'read', factLine: 'Koi pending task nahi.', numbers: [0] });
    }
    const lines = tasks.map(
      (t, i) =>
        `${i + 1}. id=${t.id} | ${t.title}${t.rollover_count > 0 ? ` (${t.rollover_count} dafa tala)` : ''}`,
    );
    return ok({
      tool: 'list_tasks',
      effect: 'read',
      factLine: `${tasks.length} pending task hain.`,
      numbers: [tasks.length],
      entities: tasks.map((t) => t.title),
      observation: lines.join('\n'),
    });
  },
};

const addTasks: Tool<{ text: string }> = {
  name: 'add_tasks',
  description: 'Jumle se tasks nikaal kar save karo. Poora jumla do.',
  args: 'text: string',
  schema: z.object({ text: z.string().min(2).max(2000) }),
  async run({ text }, ctx) {
    const extracted = await extractTasks(text);
    if (!extracted.ok) return fail('add_tasks', `Tasks nikaal nahi paya (${extracted.error}).`);
    if (extracted.tasks.length === 0) {
      return ok({ tool: 'add_tasks', effect: 'none', factLine: 'Is jumle mein koi task nahi mila.' });
    }

    const confident = extracted.tasks.filter((t) => !t.uncertain);
    const unsure = extracted.tasks.filter((t) => t.uncertain);

    if (confident.length === 0) {
      return ok({
        tool: 'add_tasks',
        effect: 'none',
        factLine: `In pe yaqeen nahi tha, save nahi kiye: ${unsure.map((t) => t.title).join(', ')}`,
      });
    }

    const { result } = await insertOnce(
      `${ctx.runId}:add_tasks:${confident.map((t) => t.title).join('|')}`,
      { runId: ctx.runId, tool: 'add_tasks', effect: 'write' },
      async () => {
        const saved = await saveTasks(confident);
        return { ok: true, result: saved };
      },
    );

    const saved = result ?? { titles: [], onCalendar: 0 };
    const factLine =
      `${saved.titles.length} task save hue: ${saved.titles.join(', ') || 'koi nahi'}.` +
      (saved.onCalendar > 0 ? ` Calendar pe gaye: ${saved.onCalendar}.` : '') +
      (unsure.length > 0 ? ` Yaqeen nahi tha, save nahi kiye: ${unsure.map((t) => t.title).join(', ')}.` : '');

    return ok({
      tool: 'add_tasks',
      effect: 'write',
      factLine,
      entities: saved.titles,
      numbers: [saved.titles.length, saved.onCalendar],
    });
  },
};

const completeTaskTool: Tool<{ text: string }> = {
  name: 'complete_task',
  description: 'Task done mark karo (user ke lafz do).',
  args: 'text: string',
  schema: z.object({ text: z.string().min(1).max(500) }),
  async run({ text }, ctx) {
    const tasks = await pendingTasks();
    if (tasks.length === 0) {
      return ok({ tool: 'complete_task', effect: 'none', factLine: 'Koi pending task hi nahi.' });
    }

    const match = await matchCompletion(text, tasks);
    if (!match) {
      return ok({
        tool: 'complete_task',
        effect: 'none',
        factLine: 'Kaunsa task hai samajh nahi aaya.',
        observation: `Pending: ${tasks.map((t) => t.title).join(', ')}`,
      });
    }

    const { ok: didComplete } = await insertOnce(
      `${ctx.runId}:complete_task:${match.id}`,
      { runId: ctx.runId, tool: 'complete_task', effect: 'write', target: match.id },
      async () => {
        await completeTask(match.id);
        return { ok: true, result: { id: match.id } };
      },
    );

    if (!didComplete) return fail('complete_task', `"${match.title}" complete nahi ho saka.`);

    return ok({
      tool: 'complete_task',
      effect: 'write',
      factLine: `"${match.title}" done mark ho gaya. ${tasks.length - 1} baaki.`,
      entities: [match.title],
      numbers: [tasks.length - 1],
    });
  },
};

/** Load a pending task row with its calendar link. */
async function findPending(idOrText: string) {
  const tasks = await pendingTasks();
  const byId = tasks.find((t) => t.id === idOrText);
  if (byId) return byId;
  const lower = idOrText.toLowerCase();
  return tasks.find((t) => t.title.toLowerCase().includes(lower)) ?? null;
}

/**
 * Resolve one call's targets: every pending task when `all`, otherwise
 * each id/title in `ids` matched to a pending task. Batching matters —
 * cancelling six tasks one-per-call once cost a dozen LLM steps and could
 * drain the whole per-minute token budget in one burst; here it is one
 * call, one reply.
 */
async function resolveTargets(
  ids: string[] | undefined,
  all: boolean | undefined,
): Promise<{ tasks: TaskRow[]; missing: string[] }> {
  const pending = await pendingTasks();
  if (all) return { tasks: pending, missing: [] };

  const tasks: TaskRow[] = [];
  const missing: string[] = [];
  for (const id of ids ?? []) {
    const byId = pending.find((t) => t.id === id);
    const match = byId ?? pending.find((t) => t.title.toLowerCase().includes(id.toLowerCase()));
    if (match && !tasks.some((t) => t.id === match.id)) tasks.push(match);
    else if (!match) missing.push(id);
  }
  return { tasks, missing };
}

const BatchSchema = z.object({
  ids: z.array(z.string().min(1).max(200)).max(50).optional(),
  all: z.boolean().optional(),
});

const cancelTask: Tool<{ ids?: string[]; all?: boolean }> = {
  name: 'cancel_task',
  description: 'Task(s) cancel karo EK hi call mein. ids: string[] (id/title) ya all:true. Har task ke liye alag call mat karo.',
  args: 'ids?: string[], all?: boolean',
  schema: BatchSchema,
  async run({ ids, all }, ctx) {
    const { tasks, missing } = await resolveTargets(ids, all);
    if (tasks.length === 0) return fail('cancel_task', `Koi pending task nahi mila: ${(ids ?? []).join(', ') || '(none)'}`);

    const idList = tasks.map((t) => t.id).sort();
    const { ok: done, result } = await insertOnce(
      `${ctx.runId}:cancel_task:${idList.join(',')}`,
      { runId: ctx.runId, tool: 'cancel_task', effect: 'write' },
      async () => {
        const { error } = await db().from('tasks').update({ status: 'cancelled' }).in('id', idList);
        if (error) return { ok: false, result: null, error: error.message };
        for (const t of tasks) await removeTaskEvent(t.id, ctx.signal);
        return { ok: true, result: { count: tasks.length } };
      },
    );

    if (!done) return fail('cancel_task', 'Cancel nahi ho saka.');
    const count = (result as { count: number })?.count ?? tasks.length;
    return ok({
      tool: 'cancel_task',
      effect: 'write',
      factLine:
        `${count} task cancel kar diye: ${tasks.map((t) => `"${t.title}"`).join(', ')}.` +
        (missing.length ? ` (Ye nahi mile: ${missing.join(', ')}.)` : ''),
      entities: tasks.map((t) => t.title),
      numbers: [count],
    });
  },
};

const deleteTask: Tool<{ ids?: string[]; all?: boolean }> = {
  name: 'delete_task',
  description: 'Task(s) hamesha ke liye mitao EK hi call mein (calendar event bhi hatega). ids: string[] ya all:true. Alag call mat karo.',
  args: 'ids?: string[], all?: boolean',
  schema: BatchSchema,
  async run({ ids, all }, ctx) {
    const { tasks, missing } = await resolveTargets(ids, all);
    if (tasks.length === 0) return fail('delete_task', `Koi pending task nahi mila: ${(ids ?? []).join(', ') || '(none)'}`);

    const idList = tasks.map((t) => t.id).sort();
    const { ok: done, result } = await insertOnce(
      `${ctx.runId}:delete_task:${idList.join(',')}`,
      { runId: ctx.runId, tool: 'delete_task', effect: 'write' },
      async () => {
        for (const t of tasks) await removeTaskEvent(t.id, ctx.signal);
        const { error } = await db().from('tasks').delete().in('id', idList);
        if (error) return { ok: false, result: null, error: error.message };
        return { ok: true, result: { count: tasks.length } };
      },
    );

    if (!done) return fail('delete_task', 'Delete nahi ho saka.');
    const count = (result as { count: number })?.count ?? tasks.length;
    return ok({
      tool: 'delete_task',
      effect: 'write',
      factLine:
        `${count} task delete kar diye: ${tasks.map((t) => `"${t.title}"`).join(', ')}.` +
        (missing.length ? ` (Ye nahi mile: ${missing.join(', ')}.)` : ''),
      entities: tasks.map((t) => t.title),
      numbers: [count],
    });
  },
};

const renameTask: Tool<{ id: string; title: string }> = {
  name: 'rename_task',
  description: 'Task ka naam badlo (id/title + naya naam).',
  args: 'id: string, title: string (naya naam)',
  schema: z.object({ id: z.string().min(1).max(200), title: z.string().min(1).max(200) }),
  async run({ id, title }, ctx) {
    const task = await findPending(id);
    if (!task) return fail('rename_task', `Is se koi pending task nahi mila: ${id}`);

    const { ok: done } = await insertOnce(
      `${ctx.runId}:rename_task:${task.id}:${title}`,
      { runId: ctx.runId, tool: 'rename_task', effect: 'write', target: task.id },
      async () => {
        const { error } = await db().from('tasks').update({ title }).eq('id', task.id);
        return error ? { ok: false, result: null, error: error.message } : { ok: true, result: { id: task.id } };
      },
    );

    return done
      ? ok({
          tool: 'rename_task',
          effect: 'write',
          factLine: `"${task.title}" ka naam "${title}" kar diya.`,
          entities: [title],
        })
      : fail('rename_task', 'Naam badal nahi saka.');
  },
};

const mergeTasks: Tool<{ keep: string; remove: string }> = {
  name: 'merge_tasks',
  description: 'Do tasks ek karo: keep rakho, remove cancel ho jayega.',
  args: 'keep: string, remove: string',
  schema: z.object({ keep: z.string().min(1).max(200), remove: z.string().min(1).max(200) }),
  async run({ keep, remove }, ctx) {
    const keepTask = await findPending(keep);
    const removeTask = await findPending(remove);
    if (!keepTask) return fail('merge_tasks', `"${keep}" se koi pending task nahi mila.`);
    if (!removeTask) return fail('merge_tasks', `"${remove}" se koi pending task nahi mila.`);
    if (keepTask.id === removeTask.id) return fail('merge_tasks', 'Dono ek hi task hain.');

    const { ok: done } = await insertOnce(
      `${ctx.runId}:merge_tasks:${keepTask.id}:${removeTask.id}`,
      { runId: ctx.runId, tool: 'merge_tasks', effect: 'write', target: keepTask.id },
      async () => {
        const { error } = await db().from('tasks').update({ status: 'cancelled' }).eq('id', removeTask.id);
        if (error) return { ok: false, result: null, error: error.message };
        await removeTaskEvent(removeTask.id, ctx.signal);
        return { ok: true, result: { kept: keepTask.id } };
      },
    );

    return done
      ? ok({
          tool: 'merge_tasks',
          effect: 'write',
          factLine: `"${removeTask.title}" ko "${keepTask.title}" mein mila diya. Ab ek hi hai.`,
          entities: [keepTask.title],
        })
      : fail('merge_tasks', 'Merge nahi ho saka.');
  },
};

const showRoutine: Tool<Record<string, never>> = {
  name: 'show_routine',
  description: 'Roz khud lagne wale tasks dikhao.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const { data, error } = await db()
      .from('settings')
      .select('daily_tasks, namaz_reminders, namaz_minutes_before')
      .eq('id', 1)
      .maybeSingle();

    if (error || !data) return fail('show_routine', 'Routine nahi mil saka.');

    const list = (data.daily_tasks as string[] | null) ?? [];
    const body = [
      list.length > 0 ? `Roz ke pakke tasks:\n${list.map((t) => `• ${t}`).join('\n')}` : 'Koi pakka task nahi.',
      `Namaz reminders: ${data.namaz_reminders ? 'on' : 'off'} (${data.namaz_minutes_before} minute pehle)`,
    ].join('\n\n');

    return ok({ tool: 'show_routine', effect: 'read', factLine: body, numbers: [list.length] });
  },
};

const editRoutine: Tool<{ tasks: string[] }> = {
  name: 'edit_routine',
  description: 'Roz ke tasks ki poori nayi list set karo (purani badal degi, jorti nahi).',
  args: 'tasks: string[]  (jaise ["Gym","Namaz (paanchon waqt)"])',
  schema: z.object({ tasks: z.array(z.string().min(1).max(120)).max(10) }),
  async run({ tasks }, ctx) {
    const cleaned = tasks.map((t) => t.trim()).filter(Boolean);

    const { ok: done } = await insertOnce(
      `${ctx.runId}:edit_routine:${cleaned.join('|')}`,
      { runId: ctx.runId, tool: 'edit_routine', effect: 'write' },
      async () => {
        const { error } = await db()
          .from('settings')
          .update({ daily_tasks: cleaned, updated_at: new Date().toISOString() })
          .eq('id', 1);
        return error ? { ok: false, result: null, error: error.message } : { ok: true, result: { count: cleaned.length } };
      },
    );

    if (!done) return fail('edit_routine', 'Routine save nahi ho saka.');

    return ok({
      tool: 'edit_routine',
      effect: 'write',
      factLine: cleaned.length === 0 ? 'Roz ke pakke tasks band kar diye.' : `Roz ye tasks lagenge: ${cleaned.join(', ')}. Kal subah se.`,
      entities: cleaned,
      numbers: [cleaned.length],
    });
  },
};

/** Remove a task's mirrored calendar event, if it has one. */
async function removeTaskEvent(taskId: string, signal: AbortSignal): Promise<void> {
  const { data } = await db().from('tasks').select('google_event_id').eq('id', taskId).maybeSingle();
  const eventId = data?.google_event_id as string | null;
  if (eventId) await deleteEvent(eventId, signal);
}

export const routineTools: Tool<any>[] = [
  listTasks,
  addTasks,
  completeTaskTool,
  cancelTask,
  deleteTask,
  renameTask,
  mergeTasks,
  showRoutine,
  editRoutine,
];

// Re-export for a caller that wants to backfill calendar events for
// today's tasks (kept as an internal helper; not itself a tool).
export { createAllDayEvent, todayLocal };
