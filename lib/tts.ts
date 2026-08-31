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
 * once in the Groq console — the error below says so plainly rather than
 * failing mysteriously.
 *
 * Groq returns WAV only, and WhatsApp does not accept WAV (it takes mp3,
 * aac, mp4 and ogg-opus). So the WAV is re-encoded to MP3 with lamejs, a
 * pure-JavaScript encoder: no native binary, no install scripts, nothing
 * for Vercel to choke on. MP3 plays inline as an audio message; a
 * voice-note waveform would need OGG Opus and therefore ffmpeg's 78MB
 * binary, which is not worth it for a cosmetic difference.
 */
import { env } from './env';
import { log } from './logger';

const TTS_MODEL = 'canopylabs/orpheus-v1-english';

/** The voices this model actually accepts. Anything else is a 400. */
export const VOICES = {
  autumn: 'autumn',
  diana: 'diana',
  hannah: 'hannah',
  austin: 'austin',
  daniel: 'daniel',
  troy: 'troy',
} as const;

const DEFAULT_VOICE: string = VOICES.diana;

export class TermsNotAcceptedError extends Error {
  constructor() {
    super(
      'The speech model needs its terms accepted once, at ' +
        'https://console.groq.com/playground?model=canopylabs%2Forpheus-v1-english',
    );
    this.name = 'TermsNotAcceptedError';
  }
}

// ---------------------------------------------------------------------
// MP3 encoding
// ---------------------------------------------------------------------

type Encoder = {
  encodeBuffer(left: Int16Array, right?: Int16Array): Uint8Array;
  flush(): Uint8Array;
};
type EncoderCtor = new (channels: number, sampleRate: number, kbps: number) => Encoder;

/**
 * lamejs ships an ESM build with named exports and a CJS/IIFE build that
 * exports nothing usable. A static import can be resolved to either
 * depending on the bundler; a dynamic import reliably takes the ESM
 * condition. Both shapes are still checked, so a wrong resolution fails
 * with an explanatory message rather than "not a constructor".
 */
async function loadEncoder(): Promise<EncoderCtor> {
  const mod = (await import('@breezystack/lamejs')) as unknown as {
    Mp3Encoder?: EncoderCtor;
    default?: { Mp3Encoder?: EncoderCtor };
  };
  const ctor = mod.Mp3Encoder ?? mod.default?.Mp3Encoder;
  if (typeof ctor !== 'function') {
    throw new Error('MP3 encoder unavailable (lamejs resolved to its CJS build)');
  }
  return ctor;
}

/** Pull one channel out of interleaved stereo samples. */
function deinterleave(samples: Int16Array, channel: number): Int16Array {
  const out = new Int16Array(Math.floor(samples.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = samples[i * 2 + channel];
  return out;
}

/**
 * Re-encode 16-bit PCM WAV to MP3.
 *
 * Walks the RIFF chunks rather than assuming a 44-byte header. Groq's WAV
 * puts its data chunk at byte 78 and declares a length of 0xFFFFFFFF
 * (unknown, because it streams), so a fixed offset would slice audio
 * mid-sample and a trusted length would read past the buffer.
 */
async function wavToMp3(wav: Buffer): Promise<Buffer> {
  if (wav.subarray(0, 4).toString('ascii') !== 'RIFF') {
    throw new Error('Speech service did not return a WAV file');
  }

  let channels = 1;
  let sampleRate = 24000;
  let dataStart = -1;
  let dataLength = 0;

  let offset = 12; // past "RIFF<size>WAVE"
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString('ascii');
    const size = wav.readUInt32LE(offset + 4);

    if (id === 'fmt ') {
      channels = wav.readUInt16LE(offset + 10);
      sampleRate = wav.readUInt32LE(offset + 12);
    } else if (id === 'data') {
      dataStart = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }

  if (dataStart < 0) throw new Error('WAV file had no data chunk');

  const usable = Math.min(dataLength, wav.length - dataStart);
  const pcm = new Int16Array(
    wav.buffer.slice(wav.byteOffset + dataStart, wav.byteOffset + dataStart + usable),
  );

  const Ctor = await loadEncoder();
  const mp3 = new Ctor(channels, sampleRate, 64);
  const output: Buffer[] = [];
  const BLOCK = 1152; // one MP3 frame

  for (let i = 0; i < pcm.length; i += BLOCK * channels) {
    const slice = pcm.subarray(i, i + BLOCK * channels);
    const encoded =
      channels === 2
        ? mp3.encodeBuffer(deinterleave(slice, 0), deinterleave(slice, 1))
        : mp3.encodeBuffer(slice);
    if (encoded.length > 0) output.push(Buffer.from(encoded));
  }

  const flushed = mp3.flush();
  if (flushed.length > 0) output.push(Buffer.from(flushed));

  return Buffer.concat(output);
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

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
      // WAV is the only format this model offers.
      response_format: 'wav',
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    if (detail.includes('requires terms acceptance')) throw new TermsNotAcceptedError();
    throw new Error(`Speech generation failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }

  return await wavToMp3(Buffer.from(await response.arrayBuffer()));
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
