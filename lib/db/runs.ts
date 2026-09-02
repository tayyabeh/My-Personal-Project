/**
 * The run ledger — one row per WhatsApp message the loop actually
 * processed.
 *
 * `messages.whatsapp_message_id` already stops the same webhook body from
 * being handled twice. This is defense in depth on top of that: `runs`
 * carries its own UNIQUE constraint on the same id, so the run itself —
 * not just the inbound message row — is provably exactly-once, and
 * `runId` gives every Receipt and write_ops row in a turn one thing to
 * point back to.
 */
import { db } from '../supabase';
import { log } from '../logger';

/**
 * Claim a run. Returns false if this WhatsApp message was already
 * claimed by an earlier run — the caller should stop, not reprocess.
 */
export async function createRun(input: {
  id: string;
  whatsappMessageId: string;
  to: string;
  input: string;
}): Promise<boolean> {
  const { error } = await db()
    .from('runs')
    .insert({
      id: input.id,
      whatsapp_message_id: input.whatsappMessageId,
      to_number: input.to,
      input: input.input,
    });

  if (!error) return true;
  if (error.code === '23505') return false;
  throw new Error(`Could not create run: ${error.message}`);
}

export async function finishRun(
  id: string,
  outcome: {
    status: 'done' | 'failed' | 'timeout';
    reply?: string;
    steps?: string[];
    error?: string;
  },
): Promise<void> {
  const { error } = await db()
    .from('runs')
    .update({
      status: outcome.status,
      reply: outcome.reply ?? null,
      steps: outcome.steps ?? [],
      error: outcome.error ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) log.error('Could not finish run', { id, error: error.message });
}
