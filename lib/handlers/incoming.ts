/**
 * What happens when a message arrives.
 *
 * Right now this is deliberately a plain echo — Phase 1, step 1 is only
 * about proving the WhatsApp round trip works. Task extraction and
 * completion matching get plugged in here in the next steps.
 */
import { messaging, type IncomingMessage } from '../messaging';
import { db } from '../supabase';
import { log } from '../logger';

/**
 * Save the inbound message, and tell the caller whether this is the
 * first time we have seen it.
 *
 * This is the deduplication step. Meta retries webhooks aggressively if
 * we are slow to respond, so the same message can arrive several times.
 * The messages table has a UNIQUE constraint on whatsapp_message_id, so
 * the second insert fails with Postgres error 23505 and we know to stop.
 */
async function claimMessage(message: IncomingMessage): Promise<boolean> {
  const { error } = await db().from('messages').insert({
    direction: 'inbound',
    content: message.text ?? null,
    was_voice: message.kind === 'audio',
    whatsapp_message_id: message.whatsappMessageId,
    created_at: message.sentAt.toISOString(),
  });

  if (!error) return true;

  if (error.code === '23505') {
    log.info('Duplicate webhook ignored', { id: message.whatsappMessageId });
    return false;
  }

  // A real database problem. Surface it rather than silently dropping.
  throw new Error(`Could not save inbound message: ${error.message}`);
}

export async function handleIncoming(message: IncomingMessage): Promise<void> {
  const isNew = await claimMessage(message);
  if (!isNew) return;

  log.info('Handling message', {
    id: message.whatsappMessageId,
    kind: message.kind,
  });

  switch (message.kind) {
    case 'text':
      await messaging.sendText(`got it: "${message.text}"`, message.from);
      break;

    case 'audio':
      // Step 2 replaces this with: download -> Whisper -> reply with the transcript.
      await messaging.sendText(
        'got it — voice note received. Transcription lands in step 2.',
        message.from,
      );
      break;

    default:
      await messaging.sendText(
        'I can only read text and voice notes right now. Try sending one of those.',
        message.from,
      );
  }
}
