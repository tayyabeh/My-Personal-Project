/**
 * Text to speech, via Groq.
 *
 * Two earlier approaches were tried and rejected:
 *
 *  - The `msedge-tts` package has a `preinstall` of `npx only-allow pnpm`,
 *    which fails any npm install and would have broken the Vercel build.
 *  - Talking to Microsoft's Edge read-aloud socket directly returns 403.
 *    It is gated behind a rotating signed token, so even a working
 *    implementation would break whenever Microsoft bumped the version.
 *
 * Groq is already our provider for chat and transcription, so this needs
 * no new account, key, or card. It does need the model's terms accepted
 * once in the Groq console — the error message below says so plainly
 * rather than failing mysteriously.
 *
 * Output is MP3. WhatsApp plays MP3 inline as an audio message; it shows
 * as a player rather than a voice-note waveform. Getting the waveform
 * would mean OGG Opus, which would mean bundling ffmpeg's 78MB binary
 * into a free-tier deployment. Not worth it for a cosmetic difference.
 */
import { env } from './env';
import { log } from './logger';

const TTS_MODEL = 'canopylabs/orpheus-v1-english';
const DEFAULT_VOICE = 'tara';

export class TermsNotAcceptedError extends Error {
  constructor() {
    super(
      'The speech model needs its terms accepted once, at ' +
        'https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english',
    );
    this.name = 'TermsNotAcceptedError';
  }
}

/** Synthesise speech. Returns MP3 bytes. */
export async function speak(text: string, voice: string = DEFAULT_VOICE): Promise<Buffer> {
  const response = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.groqApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice,
      input: text,
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    if (detail.includes('requires terms acceptance')) throw new TermsNotAcceptedError();
    throw new Error(`Speech generation failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/** Same, but reports why it failed instead of throwing. */
export async function trySpeak(
  text: string,
  voice?: string,
): Promise<{ audio: Buffer; error: null } | { audio: null; error: string }> {
  try {
    return { audio: await speak(text, voice), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Text to speech failed', { error: message });
    return { audio: null, error: error instanceof TermsNotAcceptedError ? 'TERMS' : message };
  }
}
