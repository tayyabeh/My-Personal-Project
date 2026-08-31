/**
 * Diagnostics, guarded by the cron secret.
 *
 * Exists because Vercel's build and runtime logs are not reachable from
 * here, so a production-only failure — like the LLM rejecting every
 * request — could only be guessed at from silence. This asks the running
 * deployment what it actually sees.
 *
 * Reports whether each key is present, never its value.
 */
import { cronRequestIsAuthorised } from '@/lib/cron-auth';
import { optional } from '@/lib/env';
import { llm } from '@/lib/llm';

export const runtime = 'nodejs';
export const maxDuration = 60;

function present(name: string): boolean {
  return optional(name).trim() !== '';
}

export async function GET(request: Request): Promise<Response> {
  if (!cronRequestIsAuthorised(request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const env = {
    LLM_PROVIDER: optional('LLM_PROVIDER', '(unset)'),
    GEMINI_MODEL: optional('GEMINI_MODEL', '(unset)'),
    GROQ_MODEL: optional('GROQ_MODEL', '(unset)'),
    keys: {
      GEMINI_API_KEY: present('GEMINI_API_KEY'),
      GROQ_API_KEY: present('GROQ_API_KEY'),
      SUPABASE_SERVICE_ROLE_KEY: present('SUPABASE_SERVICE_ROLE_KEY'),
      WHATSAPP_ACCESS_TOKEN: present('WHATSAPP_ACCESS_TOKEN'),
      TAVILY_API_KEY: present('TAVILY_API_KEY'),
    },
  };

  let llmResult: string;
  try {
    const started = Date.now();
    const reply = await llm().complete([{ role: 'user', content: 'Reply with exactly: ok' }], {
      maxTokens: 10,
    });
    llmResult = `OK in ${Date.now() - started}ms — "${reply.slice(0, 40)}"`;
  } catch (error) {
    llmResult = `FAILED — ${(error instanceof Error ? error.message : String(error)).slice(0, 400)}`;
  }

  return Response.json({ env, llm: llmResult });
}
