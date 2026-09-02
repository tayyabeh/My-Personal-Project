/**
 * The write-once ledger.
 *
 * Neither an ordinary DB write (a task, a reminder, an expense) nor a
 * Google API call has a natural unique key of its own —
 * `messages.whatsapp_message_id` is the only column anywhere in this
 * codebase that ever gave a write idempotency "for free". insertOnce()
 * gives every other write the same guarantee, by claiming a key in
 * `write_ops` BEFORE the real effect runs. If the same key is claimed
 * again — the same WhatsApp message reprocessed, or a tool called twice
 * by mistake — the recorded outcome is replayed instead of the effect
 * running a second time. This is what stops a double-fired reminder from
 * becoming two calendar events, or a retried expense from being logged
 * twice.
 */
import { db } from '../supabase';
import type { Effect } from '../tools/types';

export interface WriteOpOutcome<T> {
  ok: boolean;
  result: T;
  target?: string;
  error?: string;
}

export interface WriteOpReplay<T> {
  /** false: a prior claim already ran `perform`; this call did not run it again. */
  fresh: boolean;
  ok: boolean;
  result: T | null;
  error?: string;
}

export async function insertOnce<T>(
  key: string,
  meta: { runId: string; tool: string; effect: Effect; target?: string },
  perform: () => Promise<WriteOpOutcome<T>>,
): Promise<WriteOpReplay<T>> {
  const { error: claimError } = await db()
    .from('write_ops')
    .insert({
      idempotency_key: key,
      run_id: meta.runId,
      tool: meta.tool,
      effect: meta.effect,
      target: meta.target ?? null,
    });

  if (claimError) {
    if (claimError.code !== '23505') {
      throw new Error(`Could not claim write_op ${key}: ${claimError.message}`);
    }

    // Someone already claimed this key. Read back what really happened
    // and report that, rather than attempting the effect a second time.
    const { data, error } = await db()
      .from('write_ops')
      .select('ok, result, error')
      .eq('idempotency_key', key)
      .maybeSingle();

    if (error || !data) {
      throw new Error(
        `write_op ${key} was claimed but could not be read back: ${error?.message ?? 'no row'}`,
      );
    }

    return {
      fresh: false,
      ok: Boolean(data.ok),
      result: (data.result as T) ?? null,
      error: (data.error as string | null) ?? undefined,
    };
  }

  try {
    const outcome = await perform();
    await db()
      .from('write_ops')
      .update({
        ok: outcome.ok,
        result: outcome.result ?? {},
        error: outcome.error ?? null,
        target: outcome.target ?? meta.target ?? null,
      })
      .eq('idempotency_key', key);

    return { fresh: true, ok: outcome.ok, result: outcome.result, error: outcome.error };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db().from('write_ops').update({ ok: false, error: message }).eq('idempotency_key', key);
    throw error;
  }
}
