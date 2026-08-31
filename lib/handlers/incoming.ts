/**
 * What happens when a message arrives.
 *
 *   save + dedupe -> transcribe if voice -> load recent turns ->
 *   orchestrator picks an agent -> agent runs its tools -> reply
 *
 * The intent switch that used to live here is gone. It could pick only
 * one label and run one function, which is why it could not follow up on
 * "ab inko calendar pe daal do" and instead replied with a promise it
 * never kept. Routing now lives in lib/agents/orchestrator.ts and the
 * work lives in the agents themselves.
 */
import { messaging, type IncomingMessage } from '../messaging';
import { db } from '../supabase';
import { log } from '../logger';
import { transcriber } from '../llm';
import { handle } from '../agents/orchestrator';
import { recentTurns } from '../agents/memory';
import { getPending, setPending } from '../state';
import { sendBookPodcast } from '../features/podcast';

/**
 * Save the inbound message, and tell the caller whether this is the
 * first time we have seen it.
 *
 * Meta retries webhooks aggressively if we are slow, so the same message
 * can arrive several times. The UNIQUE constraint on whatsapp_message_id
 * means the second insert fails with Postgres 23505, and that is our
 * signal to stop.
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

  throw new Error(`Could not save inbound message: ${error.message}`);
}

/** Store what Whisper heard, so history and the dashboard both show it. */
async function saveTranscript(whatsappMessageId: string, transcript: string): Promise<void> {
  const { error } = await db()
    .from('messages')
    .update({ transcript, content: transcript })
    .eq('whatsapp_message_id', whatsappMessageId);

  if (error) log.error('Could not save transcript', { error: error.message });
}

export async function handleIncoming(message: IncomingMessage): Promise<void> {
  const isNew = await claimMessage(message);
  if (!isNew) return;

  const to = message.from;
  let text = message.text ?? '';

  if (message.kind === 'audio' && message.audioMediaId) {
    try {
      const { buffer, mimeType } = await messaging.downloadMedia(message.audioMediaId);
      text = await transcriber().transcribe(buffer, mimeType);
      await saveTranscript(message.whatsappMessageId, text);
      log.info('Transcribed voice note', { chars: text.length });
    } catch (error) {
      log.error('Transcription failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      await messaging.sendText('Awaz saaf nahi aayi. Dobara bhejo ya likh do?', to);
      return;
    }
  }

  if (message.kind === 'unsupported' || text.trim() === '') {
    await messaging.sendText('Text ya voice note bhejo.', to);
    return;
  }

  // A question we asked and are waiting on. Checked before routing so the
  // answer is treated as an answer, not as a fresh request.
  const pending = await getPending();
  if (pending?.type === 'awaiting_reflection') {
    await setPending(null);
    log.info('Treating message as reflection answer');
    await sendBookPodcast(text, null, to);
    return;
  }

  const history = await recentTurns(message.whatsappMessageId);

  /**
   * Race the pipeline against the clock.
   *
   * Checking a deadline between steps is not enough — a single step can
   * block past it, and Vercel then kills the function at 60 seconds. A
   * killed function sends nothing, which to the user is identical to
   * being ignored. Racing guarantees a reply goes out even when the work
   * itself is still stuck.
   */
  const result = await Promise.race([
    handle({
      to,
      input: text,
      history,
      say: (interim: string) => messaging.sendText(interim, to),
    }),
    new Promise<{ reply: string; steps: string[] }>((resolve) =>
      setTimeout(
        () =>
          resolve({
            reply:
              'Isme waqt zyada lag raha hai. Thora simple bol kar dobara try karo, ' +
              'ya thori der baad.',
            steps: ['timed-out'],
          }),
        48_000,
      ),
    ),
  ]);

  log.info('Agent finished', { steps: result.steps.join(' -> ') || 'none' });

  // An agent whose tool already sent something (a podcast voice note, the
  // reflection question) may have nothing left to say.
  if (result.reply.trim()) {
    await messaging.sendText(result.reply, to);
  }
}

/**
 * The public entry point.
 *
 * Wraps the whole pipeline so that a thrown error still produces a
 * message. When both LLM providers were out of quota, the throw
 * propagated past every handler and nothing was sent — the user saw
 * silence, which reads as being ignored rather than as a temporary
 * limit. Any failure now says something true.
 */
export async function handleIncomingSafely(message: IncomingMessage): Promise<void> {
  try {
    await handleIncoming(message);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.error('Handler failed, sending a plain reply', { error: detail.slice(0, 300) });

    const rateLimited = /rate limit|429|quota|exceeded/i.test(detail);

    try {
      await messaging.sendText(
        rateLimited
          ? 'Aaj AI ki free limit khatam ho gayi hai. Thori der baad ya kal dobara bolo.'
          : 'Kuch gadbad ho gayi meri taraf se. Dobara bhejo?',
        message.from,
      );
    } catch (sendError) {
      // Nothing left to try; at least record why the user heard nothing.
      log.error('Could not even send the failure notice', {
        error: sendError instanceof Error ? sendError.message : String(sendError),
      });
    }
  }
}
