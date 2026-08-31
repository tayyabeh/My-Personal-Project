/**
 * Which language model the app uses.
 *
 * LLM_PROVIDER picks the primary. The other one, if its key is set, is
 * used automatically when the primary fails.
 *
 * That fallback exists because of a real outage: Gemini was rejecting
 * every request over conversation shape, and since it was the only
 * provider, nothing replied at all. Messages arrived, were saved, and
 * were answered with silence — the worst possible failure for an
 * assistant, because it looks identical to being ignored.
 */
import { optional } from '../env';
import { log } from '../logger';
import { GroqProvider } from './groq';
import { GeminiProvider } from './gemini';
import type { CompleteOptions, LLMProvider, Message } from './types';

/**
 * Tries the primary, then the backup. Only falls back on a genuine
 * failure — a refusal to answer is still an answer and is passed through.
 */
class WithFallback implements LLMProvider {
  readonly name: string;

  constructor(
    private primary: LLMProvider,
    private backup: LLMProvider | null,
  ) {
    this.name = backup ? `${primary.name}+${backup.name}` : primary.name;
  }

  async complete(messages: Message[], opts?: CompleteOptions): Promise<string> {
    try {
      return await this.primary.complete(messages, opts);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (!this.backup) {
        log.error('LLM failed and no backup is configured', { provider: this.primary.name, error: message });
        throw error;
      }

      log.warn('LLM failed, falling back', {
        from: this.primary.name,
        to: this.backup.name,
        error: message.slice(0, 200),
      });

      return this.backup.complete(messages, opts);
    }
  }

  /** Always Groq — Gemini has no equivalent endpoint. */
  transcribe(audio: Buffer, mimeType: string): Promise<string> {
    return new GroqProvider().transcribe(audio, mimeType);
  }
}

let cached: LLMProvider | null = null;

export function llm(): LLMProvider {
  if (cached) return cached;

  const preferred = optional('LLM_PROVIDER', 'groq');
  const hasGemini = optional('GEMINI_API_KEY') !== '';
  const hasGroq = optional('GROQ_API_KEY') !== '';

  if (preferred === 'gemini') {
    cached = new WithFallback(new GeminiProvider(), hasGroq ? new GroqProvider() : null);
  } else {
    cached = new WithFallback(new GroqProvider(), hasGemini ? new GeminiProvider() : null);
  }

  log.info('LLM provider ready', { using: cached.name });
  return cached;
}

/**
 * Transcription always goes through Groq, because Gemini has no
 * equivalent endpoint. Correct even with LLM_PROVIDER=gemini.
 */
export function transcriber(): LLMProvider {
  return new GroqProvider();
}

export type { LLMProvider, Message, CompleteOptions } from './types';
export { RateLimitedError } from './types';
