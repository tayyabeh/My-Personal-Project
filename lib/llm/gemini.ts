/**
 * Gemini provider — the fallback.
 *
 * Switch to it by setting LLM_PROVIDER=gemini. Nothing else changes.
 *
 * Note: Gemini has no speech-to-text endpoint shaped like Whisper's, so
 * transcription always goes through Groq regardless of this setting.
 * That is handled in index.ts.
 */
import { env } from '../env';
import type { CompleteOptions, LLMProvider, Message } from './types';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';

  async complete(messages: Message[], opts: CompleteOptions = {}): Promise<string> {
    // Gemini keeps the system prompt separate from the conversation and
    // calls the assistant role "model", so we translate here.
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const url = `${BASE_URL}/models/${env.geminiModel()}:generateContent?key=${env.geminiApiKey()}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: turns,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          temperature: opts.temperature ?? 0.3,
          maxOutputTokens: opts.maxTokens ?? 1024,
          ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed (HTTP ${response.status}): ${await response.text()}`);
    }

    const json = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned an empty response');
    return text.trim();
  }

  async transcribe(): Promise<string> {
    throw new Error(
      'Gemini does not provide Whisper-style transcription. Transcription always uses Groq.',
    );
  }
}
