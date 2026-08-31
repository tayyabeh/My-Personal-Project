/**
 * What happens when a message arrives.
 *
 * The pipeline:
 *   save + dedupe -> (transcribe if voice) -> is an answer pending? ->
 *   classify intent -> focused handler -> reply with what we understood.
 *
 * Replies are in Roman Urdu, which is how Tayyab asked to be spoken to.
 * The reply always states what was understood, so a mistake costs a
 * two-second correction instead of rotting silently in the database.
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
import { askReflection, sendBookPodcast } from '../features/podcast';
import { bookFromRequest } from '../features/books';
import { logExpense, monthSummary } from '../features/expenses';
import { saveLearning } from '../features/learnings';
import { findUrl, summariseLink } from '../features/links';
import { searchDrive } from '../features/drive';
import { getPending, setPending } from '../state';
import { ROMAN_URDU } from '../lang';

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
    await messaging.sendText('Samajh nahi aaya. Thora aaram se dobara bolo?', to);
    return;
  }

  if (result.tasks.length === 0) {
    await messaging.sendText('Ismein koi task nahi mila. Aaj kya karna hai?', to);
    return;
  }

  // Confident tasks get saved. Garbled ones are read back for confirmation
  // rather than written to the database as nonsense.
  const confident = result.tasks.filter((task) => !task.uncertain);
  const unsure = result.tasks.filter((task) => task.uncertain);

  const { titles, onCalendar } = await saveTasks(confident);

  const parts: string[] = [];
  if (titles.length > 0) {
    parts.push(
      `${titles.length} add kar diye:\n${titles.map((title) => `• ${title}`).join('\n')}` +
        (onCalendar > 0 ? '\n\nCalendar pe bhi laga diye.' : ''),
    );
  }
  if (unsure.length > 0) {
    parts.push(
      `Ye theek se samajh nahi aaya — "haan" kaho to add kar dun:\n` +
        unsure.map((task) => `• ${task.title}?`).join('\n'),
    );
  }

  await messaging.sendText(parts.join('\n\n'), to);
}

async function handleCompleteTask(text: string, to: string): Promise<void> {
  const tasks = await pendingTasks();

  if (tasks.length === 0) {
    await messaging.sendText('Abhi kuch pending nahi hai.', to);
    return;
  }

  const match = await matchCompletion(text, tasks);

  if (!match) {
    await messaging.sendText(
      `Samajh nahi aaya kaunsa. Ye pending hain:\n${tasks
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
    `Ho gaya: ${match.title}${left > 0 ? `\n${left} aur baaki hain.` : '\nBas, sab clear.'}`,
    to,
  );
}

async function handleAddReminder(text: string, to: string): Promise<void> {
  const parsed = await extractReminder(text);

  if (!parsed) {
    await messaging.sendText(
      'Waqt samajh nahi aaya. Aise bolo: "jumeraat 3 baje bank call karna yaad dilana".',
      to,
    );
    return;
  }

  const { calendarError } = await saveReminder(parsed.title, parsed.when);

  const lines = [
    `Reminder set: ${parsed.title}`,
    humanTime(parsed.when),
    '5 minute pehle bata dunga.',
  ];

  // The reminder is saved either way; only the calendar copy can fail.
  if (calendarError === 'NOT_CONNECTED') {
    lines.push('', '(Google Calendar pe nahi gaya — account connect nahi hai.)');
  } else if (calendarError) {
    lines.push('', '(Yahan save hai, lekin Calendar ne reject kar diya.)');
  } else {
    lines.push('Calendar pe bhi laga diya.');
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
        'Google account connect nahi hai, is liye inbox nahi parh sakta.',
        to,
      );
      return;
    }
    log.error('Email feature failed', { error: message });
    await messaging.sendText('Abhi inbox nahi parh paya.', to);
  }
}

async function handleExpense(text: string, to: string): Promise<void> {
  const result = await logExpense(text);
  if (!result.ok) {
    await messaging.sendText('Amount samajh nahi aaya. Aise bolo: "2000 groceries pe lagaye".', to);
    return;
  }
  await messaging.sendText(
    `Note kar liya: Rs ${result.amount.toLocaleString('en-PK')} — ${result.category}.`,
    to,
  );
}

async function handleLearning(text: string, to: string): Promise<void> {
  const saved = await saveLearning(text);
  if (!saved) {
    await messaging.sendText('Theek se samajh nahi aaya. Dobara bolo?', to);
    return;
  }
  await messaging.sendText(
    `Save kar liya:\n${saved}\n\n3 din, phir hafte, 2 hafte aur mahine baad yaad dilaunga.`,
    to,
  );
}

async function handleDrive(text: string, to: string): Promise<void> {
  try {
    await messaging.sendText(await searchDrive(text), to);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'NOT_CONNECTED') {
      await messaging.sendText('Google connect nahi hai, Drive tak nahi pahunch sakta.', to);
      return;
    }
    log.error('Drive feature failed', { error: message });
    await messaging.sendText('Abhi Drive search nahi kar paya.', to);
  }
}

/**
 * Podcast. If he named a book, summarise that one. Otherwise ask what is
 * on his mind first, because a book chosen without that is generic.
 */
async function handlePodcast(text: string, to: string): Promise<void> {
  const named = await bookFromRequest(text);

  if (named) {
    await sendBookPodcast(text, named, to);
    return;
  }

  await askReflection(to);
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
          'Tum Tayyab ke personal assistant ho, WhatsApp pe.\n\n' +
          'ZAROORI — ye sab tum kar sakte ho, inkaar kabhi mat karna:\n' +
          '- Voice note SUN sakte ho. Woh khud transcribe ho kar tumhare paas text mein aata ' +
          'hai. Kabhi mat kehna ke "main audio nahi sun sakta" — ye jhoot hai.\n' +
          '- Task likhna, complete karna, pending batana.\n' +
          '- Reminder lagana, calendar pe daalna, Gmail aur Drive parhna.\n' +
          '- Kitab ka summary podcast bana kar bhejna.\n\n' +
          'Do ya teen jumle se zyada mat likho. Seedhi, dostana baat. ' +
          'Koi task ya kaam khud se mat banao — sirf wahi jo neeche context mein hai.\n\n' +
          ROMAN_URDU +
          '\n\n' +
          (wasVoice ? 'Ye message voice note tha, transcribe hua hai.\n\n' : '') +
          context,
      },
      { role: 'user', content: text },
    ],
    { temperature: 0.6, maxTokens: 500 },
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
      await messaging.sendText('Awaz saaf nahi aayi. Dobara bhejo ya likh do?', to);
      return;
    }
  }

  if (message.kind === 'unsupported' || text.trim() === '') {
    await messaging.sendText('Text ya voice note bhejo.', to);
    return;
  }

  // Did we ask him something and this is the answer? That has to be
  // checked BEFORE classification, or "main procrastinate karta hoon"
  // gets filed as a task.
  const pending = await getPending();
  if (pending?.type === 'awaiting_reflection') {
    await setPending(null);
    log.info('Treating message as reflection answer');
    await sendBookPodcast(text, null, to);
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
      await handlePodcast(text, to);
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
