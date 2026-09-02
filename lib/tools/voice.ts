/**
 * Voice: speak some text as a WhatsApp audio message, and pick the voice.
 *
 * The text comes from the model's own gathered answer, not its
 * imagination — the intended use is to pass back what a previous tool
 * returned, so what is spoken is what was actually found.
 */
import { z } from 'zod';
import { messaging } from '../messaging';
import { trySpeak, VOICES } from '../tts';
import { db } from '../supabase';
import { log } from '../logger';
import { ok, fail, type Tool } from './types';

/** The stored voice, falling back to the default when unset/invalid. */
async function currentVoice(): Promise<string> {
  const { data } = await db().from('settings').select('tts_voice').eq('id', 1).maybeSingle();
  const stored = String(data?.tts_voice ?? '');
  return stored in VOICES ? stored : VOICES.diana;
}

const sendAsVoice: Tool<{ text: string; topic: string }> = {
  name: 'send_as_voice',
  description:
    'Kisi bhi matn ko awaz mein badal kar voice message bhejo. Jab user kahe "voice mein sunao", ' +
    '"bol kar batao" — tab chalao. Jo text do wahi bola jayega, to pehle maloomat jama karo.',
  args: 'text: string (jo bolna hai), topic: string (chhota naam, save karne ke liye)',
  schema: z.object({ text: z.string().min(20).max(4000), topic: z.string().min(2).max(120) }),
  async run({ text, topic }) {
    const { audio, error } = await trySpeak(text, await currentVoice());

    if (!audio) {
      log.warn('Voice generation failed', { error });
      return fail('send_as_voice', `Awaz nahi ban saki (${String(error).slice(0, 100)}).`);
    }

    const path = `voice-${Date.now()}.mp3`;
    let url: string | null = null;
    const { error: uploadError } = await db()
      .storage.from('podcasts')
      .upload(path, audio, { contentType: 'audio/mpeg', upsert: false });
    if (uploadError) log.warn('Voice upload failed, sending anyway', { error: uploadError.message });
    else url = db().storage.from('podcasts').getPublicUrl(path).data.publicUrl;

    await db().from('podcasts').insert({ topic, script: text, audio_url: url });
    await messaging.sendVoice(audio, 'audio/mpeg');

    return ok({
      tool: 'send_as_voice',
      effect: 'write',
      factLine: 'Voice message bhej diya.',
      numbers: [Math.round(audio.length / 1024)],
      entities: [topic],
    });
  },
};

const setVoice: Tool<{ voice: string }> = {
  name: 'set_voice',
  description: `Awaz badlo. In mein se ek: ${Object.keys(VOICES).join(', ')}.`,
  args: 'voice: string',
  schema: z.object({ voice: z.string().min(2).max(20) }),
  async run({ voice }) {
    const chosen = voice.trim().toLowerCase();
    if (!(chosen in VOICES)) {
      return fail('set_voice', `"${voice}" available nahi. Ye hain: ${Object.keys(VOICES).join(', ')}.`);
    }
    const { error } = await db()
      .from('settings')
      .update({ tts_voice: chosen, updated_at: new Date().toISOString() })
      .eq('id', 1);
    if (error) return fail('set_voice', error.message);
    return ok({ tool: 'set_voice', effect: 'write', factLine: `Awaz ab "${chosen}" hai.`, entities: [chosen] });
  },
};

export const voiceTools: Tool<any>[] = [sendAsVoice, setVoice];
export { currentVoice };
