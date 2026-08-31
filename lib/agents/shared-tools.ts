/**
 * Tools that belong to more than one agent.
 *
 * The orchestrator picks a single agent, and agents cannot call each
 * other. That is deliberate — chained agents get expensive and hard to
 * follow on a rate-limited free tier — but it meant "AI updates search
 * karo aur voice bana kar sunao" was impossible: research could search
 * but not speak, and coach could speak but only about books.
 *
 * Sharing the capability instead of chaining the agents fixes that. Any
 * agent that lists `sendAsVoice` can finish its work by speaking it.
 */
import { z } from 'zod';
import { messaging } from '../messaging';
import { trySpeak } from '../tts';
import { db } from '../supabase';
import { log } from '../logger';
import type { Tool } from './types';

/**
 * Speak some text and send it as a WhatsApp audio message.
 *
 * The text comes from the agent, not from the model's imagination: the
 * intended use is to pass back something a previous tool returned, so
 * what is spoken is what was actually found.
 */
export const sendAsVoice: Tool<{ text: string; topic: string }> = {
  name: 'send_as_voice',
  description:
    'Kisi bhi matn ko awaz mein badal kar voice message bhejo. Jab user kahe "voice mein ' +
    'sunao", "bol kar batao", "audio bana do" — tab ye chalao. Jo text do wahi bola jayega, ' +
    'to pehle maloomat jama karo phir yahan bhejo.',
  args: 'text: string (jo bolna hai), topic: string (chhota naam, save karne ke liye)',
  schema: z.object({
    text: z.string().min(20).max(4000),
    topic: z.string().min(2).max(120),
  }),
  async run({ text, topic }, ctx) {
    const { audio, error } = await trySpeak(text);

    if (!audio) {
      // The words are the valuable part, so never lose them to a TTS
      // failure — say what went wrong and hand over the text.
      log.warn('Voice generation failed, sending text', { error });
      return `Awaz nahi ban saki (${String(error).slice(0, 100)}). Text bhej do user ko.`;
    }

    // Keep a copy so it is playable from the dashboard later.
    const path = `voice-${Date.now()}.mp3`;
    let url: string | null = null;

    const { error: uploadError } = await db()
      .storage.from('podcasts')
      .upload(path, audio, { contentType: 'audio/mpeg', upsert: false });

    if (uploadError) {
      log.warn('Voice upload failed, sending anyway', { error: uploadError.message });
    } else {
      url = db().storage.from('podcasts').getPublicUrl(path).data.publicUrl;
    }

    await db().from('podcasts').insert({ topic, script: text, audio_url: url });
    await messaging.sendVoice(audio, 'audio/mpeg');

    return `Voice message bhej diya (${Math.round(audio.length / 1024)}kb). Ab sirf ek chhoti line likho, poora matn dobara mat likho.`;
  },
};
