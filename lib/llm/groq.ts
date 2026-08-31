/**
 * Groq provider — the default.
 *
 * Groq's free tier is generous on requests per minute but much tighter
 * on TOKENS per minute, so keep the context we send small. That is the
 * limit you will actually hit, not the request count.
 */
import { env } from '../env';
import { log } from '../logger';
import {
  RateLimitedError,
  type CompleteOptions,
  type LLMProvider,
  type Message,
} from './types';

const BASE_URL = 'https://api.groq.com/openai/v1';
const MAX_ATTEMPTS = 2;

/**
 * Ceiling on one attempt, and on all retries together.
 *
 * Both are deliberately small. A message costs several sequential calls,
 * and Vercel kills the function at 60 seconds — so a 45-second retry
 * budget inside one call could consume the entire request on its own and
 * guarantee the timeout it was meant to survive.
 */
const REQUEST_TIMEOUT_MS = 6_000;
const TOTAL_BUDGET_MS = 7_000;

/** Wait, but never longer than Groq's own suggested retry delay. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Groq, retrying on 429 (rate limited) and 5xx with exponential
 * backoff. If Groq tells us how long to wait via retry-after, we respect
 * that instead of guessing.
 */
async function callWithRetry(path: string, init: RequestInit): Promise<Response> {
  let lastDetail = '';
  const started = Date.now();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Backing off past the function's own lifetime just guarantees a kill.
    if (Date.now() - started > TOTAL_BUDGET_MS) {
      throw new RateLimitedError(`Groq retries exceeded ${TOTAL_BUDGET_MS}ms: ${lastDetail}`);
    }

    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    lastDetail = await response.text();

    if (!retryable || attempt === MAX_ATTEMPTS) {
      if (response.status === 429) {
        throw new RateLimitedError(`Groq rate limit not cleared after ${attempt} attempts: ${lastDetail}`);
      }
      throw new Error(`Groq request failed (HTTP ${response.status}): ${lastDetail}`);
    }

    const suggested = Number(response.headers.get('retry-after')) * 1000;
    const wanted =
      Number.isFinite(suggested) && suggested > 0 ? suggested : 2 ** attempt * 500;

    /*
     * Never sleep past the budget.
     *
     * This was the bug behind every timeout. Groq's retry-after is not
     * always small — when a longer-window quota is spent it asks for
     * minutes, and one observed reply was 294 seconds. The old code slept
     * for exactly that, so a single call sat for 4.9 minutes while Vercel
     * killed the function at 60 seconds and the user got nothing. The
     * budget check ran at the top of the loop, which is after the sleep,
     * so it never got the chance to stop it.
     *
     * If the wait cannot fit in what is left, there is no point waiting
     * at all — fail now and let the caller fall back or answer honestly.
     */
    const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
    if (wanted > remaining) {
      log.warn('Groq asked for a wait longer than the budget; giving up', {
        askedMs: wanted,
        remainingMs: remaining,
      });
      throw new RateLimitedError(
        `Groq rate limited and asked to wait ${Math.round(wanted / 1000)}s, ` +
          `which does not fit the ${TOTAL_BUDGET_MS / 1000}s budget.`,
      );
    }

    log.warn('Groq rate limited, backing off', {
      status: response.status,
      attempt,
      waitMs: wanted,
    });
    await sleep(wanted);
  }

  throw new RateLimitedError(`Groq unavailable: ${lastDetail}`);
}

export class GroqProvider implements LLMProvider {
  readonly name = 'groq';

  async complete(messages: Message[], opts: CompleteOptions = {}): Promise<string> {
    const response = await callWithRetry('/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.groqApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: env.groqModel(),
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 1024,
        // Groq's native JSON mode. Belt and braces alongside our own
        // prompting and Zod validation.
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

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

    const form = new FormData();
    form.append('model', env.groqWhisperModel());
    form.append('response_format', 'text');
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), `voice.${extension}`);

    const response = await callWithRetry('/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.groqApiKey()}` },
      body: form,
    });

    return (await response.text()).trim();
  }
}
