/**
 * Gemini provider.
 *
 * Switch to it with LLM_PROVIDER=gemini. Worth having because Groq's free
 * tier caps tokens per minute at 8,000 across every model, which an agent
 * loop can spend on a single message.
 *
 * Gemini is stricter than Groq about conversation shape, and getting this
 * wrong produced total silence: the API returns 400 and no reply is ever
 * sent. Two rules it enforces that Groq does not:
 *
 *   - `contents` must begin with a user turn. Our history often begins
 *     with an assistant turn, because the last thing in the database is
 *     usually the bot's own reply.
 *   - Turns should alternate. Two user messages in a row is normal on
 *     WhatsApp ("Hi?" then "tum kar sakte ho na?") but not here.
 *
 * normaliseTurns fixes both rather than trusting the caller.
 *
 * Note: Gemini has no Whisper-style transcription endpoint, so voice
 * notes always go through Groq regardless of this setting.
 */
import { env } from '../env';
import type { CompleteOptions, LLMProvider, Message } from './types';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Hard ceiling on one request.
 *
 * Without this a stalled connection hangs until Vercel kills the whole
 * function at 60 seconds, which produced total silence: no reply, no
 * error, and the fallback never ran because the first call never
 * finished. A timeout turns that into a fast, catchable failure.
 */
const REQUEST_TIMEOUT_MS = 20_000;

interface GeminiTurn {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

/**
 * Make a conversation Gemini will accept: starts with a user turn, and
 * consecutive same-role turns are merged rather than dropped, so no
 * content is lost.
 */
export function normaliseTurns(messages: Message[]): GeminiTurn[] {
  const mapped: GeminiTurn[] = messages
    .filter((m) => m.role !== 'system' && m.content.trim() !== '')
    .map((m) => ({
      role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: m.content }],
    }));

  // Leading model turns have nothing to answer, so drop them.
  while (mapped.length > 0 && mapped[0].role === 'model') mapped.shift();

  const merged: GeminiTurn[] = [];
  for (const turn of mapped) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.parts[0].text += `\n\n${turn.parts[0].text}`;
    } else {
      merged.push(turn);
    }
  }

  return merged;
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';

  async complete(messages: Message[], opts: CompleteOptions = {}): Promise<string> {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const contents = normaliseTurns(messages);

    // With nothing left to send, Gemini errors; give it the system prompt
    // as the turn instead of failing.
    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: system || 'hello' }] });
    }

    const url = `${BASE_URL}/models/${env.geminiModel()}:generateContent?key=${env.geminiApiKey()}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          temperature: opts.temperature ?? 0.3,
          maxOutputTokens: opts.maxTokens ?? 1024,
          ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Gemini request failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`,
      );
    }

    const json = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
    };

    const candidate = json.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

    if (!text) {
      // Say WHY it was empty — a blocked prompt and a token cutoff need
      // very different fixes, and "empty response" hides both.
      const why =
        json.promptFeedback?.blockReason ??
        candidate?.finishReason ??
        'no candidates returned';
      throw new Error(`Gemini returned no text (${why})`);
    }

    return text.trim();
  }

  async transcribe(): Promise<string> {
    throw new Error(
      'Gemini does not provide Whisper-style transcription. Transcription always uses Groq.',
    );
  }
}
