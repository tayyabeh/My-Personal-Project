/**
 * A single slot for "I asked you something and I'm waiting for the answer".
 *
 * Without this, the bot cannot hold a two-turn conversation: it would ask
 * "aaj kal kya soch rahe ho?" and then classify the reply as a task or
 * small talk, because nothing remembers a question was asked.
 *
 * One slot is enough — there is one user, and a second pending question
 * would be confusing rather than useful. Asking again overwrites.
 */
import { db } from './supabase';
import { log } from './logger';

export type PendingAction =
  | { type: 'awaiting_reflection'; askedAt: string }
  | { type: 'awaiting_book_choice'; options: string[]; askedAt: string };

/** How long a pending question stays live before it is ignored. */
const EXPIRY_MINUTES = 90;

export async function setPending(action: PendingAction | null): Promise<void> {
  const { error } = await db()
    .from('settings')
    .update({ pending_action: action, updated_at: new Date().toISOString() })
    .eq('id', 1);

  if (error) log.error('Could not save pending action', { error: error.message });
}

/**
 * Read the pending question, if there is one and it has not gone stale.
 *
 * Expiry matters: without it, answering "kuch nahi" three days later
 * would be read as the answer to a question long forgotten.
 */
export async function getPending(): Promise<PendingAction | null> {
  const { data, error } = await db()
    .from('settings')
    .select('pending_action')
    .eq('id', 1)
    .maybeSingle();

  if (error || !data?.pending_action) return null;

  const action = data.pending_action as PendingAction;
  const age = Date.now() - new Date(action.askedAt).getTime();

  if (age > EXPIRY_MINUTES * 60 * 1000) {
    await setPending(null);
    return null;
  }

  return action;
}
