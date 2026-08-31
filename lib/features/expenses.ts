/**
 * Expense logging. "Spent 2000 on groceries."
 *
 * Currency is PKR throughout — there is no conversion and no other
 * currency, which keeps this simple and correct.
 */
import { z } from 'zod';
import { completeJson } from '../llm/json';
import { db } from '../supabase';

const CATEGORIES = [
  'food',
  'groceries',
  'transport',
  'bills',
  'shopping',
  'health',
  'family',
  'entertainment',
  'other',
] as const;

const ExpenseSchema = z.object({
  amount: z.number().positive().max(100_000_000),
  category: z.enum(CATEGORIES),
  description: z.string().max(120).default(''),
});

export async function logExpense(
  text: string,
): Promise<{ ok: true; amount: number; category: string } | { ok: false }> {
  const result = await completeJson(
    ExpenseSchema,
    [
      {
        role: 'system',
        content:
          'Extract a single expense from the message.\n\n' +
          'Reply ONLY with JSON: {"amount":<number>,"category":"...","description":"..."}\n\n' +
          `Category must be one of: ${CATEGORIES.join(', ')}.\n` +
          'Amounts are in Pakistani Rupees. "2k" means 2000, "1.5k" means 1500, ' +
          '"15 hundred" means 1500. Never include a currency symbol in the number.',
      },
      { role: 'user', content: 'spent 2000 on groceries' },
      {
        role: 'assistant',
        content: JSON.stringify({ amount: 2000, category: 'groceries', description: 'Groceries' }),
      },
      { role: 'user', content: 'petrol mein 3.5k lag gaye' },
      {
        role: 'assistant',
        content: JSON.stringify({ amount: 3500, category: 'transport', description: 'Petrol' }),
      },
      { role: 'user', content: text },
    ],
    { temperature: 0, maxTokens: 300 },
  );

  if (!result.ok) return { ok: false };

  const { error } = await db().from('expenses').insert({
    amount: result.data.amount,
    category: result.data.category,
    description: result.data.description || null,
  });

  if (error) throw new Error(`Could not save expense: ${error.message}`);
  return { ok: true, amount: result.data.amount, category: result.data.category };
}

/** This month's spending, broken down by category. */
export async function monthSummary(): Promise<string> {
  const firstOfMonth = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' }).slice(0, 8) + '01';

  const { data, error } = await db()
    .from('expenses')
    .select('amount, category')
    .gte('spent_on', firstOfMonth);

  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return 'Is mahine kuch log nahi hua.';

  const totals = new Map<string, number>();
  let total = 0;
  for (const row of data) {
    const amount = Number(row.amount) || 0;
    total += amount;
    totals.set(row.category, (totals.get(row.category) ?? 0) + amount);
  }

  const format = (n: number) => `Rs ${n.toLocaleString('en-PK')}`;
  const lines = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category, amount]) => `• ${category}: ${format(amount)}`);

  return `Is mahine: ${format(total)}\n\n${lines.join('\n')}`;
}
