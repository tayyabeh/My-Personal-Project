/**
 * Learnings, and spaced repetition.
 *
 * Something you noted once and never saw again was not learned. These
 * come back at 3 days, 1 week, 2 weeks and 1 month — the standard
 * expanding intervals — and then stop, because a fifth reminder about
 * the same note is nagging rather than teaching.
 */
import { z } from 'zod';
import { completeJson } from '../llm/json';
import { db } from '../supabase';
import { messaging } from '../messaging';
import { log } from '../logger';

/** Days after capture at which a note resurfaces. */
const INTERVALS_DAYS = [3, 7, 14, 30];

const LearningSchema = z.object({
  content: z.string().min(3).max(500),
  topics: z.array(z.string().max(30)).max(5).default([]),
});

export async function saveLearning(text: string): Promise<string | null> {
  const result = await completeJson(
    LearningSchema,
    [
      {
        role: 'system',
        content:
          'Extract the thing the person learned, written so it still makes sense months ' +
          'later with no surrounding context.\n\n' +
          'Reply ONLY with JSON: {"content":"...","topics":["..."]}\n\n' +
          'Rewrite it as a clear standalone statement. Add 1-3 short lowercase topic tags.',
      },
      { role: 'user', content: 'today I learned that postgres unique constraints can be used for dedupe' },
      {
        role: 'assistant',
        content: JSON.stringify({
          content:
            'A UNIQUE constraint in Postgres can be used for deduplication: the second insert fails with error 23505, which tells you the item was already processed.',
          topics: ['postgres', 'databases'],
        }),
      },
      { role: 'user', content: text },
    ],
    { temperature: 0.2, maxTokens: 500 },
  );

  if (!result.ok) return null;

  const { error } = await db().from('learnings').insert({
    content: result.data.content,
    topics: result.data.topics,
  });

  if (error) throw new Error(`Could not save learning: ${error.message}`);
  return result.data.content;
}

/**
 * Resurface anything that is due.
 *
 * A note is due when the time since it was last shown has passed the
 * interval for its resurface count. After four showings it retires.
 */
export async function resurfaceDue(): Promise<string> {
  const { data, error } = await db()
    .from('learnings')
    .select('id, content, created_at, last_resurfaced, resurface_count')
    .lt('resurface_count', INTERVALS_DAYS.length);

  if (error) throw new Error(error.message);

  const now = Date.now();
  const due = (data ?? []).filter((row) => {
    const count = row.resurface_count ?? 0;
    const since = new Date((row.last_resurfaced as string) ?? (row.created_at as string)).getTime();
    const intervalMs = INTERVALS_DAYS[count] * 24 * 60 * 60 * 1000;
    return now - since >= intervalMs;
  });

  if (due.length === 0) return 'nothing due';

  // One per run. A batch of five old notes at once gets skimmed and
  // forgotten, which defeats the point.
  const item = due[0];

  if (!(await messaging.windowIsOpen())) {
    log.info('Learning resurface skipped, window closed');
    return 'skipped: window closed';
  }

  await messaging.sendText(`Remember this?\n\n${item.content}`);

  await db()
    .from('learnings')
    .update({
      last_resurfaced: new Date().toISOString(),
      resurface_count: (item.resurface_count ?? 0) + 1,
    })
    .eq('id', item.id);

  return `resurfaced 1 of ${due.length} due`;
}
