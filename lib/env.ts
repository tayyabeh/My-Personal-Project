/**
 * Environment variable access.
 *
 * Why this file exists: if you forget to set a variable, we want a clear
 * error that names the missing variable — not a confusing "undefined"
 * crash deep inside some other file.
 *
 * Values are read lazily (only when actually used) so that a missing
 * Phase 2 key never breaks a Phase 1 build.
 */

/** Read a required variable. Throws a readable error if it is missing. */
export function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing environment variable: ${name}. ` +
        `Add it to .env.local (locally) or to your Vercel project settings (in production).`,
    );
  }
  return value;
}

/** Read an optional variable, falling back to a default. */
export function optional(name: string, fallback = ''): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

export const env = {
  supabaseUrl: () => required('SUPABASE_URL'),
  supabaseServiceKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),

  llmProvider: () => optional('LLM_PROVIDER', 'groq'),
  groqApiKey: () => required('GROQ_API_KEY'),
  groqModel: () => optional('GROQ_MODEL', 'openai/gpt-oss-120b'),
  groqWhisperModel: () => optional('GROQ_WHISPER_MODEL', 'whisper-large-v3-turbo'),
  geminiApiKey: () => required('GEMINI_API_KEY'),
  geminiModel: () => optional('GEMINI_MODEL', 'gemini-2.0-flash'),

  graphVersion: () => optional('META_GRAPH_VERSION', 'v23.0'),
  whatsappPhoneNumberId: () => required('WHATSAPP_PHONE_NUMBER_ID'),
  whatsappRecipient: () => required('WHATSAPP_RECIPIENT_NUMBER'),
  whatsappToken: () => required('WHATSAPP_ACCESS_TOKEN'),
  whatsappVerifyToken: () => required('WHATSAPP_VERIFY_TOKEN'),
  metaAppSecret: () => optional('META_APP_SECRET'),

  cronSecret: () => required('CRON_SECRET'),
  appBaseUrl: () => optional('APP_BASE_URL', 'http://localhost:3000'),
};

/** Our timezone. Fixed at UTC+5 with no daylight saving. */
export const TIMEZONE = 'Asia/Karachi';
