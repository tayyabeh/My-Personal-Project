/**
 * What happens when a message arrives.
 *
 *   save + dedupe -> transcribe if voice -> load recent turns ->
 *   one agent loop over the flat tool list -> honest reply
 *
 * The orchestrator and its eight agents are gone. Routing is the tool
 * list now (lib/tools/index.ts), and the loop (lib/loop.ts) runs it.
 *
 * The old Promise.race against a 48s timeout is gone too: its loser kept
 * running and could still write to the DB after the user was told it
 * timed out. A real AbortController now cancels every in-flight fetch
 * when the deadline passes, and the run is recorded in `runs` for
 * exactly-once processing.
 */
import { messaging, type IncomingMessage } from '../messaging';
import { db } from '../supabase';
import { log } from '../logger';
import { transcriber } from '../llm';
import { runLoop } from '../loop';
import { recentTurns } from '../memory';
import { createRun, finishRun } from '../db/runs';
import { getPending, setPending } from '../state';
import { sendBookPodcast } from '../features/podcast';

/** Everything must finish inside this; Vercel kills the function at 60s. */
const DEADLINE_MS = 48_000;

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

  // A question we asked and are waiting on. Checked before the loop so the
  // answer is treated as an answer, not as a fresh request.
  const pending = await getPending();
  if (pending?.type === 'awaiting_reflection') {
    await setPending(null);
    log.info('Treating message as reflection answer');
    await sendBookPodcast(text, null, to);
    return;
  }

  // One run per message. `runs` carries its own UNIQUE on the WhatsApp id,
  // so even a caller that reaches here twice cannot process it twice.
  const runId = crypto.randomUUID();
  const claimed = await createRun({ id: runId, whatsappMessageId: message.whatsappMessageId, to, input: text });
  if (!claimed) {
    log.info('Run already claimed for this message', { id: message.whatsappMessageId });
    return;
  }

  const history = await recentTurns(message.whatsappMessageId);

  // Real cancellation. When the timer fires, every in-flight fetch a tool
  // started is aborted — the reasoning stops instead of running on in the
  // background and writing after the user was told it timed out.
  const controller = new AbortController();
  const deadline = Date.now() + DEADLINE_MS;
  const timeoutId = setTimeout(() => controller.abort(new Error('deadline exceeded')), DEADLINE_MS);

  try {
    const result = await runLoop({
      to,
      input: text,
      history,
      signal: controller.signal,
      deadline,
      runId,
    });

    log.info('Loop finished', { steps: result.steps.join(' -> ') || 'none' });
    await finishRun(runId, { status: 'done', reply: result.reply, steps: result.steps });

    // A tool that already sent something (a podcast voice note, the
    // reflection question) may have nothing left to say.
    if (result.reply.trim()) {
      // The reply send deliberately gets no signal: aborting the reasoning
      // must never stop us telling the user it was aborted.
      await messaging.sendText(result.reply, to);
    }
  } catch (error) {
    const aborted = controller.signal.aborted;
    const detail = error instanceof Error ? error.message : String(error);
    log.error('Loop threw', { aborted, error: detail.slice(0, 300) });
    await finishRun(runId, { status: aborted ? 'timeout' : 'failed', error: detail.slice(0, 300) });

    await messaging.sendText(
      aborted
        ? 'Isme waqt zyada lag raha hai. Thora simple bol kar dobara try karo, ya thori der baad.'
        : 'Kuch gadbad ho gayi meri taraf se. Dobara bhejo?',
      to,
    );
  } finally {
    clearTimeout(timeoutId);
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
