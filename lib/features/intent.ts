/**
 * Step one of every message: work out what you want.
 *
 * Small models are bad at "decide between many actions and also do the
 * action" in one call. So this prompt does exactly one thing — pick a
 * label — and the handler then routes to a focused prompt for that label.
 */
import { z } from 'zod';
import { completeJson } from '../llm/json';

export const IntentSchema = z.object({
  intent: z.enum(['add_tasks', 'complete_task', 'list_tasks', 'other']),
});

export type Intent = z.infer<typeof IntentSchema>['intent'];

const SYSTEM = `You classify a personal assistant message into exactly one intent.

Reply ONLY with JSON: {"intent": "..."} where intent is one of:
- "add_tasks"     : the user is telling you things they need to do
- "complete_task" : the user is reporting something is finished
- "list_tasks"    : the user is asking what they have to do
- "other"         : anything else (questions, chat, unclear)

Pick "other" when you are unsure. Do not guess between the first three.`;

/** Few-shot examples. These help far more than extra instructions do. */
const EXAMPLES: Array<[string, Intent]> = [
  ['today I need to finish the proposal and call my brother', 'add_tasks'],
  ['done with the proposal', 'complete_task'],
  ['finished the gym thing', 'complete_task'],
  ['what do I have today?', 'list_tasks'],
  ['whats pending', 'list_tasks'],
  ['remind me to buy milk tomorrow', 'add_tasks'],
  ['how are you', 'other'],
  ['what is the capital of France', 'other'],
];

export async function classifyIntent(text: string): Promise<Intent> {
  const messages = [
    { role: 'system' as const, content: SYSTEM },
    ...EXAMPLES.flatMap(([input, intent]) => [
      { role: 'user' as const, content: input },
      { role: 'assistant' as const, content: JSON.stringify({ intent }) },
    ]),
    { role: 'user' as const, content: text },
  ];

  const result = await completeJson(IntentSchema, messages, { temperature: 0, maxTokens: 200 });

  // Falling back to 'other' is the safe default: it replies conversationally
  // instead of silently writing wrong data to the database.
  return result.ok ? result.data.intent : 'other';
}
