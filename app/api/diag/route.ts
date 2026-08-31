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
import { handle, makePlan } from '@/lib/agents/orchestrator';

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

  // Time the planner on its own first. Even a greeting, which needs no
  // agent at all, was timing out — so the split matters.
  const planStarted = Date.now();
  let planMs = -1;
  let planResult = 'not reached';
  try {
    const plan = await makePlan({ to: 'diag', input, history: [], say: async () => {} });
    planMs = Date.now() - planStarted;
    planResult = plan.ok
      ? `steps: ${plan.data.steps.map((s) => s.agent).join(' -> ') || '(none)'}`
      : `plan failed: ${plan.error.slice(0, 120)}`;
  } catch (error) {
    planMs = Date.now() - planStarted;
    planResult = `threw: ${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`;
  }

  try {
    // Race so the probe reports what it learned instead of dying with it.
    // Losing the diagnosis to the very timeout being diagnosed is exactly
    // how this stayed opaque for so long.
    const result = await Promise.race([
      handle({
        to: '923273844643',
        input,
        history: [],
        // Capture interim messages instead of sending them.
        say: async (text: string) => {
          sent.push(text.slice(0, 80));
        },
      }),
      new Promise<{ reply: string; steps: string[] }>((resolve) =>
        setTimeout(() => resolve({ reply: '(probe timed out at 35s)', steps: ['PROBE-TIMEOUT'] }), 35_000),
      ),
    ]);

    return {
      ok: true,
      planMs,
      planResult,
      ms: Date.now() - started,
      tools: result.steps,
      reply: result.reply.slice(0, 400),
      interim: sent,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      planMs,
      planResult,
      ms: Date.now() - started,
      error: message.slice(0, 500),
      interim: sent,
    };
  }
}

/**
 * Time a plain call against a JSON-mode call.
 *
 * Every agent step goes through JSON mode, so if that path is slow while
 * a plain call is fast, the whole pipeline inherits it — which is what
 * the symptoms looked like.
 */
async function probeJson() {
  const timed = async (label: string, run: () => Promise<string>) => {
    const started = Date.now();
    try {
      const out = await run();
      return { label, ms: Date.now() - started, ok: true, out: out.slice(0, 80) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { label, ms: Date.now() - started, ok: false, out: message.slice(0, 200) };
    }
  };

  const plain = await timed('plain', () =>
    llm().complete([{ role: 'user', content: 'Reply with exactly: ok' }], { maxTokens: 10 }),
  );

  const json = await timed('json-mode', () =>
    llm().complete(
      [
        { role: 'system', content: 'Reply ONLY with JSON: {"intent":"..."}' },
        { role: 'user', content: 'mere pending tasks batao' },
      ],
      { json: true, maxTokens: 200 },
    ),
  );

  const big = await timed('json-mode + long prompt', () =>
    llm().complete(
      [
        {
          role: 'system',
          // Roughly the size of a real agent prompt.
          content:
            'Reply ONLY with JSON: {"thought":"","tool":null,"reply":"..."}\n\n' +
            'Tools:\n' +
            Array.from({ length: 8 }, (_, i) => `- tool_${i}(arg: string)\n    Ye tool kaam karta hai.`).join('\n'),
        },
        { role: 'user', content: 'mere pending tasks batao' },
      ],
      { json: true, maxTokens: 900 },
    ),
  );

  return [plain, json, big];
}

export async function GET(request: Request): Promise<Response> {
  if (!cronRequestIsAuthorised(request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const params = new URL(request.url).searchParams;

  if (params.get('json') !== null) {
    return Response.json({ timings: await probeJson() });
  }

  // Planner only. The agent probe runs it and then runs it again inside
  // handle(), which muddies the timing when something hangs.
  const planInput = params.get('plan');
  if (planInput) {
    const started = Date.now();
    try {
      const plan = await makePlan({ to: 'diag', input: planInput, history: [], say: async () => {} });
      return Response.json({
        ms: Date.now() - started,
        ok: plan.ok,
        result: plan.ok ? plan.data : plan.error.slice(0, 300),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ ms: Date.now() - started, ok: false, threw: message.slice(0, 300) });
    }
  }

  const agentInput = params.get('agent');
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
      // How many keys production can actually rotate between.
      groqKeyCount: ['GROQ_API_KEY','GROQ_API_KEY_2','GROQ_API_KEY_3','GROQ_API_KEY_4','GROQ_API_KEY_5'].filter(present).length,
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
