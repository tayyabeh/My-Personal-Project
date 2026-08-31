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
 * once in the Groq console.
 *
 * Two limits shape this file, both found by testing the live API:
 *
 *  1. A whole podcast script in one request returns 413. Measured
 *     empirically: 539 characters succeeds, 719 does not. So text is
 *     split into chunks at sentence boundaries.
 *  2. Groq returns WAV only, and WhatsApp does not accept WAV (it takes
 *     mp3, aac, mp4 and ogg-opus). The chunks are decoded to raw PCM,
 *     concatenated, and encoded to MP3 ONCE — stitching separate MP3
 *     files together would work but leaves encoder padding at every
 *     seam. lamejs is pure JavaScript, so there is no native binary and
 *     no ffmpeg.
 */
import { env } from './env';
import { log } from './logger';

const TTS_MODEL = 'canopylabs/orpheus-v1-english';

/** Comfortably under the measured 539-character ceiling. */
const MAX_CHUNK_CHARS = 420;

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
// Chunking
// ---------------------------------------------------------------------

/**
 * Split on sentence ends, never mid-sentence — a cut between clauses is
 * audible as an unnatural breath. A single sentence longer than the limit
 * is split on whitespace as a last resort.
 */
export function splitForSpeech(text: string, limit = MAX_CHUNK_CHARS): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    if (sentence.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      let rest = sentence;
      while (rest.length > limit) {
        const cut = rest.lastIndexOf(' ', limit);
        const at = cut > limit * 0.5 ? cut : limit;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      current = rest;
      continue;
    }

    if ((current + ' ' + sentence).trim().length <= limit) {
      current = (current + ' ' + sentence).trim();
    } else {
      chunks.push(current);
      current = sentence;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------
// WAV handling
// ---------------------------------------------------------------------

interface Pcm {
  samples: Int16Array;
  channels: number;
  sampleRate: number;
}

/**
 * Pull PCM out of a WAV.
 *
 * Walks the RIFF chunks rather than assuming a 44-byte header. Groq's WAV
 * puts its data chunk at byte 78 and declares a length of 0xFFFFFFFF
 * (unknown, because it streams), so a fixed offset would slice audio
 * mid-sample and a trusted length would read past the buffer.
 */
function parseWav(wav: Buffer): Pcm {
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
  // Trim to a whole number of 16-bit samples.
  const evenBytes = usable - (usable % 2);

  return {
    samples: new Int16Array(
      wav.buffer.slice(wav.byteOffset + dataStart, wav.byteOffset + dataStart + evenBytes),
    ),
    channels,
    sampleRate,
  };
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

async function encodeMp3(pcm: Pcm): Promise<Buffer> {
  const Ctor = await loadEncoder();
  const mp3 = new Ctor(pcm.channels, pcm.sampleRate, 64);
  const output: Buffer[] = [];
  const BLOCK = 1152; // one MP3 frame

  for (let i = 0; i < pcm.samples.length; i += BLOCK * pcm.channels) {
    const slice = pcm.samples.subarray(i, i + BLOCK * pcm.channels);
    const encoded =
      pcm.channels === 2
        ? mp3.encodeBuffer(deinterleave(slice, 0), deinterleave(slice, 1))
        : mp3.encodeBuffer(slice);
    if (encoded.length > 0) output.push(Buffer.from(encoded));
  }

  const flushed = mp3.flush();
  if (flushed.length > 0) output.push(Buffer.from(flushed));

  return Buffer.concat(output);
}

// ---------------------------------------------------------------------
// Groq call
// ---------------------------------------------------------------------

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One chunk of speech, retrying on the rate limit this model enforces. */
async function synthesiseChunk(text: string, voice: string): Promise<Buffer> {
  for (let attempt = 1; attempt <= 4; attempt++) {
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

    if (response.ok) return Buffer.from(await response.arrayBuffer());

    const detail = await response.text();
    if (detail.includes('requires terms acceptance')) throw new TermsNotAcceptedError();

    if (response.status === 429 && attempt < 4) {
      const suggested = Number(response.headers.get('retry-after')) * 1000;
      const wait = Number.isFinite(suggested) && suggested > 0 ? suggested : attempt * 2500;
      log.warn('Speech rate limited, backing off', { attempt, waitMs: wait });
      await pause(wait);
      continue;
    }

    throw new Error(`Speech generation failed (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }

  throw new Error('Speech generation rate limit did not clear');
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/** Synthesise speech. Returns MP3 bytes. */
export async function speak(text: string, voice: string = DEFAULT_VOICE): Promise<Buffer> {
  const chunks = splitForSpeech(text);
  log.info('Synthesising speech', { chunks: chunks.length, chars: text.length });

  const parts: Pcm[] = [];
  for (const chunk of chunks) {
    parts.push(parseWav(await synthesiseChunk(chunk, voice)));
  }

  if (parts.length === 0) throw new Error('Nothing to synthesise');

  // Concatenate the raw audio, then encode once.
  const total = parts.reduce((sum, p) => sum + p.samples.length, 0);
  const merged = new Int16Array(total);
  let at = 0;
  for (const part of parts) {
    merged.set(part.samples, at);
    at += part.samples.length;
  }

  return encodeMp3({
    samples: merged,
    channels: parts[0].channels,
    sampleRate: parts[0].sampleRate,
  });
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
