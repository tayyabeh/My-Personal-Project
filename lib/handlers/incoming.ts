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
import { extractReminder, saveReminder, humanTime } from '../features/reminders';
import { answerWithSources } from '../features/search';
import { needsReply, topicDigest } from '../features/email';
import { sendPodcast } from '../features/podcast';
import { logExpense, monthSummary } from '../features/expenses';
import { saveLearning } from '../features/learnings';
import { findUrl, summariseLink } from '../features/links';
import { searchDrive } from '../features/drive';

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

async function handleAddReminder(text: string, to: string): Promise<void> {
  const parsed = await extractReminder(text);

  if (!parsed) {
    await messaging.sendText(
      "I couldn't work out when you meant. Try something like \"remind me to call the bank on Thursday at 3pm\".",
      to,
    );
    return;
  }

  const { calendarError } = await saveReminder(parsed.title, parsed.when);

  const lines = [
    `Reminder set: ${parsed.title}`,
    humanTime(parsed.when),
    "I'll message you 5 minutes before.",
  ];

  // The reminder is saved either way; only the calendar copy can fail.
  if (calendarError === 'NOT_CONNECTED') {
    lines.push('', "(Not in Google Calendar yet — your Google account isn't connected.)");
  } else if (calendarError) {
    lines.push('', '(Saved here, but Google Calendar rejected it.)');
  } else {
    lines.push('Added to your Google Calendar too.');
  }

  await messaging.sendText(lines.join('\n'), to);
}

async function handleEmail(text: string, to: string): Promise<void> {
  try {
    // "what needs my reply" is a different job from "summarise my AI
    // newsletters", so they get different prompts and different searches.
    const wantsReplyList = /needs?\s+(my\s+)?(reply|response|answer)|reply\s+to|jawab/i.test(text);
    const answer = wantsReplyList ? await needsReply() : await topicDigest(text);
    await messaging.sendText(answer, to);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'NOT_CONNECTED') {
      await messaging.sendText(
        "Your Google account isn't connected yet, so I can't read your inbox. Open the " +
          'connect link on your dashboard to link it.',
        to,
      );
      return;
    }
    log.error('Email feature failed', { error: message });
    await messaging.sendText("I couldn't read your inbox just now.", to);
  }
}

async function handleExpense(text: string, to: string): Promise<void> {
  const result = await logExpense(text);
  if (!result.ok) {
    await messaging.sendText(
      "I couldn't work out the amount. Try something like \"spent 2000 on groceries\".",
      to,
    );
    return;
  }
  await messaging.sendText(
    `Logged Rs ${result.amount.toLocaleString('en-PK')} — ${result.category}.`,
    to,
  );
}

async function handleLearning(text: string, to: string): Promise<void> {
  const saved = await saveLearning(text);
  if (!saved) {
    await messaging.sendText("I couldn't quite capture that. Say it once more?", to);
    return;
  }
  await messaging.sendText(
    `Saved:\n${saved}\n\nI'll bring this back in 3 days, then a week, 2 weeks and a month.`,
    to,
  );
}

async function handleDrive(text: string, to: string): Promise<void> {
  try {
    await messaging.sendText(await searchDrive(text), to);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'NOT_CONNECTED') {
      await messaging.sendText(
        "Your Google account isn't connected yet, so I can't reach your Drive.",
        to,
      );
      return;
    }
    log.error('Drive feature failed', { error: message });
    await messaging.sendText("I couldn't search your Drive just now.", to);
  }
}

async function handleOther(text: string, to: string, wasVoice: boolean): Promise<void> {
  // A short, context-aware conversational reply. Kept brief on purpose —
  // long replies on WhatsApp are unpleasant to read.
  const context = await contextSummary();

  const reply = await llm().complete(
    [
      {
        role: 'system',
        content:
          "You are Tayyab's personal assistant on WhatsApp.\n\n" +
          'IMPORTANT — what you can actually do. Never deny these:\n' +
          '- You CAN hear voice notes. They are transcribed for you automatically, so a ' +
          'voice message reaches you as text. Never say you cannot hear audio or that you ' +
          'are text-only; that is false and confusing.\n' +
          '- You can record tasks, mark them done, and list what is pending.\n\n' +
          'Style: reply in two or three sentences at most. Direct and warm, not chirpy. ' +
          'Never invent tasks or claim something was completed unless it appears in the ' +
          'context below.\n\n' +
          (wasVoice ? 'This message arrived as a voice note and was transcribed.\n\n' : '') +
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

  // A URL is a fact about the text, not a judgement, so it is detected in
  // code rather than spent on a classification call.
  const url = findUrl(text);
  if (url) {
    await messaging.sendText(await summariseLink(url), to);
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
    case 'add_reminder':
      await handleAddReminder(text, to);
      break;
    case 'web_search':
      await messaging.sendText(await answerWithSources(text), to);
      break;
    case 'list_tasks':
      await messaging.sendText(await pendingSummary(), to);
      break;
    case 'email':
      await handleEmail(text, to);
      break;
    case 'podcast':
      await sendPodcast(text, to);
      break;
    case 'log_expense':
      await handleExpense(text, to);
      break;
    case 'expense_summary':
      await messaging.sendText(await monthSummary(), to);
      break;
    case 'log_learning':
      await handleLearning(text, to);
      break;
    case 'drive':
      await handleDrive(text, to);
      break;
    default:
      await handleOther(text, to, message.kind === 'audio');
  }
}
