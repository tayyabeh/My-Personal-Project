/**
 * Step one of every message: work out what you want.
 *
 * Small models are bad at "decide between many actions and also do the
 * action" in one call. So this prompt does exactly one thing — pick a
 * label — and the handler then routes to a focused prompt for that label.
 *
 * Note what is NOT here: summarising a link. A message containing a URL
 * is detected in code with a regex, because that is a fact about the
 * text rather than a judgement, and code does not get it wrong.
 */
import { z } from 'zod';
import { completeJson } from '../llm/json';

export const IntentSchema = z.object({
  intent: z.enum([
    'add_tasks',
    'complete_task',
    'list_tasks',
    'add_reminder',
    'web_search',
    'email',
    'podcast',
    'log_expense',
    'expense_summary',
    'log_learning',
    'drive',
    'other',
  ]),
});

export type Intent = z.infer<typeof IntentSchema>['intent'];

const SYSTEM = `You classify a personal assistant message into exactly one intent.

Reply ONLY with JSON: {"intent": "..."} where intent is one of:
- "add_tasks"       : telling you things they need to do
- "complete_task"   : reporting something is finished
- "list_tasks"      : asking what they have to do
- "add_reminder"    : wants reminding at a SPECIFIC time or date
- "web_search"      : a factual question needing outside information
- "email"           : anything about their inbox, emails or newsletters
- "podcast"         : feeling low or down, or asking for a voice message
- "log_expense"     : reporting money they spent
- "expense_summary" : asking how much they have spent
- "log_learning"    : reporting something they learned or want to remember
- "drive"           : asking about a file or document in their Drive
- "other"           : small talk, or anything else

"add_reminder" only when a time or day is named; otherwise "add_tasks".

IMPORTANT — "email" vs "web_search". This person reads news and updates
through email newsletters. So a request to find news, updates, digests or
anything "from today" means their INBOX, even when they say the word
"search". Choose "web_search" only for a general fact about the world that
could not be sitting in their mail, such as a definition or a score.

Pick "other" when unsure. Do not guess.`;

/** Few-shot examples. These help far more than extra instructions do. */
const EXAMPLES: Array<[string, Intent]> = [
  ['today I need to finish the proposal and call my brother', 'add_tasks'],
  ['done with the proposal', 'complete_task'],
  ['proposal ho gaya', 'complete_task'],
  ['what do I have left', 'list_tasks'],
  ['remind me to call the bank Thursday at 3pm', 'add_reminder'],
  ['kal subah 8 baje dawai leni hai yaad dilana', 'add_reminder'],
  ['I should buy milk at some point', 'add_tasks'],
  ['what is the capital of France', 'web_search'],
  ['who won the match yesterday', 'web_search'],
  ['search all AI updates for today', 'email'],
  ['what needs my reply today', 'email'],
  ['any emails from the bank this week', 'email'],
  ['I am feeling low', 'podcast'],
  ['give me a podcast', 'podcast'],
  ['dil nahi lag raha aaj', 'podcast'],
  ['spent 2000 on groceries', 'log_expense'],
  ['petrol mein 3.5k lag gaye', 'log_expense'],
  ['how much did I spend this month', 'expense_summary'],
  ['today I learned that postgres unique constraints can dedupe inserts', 'log_learning'],
  ['note this: opus is the codec whatsapp needs', 'log_learning'],
  ['find my file about the client proposal', 'drive'],
  ['summarise the budget spreadsheet in my drive', 'drive'],
  ['how are you', 'other'],
  ['thanks', 'other'],
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
