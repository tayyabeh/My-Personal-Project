/**
 * Getting reliable structured data out of an open-source model.
 *
 * The strategy, in order of importance:
 *   1. Ask for JSON and turn on the provider's JSON mode.
 *   2. Validate the result with Zod — never trust the shape.
 *   3. If validation fails, retry ONCE with the error fed back in.
 *   4. If it fails twice, give up honestly. The caller asks the user to
 *      rephrase rather than guessing and saving nonsense.
 */
import type { ZodType } from 'zod';
import { llm, type Message } from './index';
import { log } from '../logger';

export type JsonResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Models sometimes wrap JSON in ```json fences despite being told not to.
 * Strip them rather than failing over something so trivial.
 */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

export async function completeJson<T>(
  schema: ZodType<T>,
  messages: Message[],
  opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<JsonResult<T>> {
  let conversation = [...messages];
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw: string;
    try {
      raw = await llm().complete(conversation, { json: true, ...opts });
    } catch (error) {
      // A network or rate-limit failure is not something a retry with a
      // corrected prompt will fix, so stop here.
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    try {
      const parsed = JSON.parse(stripFences(raw));
      const result = schema.safeParse(parsed);
      if (result.success) return { ok: true, data: result.data };

      lastError = result.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ');
    } catch (error) {
      lastError = `not valid JSON (${error instanceof Error ? error.message : String(error)})`;
    }

    log.warn('Model returned unusable JSON', { attempt, error: lastError });

    if (attempt === 1) {
      // Feed the failure back so the second attempt can correct itself.
      conversation = [
        ...messages,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content:
            `That response was rejected: ${lastError}. ` +
            `Reply again with ONLY valid JSON matching the required shape. No prose, no code fences.`,
        },
      ];
    }
  }

  return { ok: false, error: lastError };
}
