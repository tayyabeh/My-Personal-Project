/**
 * Records agent: track anything, without anyone writing new code.
 *
 * Tayyab wanted an assistant that, when asked to start tracking something
 * new, could set that up itself instead of coming back to a developer.
 *
 * The tempting version of that is giving the model DDL and letting it
 * create tables. That is a bad trade on a single database with no
 * point-in-time recovery: one wrong statement takes the tasks, the
 * message history and everything else with it, permanently.
 *
 * A jsonb store gets the same freedom safely. A new "kind" is just a
 * string nobody used before — no migration, no deploy, and no statement
 * that can destroy what already exists. Asked to track weight, mood,
 * water, books, spending on chai, the agent simply starts writing records
 * of that kind and can read them back.
 *
 * What it still cannot do is reach the outside world. Prayer times needed
 * an API call, and no amount of storage substitutes for the code that
 * makes that call. Storage is the half that can be automated.
 */
import { z } from 'zod';
import { db } from '../supabase';
import { TIMEZONE } from '../env';
import type { Agent, Tool } from './types';

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: TIMEZONE,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Kind names are normalised so "Weight" and "weight" are the same thing. */
function normaliseKind(kind: string): string {
  return kind.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 40);
}

const saveRecord: Tool<{ kind: string; data: Record<string, unknown>; note?: string }> = {
  name: 'save_record',
  description:
    'Kisi bhi qism ki cheez mehfooz karo. "kind" us cheez ka naam hai (weight, mood, ' +
    'water, chai_kharcha — jo bhi). Naya kind banane ke liye kuch karna nahi parta, bas ' +
    'naya naam likh do. "data" mein jo bhi values chahiye daal do.',
  args: 'kind: string, data: object, note?: string',
  schema: z.object({
    kind: z.string().min(1).max(40),
    data: z.record(z.string(), z.unknown()).default({}),
    note: z.string().max(500).optional(),
  }),
  async run({ kind, data, note }) {
    const payload = note ? { ...data, note } : data;

    const { error } = await db()
      .from('records')
      .insert({ kind: normaliseKind(kind), data: payload });

    if (error) return `FAIL: ${error.message}`;
    return `"${normaliseKind(kind)}" mein likh diya: ${JSON.stringify(payload).slice(0, 200)}`;
  },
};

const findRecords: Tool<{ kind: string; limit?: number }> = {
  name: 'find_records',
  description:
    'Kisi kind ki purani entries dekho, nayi se purani tarteeb mein. Trend ya hisab ' +
    'batane se pehle yahi chalao.',
  args: 'kind: string, limit?: number (default 20)',
  schema: z.object({
    kind: z.string().min(1).max(40),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  async run({ kind, limit }) {
    const { data, error } = await db()
      .from('records')
      .select('data, happened_at')
      .eq('kind', normaliseKind(kind))
      .order('happened_at', { ascending: false })
      .limit(limit);

    if (error) return `FAIL: ${error.message}`;
    if (!data || data.length === 0) return `"${normaliseKind(kind)}" ki koi entry nahi mili.`;

    return data
      .map((r) => `${when(r.happened_at as string)} — ${JSON.stringify(r.data)}`)
      .join('\n');
  },
};

const listKinds: Tool<Record<string, never>> = {
  name: 'list_kinds',
  description:
    'Ab tak kis kis cheez ka record rakha ja raha hai, aur har ek ki kitni entries hain.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    // Supabase's REST layer has no GROUP BY, so count in code. The volume
    // here is one person's notes, not analytics data.
    const { data, error } = await db()
      .from('records')
      .select('kind, happened_at')
      .order('happened_at', { ascending: false })
      .limit(1000);

    if (error) return `FAIL: ${error.message}`;
    if (!data || data.length === 0) return 'Abhi kisi cheez ka record nahi rakha ja raha.';

    const counts = new Map<string, { n: number; latest: string }>();
    for (const row of data) {
      const kind = String(row.kind);
      const seen = counts.get(kind);
      if (seen) seen.n++;
      else counts.set(kind, { n: 1, latest: row.happened_at as string });
    }

    return [...counts.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([kind, info]) => `• ${kind} — ${info.n} entries, aakhri ${when(info.latest)}`)
      .join('\n');
  },
};

export const recordsAgent: Agent = {
  name: 'records',
  description:
    'Kisi bhi nayi cheez ka hisab rakhta hai bina kuch banaye — wazan, mood, paani, ' +
    'kitabein, koi bhi cheez jo Tayyab track karna chahe. Purani entries nikaal kar ' +
    'trend bhi bata sakta hai.',
  instructions:
    '- Naya kind banane ke liye ijazat maangne ki zaroorat nahi. Naam chuno aur likh do.\n' +
    '- Kind ka naam chhota aur seedha rakho: weight, mood, water, sleep.\n' +
    '- Trend ya total batane se PEHLE find_records chalao. Apni yaadasht se koi number ' +
    'mat banao — jo entries mili wahi sach hain.\n' +
    '- Agar user pooche "kya kya track ho raha hai" to list_kinds.\n' +
    '- Ye store sirf data rakhta hai. Agar kisi cheez ke liye bahar se maloomat chahiye ' +
    '(kisi website ya API se), to wo yahan nahi ho sakta — saaf keh do.',
  tools: [saveRecord, findRecords, listKinds] as unknown as Tool<never>[],
  maxSteps: 4,
};
