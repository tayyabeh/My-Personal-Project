/**
 * Conversation memory.
 *
 * The old handler passed a summary of tasks but never the actual previous
 * messages, so every turn started from nothing. That is why "uske andar
 * kya likha hai" got a reply asking for a screenshot — the word "uske"
 * had no referent anywhere in the prompt.
 *
 * Kept short deliberately. Groq's free tier limits tokens per minute far
 * more tightly than requests, and long histories are what will rate-limit
 * this, not message volume.
 */
import { db } from '../supabase';
import type { Turn } from './types';

const MAX_TURNS = 8;
const MAX_CHARS_PER_TURN = 500;
/** Older than this and it is a new conversation, not a continuation. */
const STALE_MINUTES = 120;

export async function recentTurns(excludeMessageId?: string): Promise<Turn[]> {
  const since = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();

  const { data, error } = await db()
    .from('messages')
    .select('direction, content, whatsapp_message_id, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(MAX_TURNS + 2);

  if (error || !data) return [];

  return data
    .filter((row) => row.whatsapp_message_id !== excludeMessageId)
    .filter((row) => typeof row.content === 'string' && row.content.trim() !== '')
    .slice(0, MAX_TURNS)
    .reverse()
    .map((row) => ({
      role: row.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
      content: String(row.content).slice(0, MAX_CHARS_PER_TURN),
    }));
}
