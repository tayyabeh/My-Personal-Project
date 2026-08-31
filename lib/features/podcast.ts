/**
 * Motivational podcasts.
 *
 * The point of this feature is that it is about YOU, not generic
 * encouragement. The script is written from the real numbers: what you
 * actually finished, what you keep putting off and how many times, and
 * what you have been learning. A generic pep talk would be worse than
 * nothing, so the prompt is given facts and forbidden from inventing any.
 */
import { db } from '../supabase';
import { llm } from '../llm';
import { log } from '../logger';
import { messaging } from '../messaging';
import { trySpeak } from '../tts';
import { pendingTasks, recentCompletionRate } from '../context';

const BUCKET = 'podcasts';

/** Two to three minutes of speech is roughly 300-400 words. */
async function writeScript(mood: string): Promise<string> {
  const [tasks, rate] = await Promise.all([pendingTasks(), recentCompletionRate()]);
  const avoided = tasks.filter((t) => t.rollover_count > 0);

  const { data: learnings } = await db()
    .from('learnings')
    .select('content')
    .order('created_at', { ascending: false })
    .limit(5);

  const { data: recentDone } = await db()
    .from('tasks')
    .select('title')
    .eq('status', 'done')
    .order('completed_at', { ascending: false })
    .limit(8);

  const facts = [
    rate !== null ? `Their completion rate over the last week is ${rate}%.` : 'No completion history yet.',
    recentDone && recentDone.length > 0
      ? `Recently finished: ${recentDone.map((t) => t.title).join(', ')}.`
      : 'Nothing has been completed recently.',
    avoided.length > 0
      ? `Being avoided: ${avoided.map((t) => `"${t.title}" (carried over ${t.rollover_count} times)`).join(', ')}.`
      : 'Nothing is being repeatedly avoided.',
    tasks.length > 0 ? `${tasks.length} task(s) currently open.` : 'Nothing is currently open.',
    learnings && learnings.length > 0
      ? `Things they noted learning: ${learnings.map((l) => l.content).join('; ')}.`
      : '',
    `They said they are feeling: ${mood}.`,
  ]
    .filter(Boolean)
    .join('\n');

  return llm().complete(
    [
      {
        role: 'system',
        content:
          'Write a spoken script for a short personal audio message, about 300 words — ' +
          'roughly two minutes read aloud.\n\n' +
          'This will be SPOKEN, so: no headings, no bullet points, no markdown, no emoji, ' +
          'no stage directions. Just flowing sentences a person would say out loud.\n\n' +
          'It is addressed to one specific person and must be grounded in the facts below. ' +
          'Reference their actual situation — the real task they keep putting off, by name, ' +
          'and the real number of times. Never invent a task, a number or an achievement.\n\n' +
          'Tone: steady and warm, like someone who knows them and is not impressed by ' +
          'excuses but is firmly on their side. Not a hype coach. No exclamation marks. ' +
          'Do not open with "Hey there". Acknowledge how they said they feel without ' +
          'wallowing in it, then give them one concrete thing to do next.',
      },
      { role: 'user', content: `Here is their real situation:\n\n${facts}` },
    ],
    { temperature: 0.8, maxTokens: 1200 },
  );
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
 * Generate and send a podcast.
 *
 * If speech synthesis is unavailable the script is still sent as text
 * rather than the whole thing failing — the words are the valuable part.
 */
export async function sendPodcast(mood: string, to?: string): Promise<string> {
  const script = await writeScript(mood);

  const { audio, error } = await trySpeak(script);

  if (!audio) {
    const note =
      error === 'TERMS'
        ? "\n\n(I couldn't record this as audio — the speech model needs its terms accepted " +
          'once at console.groq.com. Here it is in writing.)'
        : "\n\n(I couldn't record this as audio, so here it is in writing.)";

    await messaging.sendText(script + note, to);
    await db().from('podcasts').insert({ topic: mood, script, audio_url: null });
    return `podcast sent as text (${error})`;
  }

  const url = await upload(audio);
  await db().from('podcasts').insert({ topic: mood, script, audio_url: url });

  await messaging.sendVoice(audio, 'audio/mpeg');

  return `podcast sent as audio (${Math.round(audio.length / 1024)}kb)`;
}
