/**
 * Diagnostics, guarded by the cron secret.
 *
 * Exists because Vercel's build and runtime logs are not reachable from
 * here, so a production-only failure — like every LLM call stalling, or
 * replies never being sent — could only be guessed at from silence. This
 * asks the running deployment what it actually sees.
 *
 *   /api/diag              env + one LLM call + usable Gemini models
 *   /api/diag?agent=<text> runs the full orchestrator on <text> and
 *                          reports the tools it ran, timing, and any error
 *
 * Reports whether each key is present, never its value. The agent mode
 * does not send anything to WhatsApp.
 */
import { cronRequestIsAuthorised } from '@/lib/cron-auth';
import { optional } from '@/lib/env';
import { llm } from '@/lib/llm';
import { handle } from '@/lib/agents/orchestrator';

export const runtime = 'nodejs';
export const maxDuration = 60;

function present(name: string): boolean {
  return optional(name).trim() !== '';
}

/**
 * Which models this Gemini key may actually call. A wrong model name is
 * invisible from outside — the request just fails — so ask directly.
 */
async function listGeminiModels(): Promise<string[] | string> {
  const key = optional('GEMINI_API_KEY');
  if (!key) return 'no key set';

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=100`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return `HTTP ${response.status}`;

    const json = (await response.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };

    return (json.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => (m.name ?? '').replace('models/', ''))
      .filter((name) => name.includes('flash'))
      .slice(0, 25);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `could not list: ${message.slice(0, 160)}`;
  }
}

/** Run the real pipeline, capturing whatever it does or throws. */
async function probeAgent(input: string) {
  const started = Date.now();
  const sent: string[] = [];

  try {
    const result = await handle({
      to: '923273844643',
      input,
      history: [],
      // Capture interim messages instead of sending them.
      say: async (text: string) => {
        sent.push(text.slice(0, 80));
      },
    });

    return {
      ok: true,
      ms: Date.now() - started,
      tools: result.steps,
      reply: result.reply.slice(0, 400),
      interim: sent,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      ms: Date.now() - started,
      error: message.slice(0, 500),
      interim: sent,
    };
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!cronRequestIsAuthorised(request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const agentInput = new URL(request.url).searchParams.get('agent');
  if (agentInput) {
    return Response.json({ agent: await probeAgent(agentInput) });
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
    const message = error instanceof Error ? error.message : String(error);
    llmResult = `FAILED — ${message.slice(0, 400)}`;
  }

  return Response.json({ env, llm: llmResult, geminiModels: await listGeminiModels() });
}
