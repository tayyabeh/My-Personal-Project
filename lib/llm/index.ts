/**
 * Picks the language model provider based on the LLM_PROVIDER variable.
 *
 * Use llm() everywhere in feature code. Never import GroqProvider or
 * GeminiProvider directly — that is what makes the swap a one-line change.
 */
import { env } from '../env';
import { GroqProvider } from './groq';
import { GeminiProvider } from './gemini';
import type { LLMProvider } from './types';

let cached: LLMProvider | null = null;

export function llm(): LLMProvider {
  if (!cached) {
    cached = env.llmProvider() === 'gemini' ? new GeminiProvider() : new GroqProvider();
  }
  return cached;
}

/**
 * Transcription always goes through Groq, because Gemini has no
 * equivalent endpoint. This stays correct even with LLM_PROVIDER=gemini.
 */
export function transcriber(): LLMProvider {
  return new GroqProvider();
}

export type { LLMProvider, Message, CompleteOptions } from './types';
export { RateLimitedError } from './types';
