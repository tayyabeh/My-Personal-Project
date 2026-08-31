/**
 * Book-summary podcasts.
 *
 * Tayyab asked for these to come from books rather than be generic
 * encouragement, and for the bot to ask what is on his mind first so the
 * choice actually fits. So there are two entry points:
 *
 *   askReflection()  - "aaj kal kya soch rahe ho? kahan kamzori lagti hai?"
 *                      then waits, using the pending-action slot.
 *   sendBookPodcast() - summarise a book, either one he named or one
 *                      chosen from what he just told us.
 *
 * The script is still grounded in his real numbers, so the book connects
 * to his actual week rather than floating free.
 */
import { db } from '../supabase';
import { log } from '../logger';
import { messaging } from '../messaging';
import { trySpeak } from '../tts';
import { pendingTasks, recentCompletionRate } from '../context';
import { bookScript, recommendBook, type BookPick } from './books';
import { setPending } from '../state';

const BUCKET = 'podcasts';

/** A short factual description of where he actually stands. */
async function situation(): Promise<string> {
  const [tasks, rate] = await Promise.all([pendingTasks(), recentCompletionRate()]);
  const avoided = tasks.filter((t) => t.rollover_count > 0);

  return [
    rate !== null ? `Completion rate pichle hafte: ${rate}%.` : 'Abhi koi history nahi.',
    tasks.length > 0 ? `${tasks.length} task khule hain.` : 'Koi task khula nahi.',
    avoided.length > 0
      ? `Baar baar taal raha hai: ${avoided
          .map((t) => `"${t.title}" (${t.rollover_count} dafa)`)
          .join(', ')}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Ask what is going on, and remember that we asked. */
export async function askReflection(to?: string): Promise<string> {
  await setPending({ type: 'awaiting_reflection', askedAt: new Date().toISOString() });

  await messaging.sendText(
    'Podcast bana deta hoon, lekin pehle do cheezein batao:\n\n' +
      '1. Aaj kal kya soch rahe ho? Dimagh mein kya chal raha hai?\n' +
      '2. Koi cheez hai jismein khud ko kamzor mehsoos karte ho?\n\n' +
      'Jo bhi hai, seedha likh do — usi hisab se kitab chunoonga.',
    to,
  );

  return 'reflection question asked';
}

/** Store the audio so the dashboard can play it back later. */
async function upload(audio: Buffer): Promise<string | null> {
  const path = `podcast-${Date.now()}.mp3`;

  const { error } = await db().storage.from(BUCKET).upload(path, audio, {
    contentType: 'audio/mpeg',
    upsert: false,
  });

  if (error) {
    log.error('Podcast upload failed', { error: error.message });
    return null;
  }

  const { data } = db().storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Make and send the podcast.
 *
 * `book` may be one he named; otherwise one is chosen from `reflection`.
 * If speech fails the script still goes out as text — the words are the
 * valuable part, and silence would be the worst outcome.
 */
export async function sendBookPodcast(
  reflection: string,
  book: BookPick | null,
  to?: string,
): Promise<string> {
  const chosen = book ?? (await recommendBook(reflection));

  if (!chosen) {
    await messaging.sendText(
      'Kitab choose nahi kar paya. Thora aur batao — kis cheez mein phans rahe ho?',
      to,
    );
    return 'no book chosen';
  }

  // Tell him what is coming; generating takes a while and silence reads
  // as the bot having died.
  await messaging.sendText(
    `Theek hai. "${chosen.title}" — ${chosen.author}.` +
      (chosen.why ? `\n\n${chosen.why}` : '') +
      '\n\nSummary bana raha hoon, ek minute...',
    to,
  );

  const script = await bookScript(chosen, reflection, await situation());
  const topic = `${chosen.title} — ${chosen.author}`;

  const { audio, error } = await trySpeak(script);

  if (!audio) {
    const note =
      error === 'TERMS'
        ? '\n\n(Audio nahi ban saka — speech model ki terms accept karni hain console.groq.com pe.)'
        : `\n\n(Audio nahi ban saka, is liye likh kar bhej raha hoon. Wajah: ${String(error).slice(0, 120)})`;

    await messaging.sendText(script + note, to);
    await db().from('podcasts').insert({ topic, script, audio_url: null });
    return `book podcast sent as text (${error})`;
  }

  const url = await upload(audio);
  await db().from('podcasts').insert({ topic, script, audio_url: url });
  await messaging.sendVoice(audio, 'audio/mpeg');

  return `book podcast sent (${Math.round(audio.length / 1024)}kb): ${topic}`;
}
