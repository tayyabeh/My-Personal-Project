/**
 * What happens when a message arrives.
 *
 * The pipeline:
 *   save + dedupe -> (transcribe if voice) -> classify intent -> route to
 *   a focused handler -> reply with what we understood.
 *
 * The reply always states what was understood, so a mistake costs you a
 * two-second correction instead of silently rotting in the database.
 */
import { messaging, type IncomingMessage } from '../messaging';
import { db } from '../supabase';
import { log } from '../logger';
import { transcriber, llm } from '../llm';
import { classifyIntent } from '../features/intent';
import {
  extractTasks,
  saveTasks,
  matchCompletion,
  completeTask,
  pendingSummary,
} from '../features/tasks';
import { pendingTasks, contextSummary } from '../context';

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

  throw new Error(`Could not save inbound message: ${error.message}`);
}

/** Store what Whisper heard, so the dashboard can show it later. */
async function saveTranscript(whatsappMessageId: string, transcript: string): Promise<void> {
  const { error } = await db()
    .from('messages')
    .update({ transcript, content: transcript })
    .eq('whatsapp_message_id', whatsappMessageId);

  if (error) log.error('Could not save transcript', { error: error.message });
}

// ---------------------------------------------------------------------
// Intent handlers
// ---------------------------------------------------------------------

async function handleAddTasks(text: string, to: string): Promise<void> {
  const result = await extractTasks(text);

  if (!result.ok) {
    log.error('Task extraction failed twice', { error: result.error });
    await messaging.sendText(
      "I couldn't make sense of that one. Could you say it again, a bit more slowly?",
      to,
    );
    return;
  }

  if (result.tasks.length === 0) {
    await messaging.sendText("I didn't catch any tasks in that. What do you need to get done?", to);
    return;
  }

  // Confident tasks get saved. Garbled ones are read back for confirmation
  // rather than written to the database as nonsense.
  const confident = result.tasks.filter((task) => !task.uncertain);
  const unsure = result.tasks.filter((task) => task.uncertain);

  const saved = await saveTasks(confident);

  const parts: string[] = [];
  if (saved.length > 0) {
    parts.push(`Added ${saved.length}:\n${saved.map((title) => `• ${title}`).join('\n')}`);
  }
  if (unsure.length > 0) {
    parts.push(
      `I wasn't sure about ${unsure.length > 1 ? 'these' : 'this'} — say yes and I'll add ${unsure.length > 1 ? 'them' : 'it'}:\n` +
        unsure.map((task) => `• ${task.title}?`).join('\n'),
    );
  }

  await messaging.sendText(parts.join('\n\n'), to);
}

async function handleCompleteTask(text: string, to: string): Promise<void> {
  const tasks = await pendingTasks();

  if (tasks.length === 0) {
    await messaging.sendText("You don't have anything pending right now.", to);
    return;
  }

  const match = await matchCompletion(text, tasks);

  if (!match) {
    await messaging.sendText(
      `I couldn't tell which one you meant. You have:\n${tasks
        .slice(0, 10)
        .map((task) => `• ${task.title}`)
        .join('\n')}`,
      to,
    );
    return;
  }

  await completeTask(match.id);

  const left = tasks.length - 1;
  await messaging.sendText(
    `Done: ${match.title}${left > 0 ? `\n${left} left today.` : '\nThat was the last one.'}`,
    to,
  );
}

async function handleOther(text: string, to: string): Promise<void> {
  // A short, context-aware conversational reply. Kept brief on purpose —
  // long replies on WhatsApp are unpleasant to read.
  const context = await contextSummary();

  const reply = await llm().complete(
    [
      {
        role: 'system',
        content:
          'You are a personal assistant on WhatsApp. Reply in two or three sentences at most. ' +
          'Be direct and warm, not chirpy. Never invent tasks or claim something was completed ' +
          'unless it appears in the context below.\n\n' +
          context,
      },
      { role: 'user', content: text },
    ],
    { temperature: 0.6, maxTokens: 400 },
  );

  await messaging.sendText(reply, to);
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

export async function handleIncoming(message: IncomingMessage): Promise<void> {
  const isNew = await claimMessage(message);
  if (!isNew) return;

  const to = message.from;
  let text = message.text ?? '';

  // Voice notes: fetch the audio, then transcribe it.
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
      await messaging.sendText(
        "I couldn't hear that clearly. Could you send it again, or type it?",
        to,
      );
      return;
    }
  }

  if (message.kind === 'unsupported' || text.trim() === '') {
    await messaging.sendText('I can read text and voice notes. Try one of those.', to);
    return;
  }

  const intent = await classifyIntent(text);
  log.info('Routing message', { intent });

  switch (intent) {
    case 'add_tasks':
      await handleAddTasks(text, to);
      break;
    case 'complete_task':
      await handleCompleteTask(text, to);
      break;
    case 'list_tasks':
      await messaging.sendText(await pendingSummary(), to);
      break;
    default:
      await handleOther(text, to);
  }
}
