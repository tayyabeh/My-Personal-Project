/**
 * Meta-tools: knowing your own limits, and undoing.
 *
 * `cannot_do` is half the answer to "hesitation". A model with no way to
 * say "can't" says "did" instead. Routing a refusal through a tool means
 * it produces a Receipt and lands in `records` (kind 'refusal'), so every
 * gap is visible on the dashboard and can be filled later.
 *
 * `list_capabilities` is the other half — it answers from the real TOOLS
 * array, so it can never drift from what is actually callable.
 */
import { z } from 'zod';
import { db } from '../supabase';
import { deleteEvent } from '../google/calendar';
import { ok, fail, type Receipt, type Tool, type ToolContext } from './types';

/**
 * Record a refusal and return its Receipt. Shared with any tool that must
 * decline for a reason it knows (e.g. a missing scope), so the decline is
 * evidenced the same way an action is.
 */
export async function recordRefusal(
  tool: string,
  reason: string,
  ctx: ToolContext,
): Promise<Receipt> {
  // A failed refusal-log must not mask the refusal itself.
  await db()
    .from('records')
    .insert({ kind: 'refusal', data: { tool, reason, input: ctx.input, runId: ctx.runId } });

  return ok({ tool, effect: 'write', factLine: reason });
}

const cannotDo: Tool<{ reason: string }> = {
  name: 'cannot_do',
  description: 'Koi tool na ho to jhoota wada mat karo — ye chalao aur saaf batao kya nahi ho sakta.',
  args: 'reason: string (kya nahi ho sakta, aur kyun)',
  schema: z.object({ reason: z.string().min(3).max(500) }),
  async run({ reason }, ctx) {
    return recordRefusal('cannot_do', reason, ctx);
  },
};

const listCapabilities: Tool<Record<string, never>> = {
  name: 'list_capabilities',
  description: 'Batao assistant kya kar sakta hai (asli tool list se).',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    // Imported lazily to avoid a cycle: index.ts imports these tools.
    const { TOOLS } = await import('./index');
    const lines = TOOLS.map((t) => `• ${t.name} — ${t.description}`);
    return ok({
      tool: 'list_capabilities',
      effect: 'read',
      factLine: `${TOOLS.length} kaam kar sakta hoon.`,
      numbers: [TOOLS.length],
      observation: lines.join('\n'),
    });
  },
};

/** Tools whose last write has a natural, already-built inverse. */
const UNDO_HANDLERS: Record<string, (op: WriteOpRow, ctx: ToolContext) => Promise<string>> = {
  async create_event(op, ctx) {
    const id = (op.result as { id?: string })?.id;
    if (!id) throw new Error('no event id recorded');
    await deleteEvent(id, ctx.signal);
    return 'Calendar event hata diya.';
  },
  async add_tasks(op) {
    // add_tasks stores titles; delete the most recent pending ones by title.
    const titles = (op.result as { titles?: string[] })?.titles ?? [];
    if (titles.length === 0) throw new Error('no task titles recorded');
    await db().from('tasks').delete().in('title', titles).eq('status', 'pending');
    return `${titles.length} task wapas hata diye.`;
  },
  async complete_task(op) {
    const id = op.target;
    if (!id) throw new Error('no task id recorded');
    await db().from('tasks').update({ status: 'pending', completed_at: null }).eq('id', id);
    return 'Task wapas pending kar diya.';
  },
  async set_reminder(_op, ctx) {
    // Best effort: the most recent unsent reminder is the one just set.
    const { data } = await db()
      .from('reminders')
      .select('id, google_event_id')
      .eq('sent', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) throw new Error('no reminder to undo');
    if (data.google_event_id) await deleteEvent(data.google_event_id as string, ctx.signal);
    await db().from('reminders').delete().eq('id', data.id);
    return 'Reminder wapas hata diya.';
  },
};

interface WriteOpRow {
  tool: string;
  target: string | null;
  result: unknown;
}

const undoLast: Tool<Record<string, never>> = {
  name: 'undo_last',
  description: 'Aakhri kaam wapas karo (agar ho sakta hai).',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run(_args, ctx) {
    const { data, error } = await db()
      .from('write_ops')
      .select('tool, target, result')
      .eq('ok', true)
      .eq('effect', 'write')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return fail('undo_last', error.message);
    if (!data) return ok({ tool: 'undo_last', effect: 'none', factLine: 'Wapas karne ko kuch nahi mila.' });

    const handler = UNDO_HANDLERS[data.tool as string];
    if (!handler) {
      return ok({
        tool: 'undo_last',
        effect: 'none',
        factLine: `"${data.tool}" ka undo nahi ho sakta.`,
      });
    }

    try {
      const message = await handler(data as WriteOpRow, ctx);
      return ok({ tool: 'undo_last', effect: 'write', factLine: message, entities: [String(data.tool)] });
    } catch (e) {
      return fail('undo_last', `Undo nahi ho saka: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const metaTools: Tool<any>[] = [cannotDo, listCapabilities, undoLast];
