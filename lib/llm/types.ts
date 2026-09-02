/**
 * The language model interface.
 *
 * Feature code only ever sees this. Swapping Groq for Gemini is a change
 * to one environment variable, not a change to any feature.
 */

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  /**
   * Ask the model to reply with strict JSON. We still parse and validate
   * ourselves — this just makes valid output far more likely.
   */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /**
   * Cancels the request when the caller's run is aborted (deadline, or a
   * tool cancelling itself). Combined with the provider's own per-request
   * timeout, never replacing it — either one firing ends the call.
   */
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly name: string;
  complete(messages: Message[], opts?: CompleteOptions): Promise<string>;
  /** Transcribe a voice note. Returns the recognised text. */
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

/** Thrown when the provider is rate limited and retries did not clear it. */
export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitedError';
  }
}
