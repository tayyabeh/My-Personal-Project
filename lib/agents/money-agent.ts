/**
 * Money agent. Small on purpose — it exists to show that adding an agent
 * is one file, and to keep expenses out of the tasks agent's way.
 */
import { z } from 'zod';
import { logExpense, monthSummary } from '../features/expenses';
import type { Agent, Tool } from './types';

const spend: Tool<{ text: string }> = {
  name: 'log_expense',
  description: 'Kharcha likho. User ka poora jumla do, amount aur category main nikaal lunga.',
  args: 'text: string',
  schema: z.object({ text: z.string().min(2).max(500) }),
  async run({ text }) {
    const result = await logExpense(text);
    return result.ok
      ? `Likh liya: Rs ${result.amount.toLocaleString('en-PK')} — ${result.category}`
      : 'FAIL: amount samajh nahi aaya.';
  },
};

const summary: Tool<Record<string, never>> = {
  name: 'month_summary',
  description: 'Is mahine ka kul kharcha, category ke hisab se.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    return monthSummary();
  },
};

export const moneyAgent: Agent = {
  name: 'money',
  description: 'Kharche likhta hai aur mahine ka hisab deta hai. Currency PKR.',
  instructions: '- Jo tool bataye wahi raqam batao. Apni taraf se jama-tafreeq mat karo.',
  tools: [spend, summary] as unknown as Tool<never>[],
  maxSteps: 2,
};
