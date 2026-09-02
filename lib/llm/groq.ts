/**
 * Groq provider, with key rotation.
 *
 * The free tier allows 8,000 tokens per minute per key, and one agent
 * message — a planner call plus a call per step — can spend that alone.
 * Several keys each carry their own budget, so when one is rate limited
 * the next takes over immediately instead of anyone waiting.
 *
 * That "instead of waiting" is the important part. Groq's retry-after is
 * not always small: when a longer window is spent it asks for minutes,
 * and a reply of 294 seconds was observed. Sleeping for that inside a
 * function Vercel kills at 60 seconds meant the user got nothing at all.
 * Rotating sidesteps the wait entirely; sleeping is now a last resort and
 * never exceeds the remaining budget.
 */
import { env, optional } from '../env';
import { log } from '../logger';
import {
  RateLimitedError,
  type CompleteOptions,
  type LLMProvider,
  type Message,
} from './types';

const BASE_URL = 'https://api.groq.com/openai/v1';

/** One try per key, plus a little room to come back to the first. */
const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 8_000;
const TOTAL_BUDGET_MS = 20_000;

/**
 * Every key configured, in order of preference.
 *
 * GROQ_API_KEY is the primary; GROQ_API_KEY_2..5 are extras. A
 * comma-separated GROQ_API_KEYS is also accepted so more can be added
 * without another variable.
 */
function apiKeys(): string[] {
  const listed = optional('GROQ_API_KEYS')
    .split(',')
    .map((k) => k.trim());

  const numbered = [
    env.groqApiKey(),
    optional('GROQ_API_KEY_2'),
    optional('GROQ_API_KEY_3'),
    optional('GROQ_API_KEY_4'),
    optional('GROQ_API_KEY_5'),
  ];

  return [...new Set([...numbered, ...listed].map((k) => k.trim()).filter(Boolean))];
}

/**
 * When each key becomes usable again.
 *
 * Module-level, so it survives across requests on a warm instance and a
 * key known to be spent is skipped rather than re-tried. A cold start
 * forgets, which costs one wasted call and is not worth persisting.
 */
const usableAgain = new Map<string, number>();

function shortLabel(key: string): string {
  return `…${key.slice(-6)}`;
}

/** Keys not currently cooling down, preferred order preserved. */
function readyKeys(keys: string[]): string[] {
  const now = Date.now();
  return keys.filter((key) => (usableAgain.get(key) ?? 0) <= now);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Groq, moving to another key when one is rate limited.
 *
 * Only sleeps when every key is cooling down AND the shortest wait fits
 * in what is left of the budget.
 */
async function callWithRetry(
  path: string,
  build: (key: string) => RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const keys = apiKeys();
  if (keys.length === 0) throw new Error('No Groq API key configured');

  const started = Date.now();
  let lastDetail = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
    if (remaining <= 0) {
      throw new RateLimitedError(`Groq budget of ${TOTAL_BUDGET_MS / 1000}s spent: ${lastDetail}`);
    }

    const ready = readyKeys(keys);

    if (ready.length === 0) {
      // Everything is cooling down. Wait only if the soonest one returns
      // in time to still be useful.
      const soonest = Math.min(...keys.map((k) => usableAgain.get(k) ?? 0));
      const wait = soonest - Date.now();

      if (wait > remaining) {
        throw new RateLimitedError(
          `All ${keys.length} Groq key(s) rate limited; next free in ${Math.round(wait / 1000)}s, ` +
            `which does not fit the remaining ${Math.round(remaining / 1000)}s.`,
        );
      }

      log.warn('All Groq keys cooling down, waiting', { waitMs: wait, keys: keys.length });
      await sleep(Math.max(wait, 250));
      continue;
    }

    const key = ready[0];
    const response = await fetch(`${BASE_URL}${path}`, {
      ...build(key),
      signal: signal
        ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) return response;

    lastDetail = (await response.text()).slice(0, 300);

    if (response.status === 429) {
      const suggested = Number(response.headers.get('retry-after')) * 1000;
      const cooldown = Number.isFinite(suggested) && suggested > 0 ? suggested : 30_000;

      usableAgain.set(key, Date.now() + cooldown);
      log.warn('Groq key rate limited, rotating', {
        key: shortLabel(key),
        cooldownMs: cooldown,
        keysLeft: readyKeys(keys).length,
      });
      continue;
    }

    if (response.status >= 500) {
      log.warn('Groq server error, retrying', { status: response.status, attempt });
      continue;
    }

    throw new Error(`Groq request failed (HTTP ${response.status}): ${lastDetail}`);
  }

  throw new RateLimitedError(`Groq unavailable after ${MAX_ATTEMPTS} attempts: ${lastDetail}`);
}

export class GroqProvider implements LLMProvider {
  readonly name = 'groq';

  async complete(messages: Message[], opts: CompleteOptions = {}): Promise<string> {
    const body = JSON.stringify({
      model: env.groqModel(),
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1024,
      // Groq's native JSON mode. Belt and braces alongside our own
      // prompting and Zod validation.
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    });

    const response = await callWithRetry(
      '/chat/completions',
      (key) => ({
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
      }),
      opts.signal,
    );

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error('Groq returned an empty response');
    return text.trim();
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    // WhatsApp voice notes arrive as OGG Opus, which Whisper accepts
    // directly — no conversion needed on the way in.
    const extension = mimeType.includes('ogg') ? 'ogg' : 'm4a';

    const response = await callWithRetry('/audio/transcriptions', (key) => {
      // Rebuilt per attempt: a FormData body cannot be replayed once sent.
      const form = new FormData();
      form.append('model', env.groqWhisperModel());
      form.append('response_format', 'text');
      form.append(
        'file',
        new Blob([new Uint8Array(audio)], { type: mimeType }),
        `voice.${extension}`,
      );

      return {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      };
    });

    return (await response.text()).trim();
  }
}
