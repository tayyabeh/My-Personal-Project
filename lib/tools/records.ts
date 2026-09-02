/**
 * The tenth file — money, the generic tracking store, and coach features.
 *
 * The design doc's 9-file table had no home for these, but dropping them
 * would lose real capabilities (and, for expenses, one of the six
 * production bugs the rebuild exists to fix: the false "Rs 1350"). So
 * they live here, each ported into the Receipt shape.
 */
import { z } from 'zod';
import { db } from '../supabase';
import { TIMEZONE } from '../env';
import { logExpense, monthSummary } from '../features/expenses';
import { saveLearning } from '../features/learnings';
import { contextSummary } from '../context';
import { askReflection, sendBookPodcast } from '../features/podcast';
import { bookFromRequest } from '../features/books';
import { insertOnce } from '../db/idempotency';
import { ok, fail, type Tool } from './types';

function whenText(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: TIMEZONE,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normaliseKind(kind: string): string {
  return kind.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 40);
}

// ---------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------

const logExpenseTool: Tool<{ text: string }> = {
  name: 'log_expense',
  description: 'Kharcha likho (poora jumla). PKR.',
  args: 'text: string',
  schema: z.object({ text: z.string().min(2).max(500) }),
  async run({ text }, ctx) {
    const { ok: done, result } = await insertOnce(
      `${ctx.runId}:log_expense:${text}`,
      { runId: ctx.runId, tool: 'log_expense', effect: 'write' },
      async () => {
        const r = await logExpense(text);
        return r.ok ? { ok: true, result: r } : { ok: false, result: null, error: 'amount samajh nahi aaya' };
      },
    );

    if (!done || !result) return fail('log_expense', 'Amount samajh nahi aaya.');
    const r = result as { amount: number; category: string };
    return ok({
      tool: 'log_expense',
      effect: 'write',
      factLine: `Likh liya: Rs ${r.amount.toLocaleString('en-PK')} — ${r.category}`,
      numbers: [r.amount],
      entities: [r.category],
    });
  },
};

const monthSummaryTool: Tool<Record<string, never>> = {
  name: 'month_summary',
  description: 'Is mahine ka kharcha category-wise.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const summary = await monthSummary();
    return ok({ tool: 'month_summary', effect: 'read', factLine: summary });
  },
};

// ---------------------------------------------------------------------
// Generic tracking store
// ---------------------------------------------------------------------

const saveRecord: Tool<{ kind: string; data: Record<string, unknown>; note?: string }> = {
  name: 'save_record',
  description: 'Kisi bhi kind ki cheez mehfooz karo (kind=weight/mood/water..., data). Naya kind = naya naam.',
  args: 'kind: string, data: object, note?: string',
  schema: z.object({
    kind: z.string().min(1).max(40),
    data: z.record(z.string(), z.unknown()).default({}),
    note: z.string().max(500).optional(),
  }),
  async run({ kind, data, note }, ctx) {
    const payload = note ? { ...data, note } : data;
    const k = normaliseKind(kind);
    const { ok: done } = await insertOnce(
      `${ctx.runId}:save_record:${k}:${JSON.stringify(payload)}`,
      { runId: ctx.runId, tool: 'save_record', effect: 'write', target: k },
      async () => {
        const { error } = await db().from('records').insert({ kind: k, data: payload });
        return error ? { ok: false, result: null, error: error.message } : { ok: true, result: { kind: k } };
      },
    );
    return done
      ? ok({ tool: 'save_record', effect: 'write', factLine: `"${k}" mein likh diya.`, entities: [k], observation: JSON.stringify(payload).slice(0, 200) })
      : fail('save_record', 'Save nahi ho saka.');
  },
};

const findRecords: Tool<{ kind: string; limit: number }> = {
  name: 'find_records',
  description: 'Kisi kind ki purani entries dekho. Trend batane se pehle yahi.',
  args: 'kind: string, limit?: number (default 20)',
  schema: z.object({ kind: z.string().min(1).max(40), limit: z.number().int().min(1).max(100).default(20) }),
  async run({ kind, limit }) {
    const k = normaliseKind(kind);
    const { data, error } = await db()
      .from('records')
      .select('data, happened_at')
      .eq('kind', k)
      .order('happened_at', { ascending: false })
      .limit(limit);

    if (error) return fail('find_records', error.message);
    if (!data || data.length === 0) return ok({ tool: 'find_records', effect: 'read', factLine: `"${k}" ki koi entry nahi mili.`, numbers: [0] });
    return ok({
      tool: 'find_records',
      effect: 'read',
      factLine: `"${k}" ki ${data.length} entries.`,
      numbers: [data.length],
      observation: data.map((r) => `${whenText(r.happened_at as string)} — ${JSON.stringify(r.data)}`).join('\n'),
    });
  },
};

const listKinds: Tool<Record<string, never>> = {
  name: 'list_kinds',
  description: 'Kya kya track ho raha hai (ginti ke saath).',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const { data, error } = await db()
      .from('records')
      .select('kind, happened_at')
      .neq('kind', 'log')
      .neq('kind', 'refusal')
      .neq('kind', 'newsletter')
      .order('happened_at', { ascending: false })
      .limit(1000);

    if (error) return fail('list_kinds', error.message);
    if (!data || data.length === 0) return ok({ tool: 'list_kinds', effect: 'read', factLine: 'Abhi kisi cheez ka record nahi rakha ja raha.', numbers: [0] });

    const counts = new Map<string, { n: number; latest: string }>();
    for (const row of data) {
      const kind = String(row.kind);
      const seen = counts.get(kind);
      if (seen) seen.n++;
      else counts.set(kind, { n: 1, latest: row.happened_at as string });
    }

    return ok({
      tool: 'list_kinds',
      effect: 'read',
      factLine: `${counts.size} cheezein track ho rahi hain.`,
      numbers: [counts.size],
      observation: [...counts.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .map(([kind, info]) => `• ${kind} — ${info.n} entries, aakhri ${whenText(info.latest)}`)
        .join('\n'),
    });
  },
};

// ---------------------------------------------------------------------
// Coach: progress, learnings, reflection, podcasts
// ---------------------------------------------------------------------

const myProgress: Tool<Record<string, never>> = {
  name: 'my_progress',
  description: 'Asli surat-e-haal: completion rate, pending, rollover.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const summary = await contextSummary();
    return ok({ tool: 'my_progress', effect: 'read', factLine: summary });
  },
};

const saveLearningTool: Tool<{ text: string }> = {
  name: 'save_learning',
  description: 'Seekhi hui baat mehfooz karo (baad mein yaad dilayi jayegi).',
  args: 'text: string',
  schema: z.object({ text: z.string().min(3).max(2000) }),
  async run({ text }, ctx) {
    const { ok: done, result } = await insertOnce(
      `${ctx.runId}:save_learning:${text.slice(0, 80)}`,
      { runId: ctx.runId, tool: 'save_learning', effect: 'write' },
      async () => {
        const saved = await saveLearning(text);
        return saved ? { ok: true, result: { saved } } : { ok: false, result: null, error: 'nothing to save' };
      },
    );
    if (!done || !result) return fail('save_learning', 'Samajh nahi aaya kya save karna hai.');
    return ok({ tool: 'save_learning', effect: 'write', factLine: `Save ho gaya: ${(result as { saved: string }).saved}` });
  },
};

const askReflectionTool: Tool<Record<string, never>> = {
  name: 'ask_reflection',
  description: 'Podcast se pehle haal poocho (jab kitab/haal na diya ho), phir ruk jao.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run(_args, ctx) {
    await askReflection(ctx.to);
    return ok({
      tool: 'ask_reflection',
      effect: 'write',
      factLine: 'Sawal poochh liya. Ab user ke jawab ka intezaar hai.',
      observation: 'Sawal bhej diya. Abhi podcast MAT banao — user ke jawab ka intezaar karo.',
    });
  },
};

const makePodcast: Tool<{ request: string }> = {
  name: 'make_podcast',
  description: 'Kitab ka summary podcast voice bhejo (jab kitab/haal diya ho).',
  args: 'request: string (user ka poora jumla ya bataya hua haal)',
  schema: z.object({ request: z.string().min(2).max(2000) }),
  async run({ request }, ctx) {
    const named = await bookFromRequest(request);
    const result = await sendBookPodcast(request, named, ctx.to);
    const sent = result.startsWith('book podcast sent');
    return sent
      ? ok({ tool: 'make_podcast', effect: 'write', factLine: 'Podcast bhej diya.', observation: result })
      : ok({ tool: 'make_podcast', effect: 'none', factLine: 'Kitab choose nahi ho saki — thora aur batao.', observation: result });
  },
};

export const recordsTools: Tool<any>[] = [
  logExpenseTool,
  monthSummaryTool,
  saveRecord,
  findRecords,
  listKinds,
  myProgress,
  saveLearningTool,
  askReflectionTool,
  makePodcast,
];
