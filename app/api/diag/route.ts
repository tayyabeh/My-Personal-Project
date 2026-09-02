/**
 * Diagnostics, guarded by the cron secret.
 *
 * Exists because Vercel's build and runtime logs are not reachable from
 * here, so a production-only failure — like every LLM call stalling, or
 * replies never being sent — could only be guessed at from silence. This
 * asks the running deployment what it actually sees.
 *
 *   /api/diag               env + one LLM call + usable Gemini models
 *   /api/diag?loop=<text>   runs the real agent loop on <text> and reports
 *                           the tools it ran, the receipts, and the reply
 *   /api/diag?claim=<text>  shows which lines of <text> the honesty filter
 *                           keeps and which it strips, and why
 *   /api/diag?logs=1        the latest persisted error logs
 *
 * Reports whether each key is present, never its value. The loop mode
 * does not send anything to WhatsApp.
 */
import { cronRequestIsAuthorised } from '@/lib/cron-auth';
import { optional } from '@/lib/env';
import { llm } from '@/lib/llm';
import { runLoop } from '@/lib/loop';
import { checkSentence } from '@/lib/honesty';
import { recentLogs } from '@/lib/db/log-store';
import type { Receipt } from '@/lib/tools/types';

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

/** Run the real loop, capturing whatever it does or throws. Sends nothing. */
async function probeLoop(input: string) {
  const started = Date.now();
  const controller = new AbortController();
  const deadline = Date.now() + 35_000;
  const timeoutId = setTimeout(() => controller.abort(new Error('probe deadline')), 35_000);

  try {
    const result = await runLoop({
      to: 'diag',
      input,
      history: [],
      signal: controller.signal,
      deadline,
      runId: crypto.randomUUID(),
    });

    return {
      ok: true,
      ms: Date.now() - started,
      tools: result.steps,
      reply: result.reply.slice(0, 500),
      receipts: result.receipts.map((r: Receipt) => ({
        tool: r.tool,
        ok: r.ok,
        effect: r.effect,
        factLine: r.factLine.slice(0, 160),
        numbers: r.numbers,
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      aborted: controller.signal.aborted,
      ms: Date.now() - started,
      error: message.slice(0, 500),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Time a plain call against a JSON-mode call.
 *
 * Every loop step goes through JSON mode, so if that path is slow while a
 * plain call is fast, the whole pipeline inherits it.
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

  return [plain, json];
}

export async function GET(request: Request): Promise<Response> {
  if (!cronRequestIsAuthorised(request)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const params = new URL(request.url).searchParams;

  if (params.get('json') !== null) {
    return Response.json({ timings: await probeJson() });
  }

  // Honesty filter probe. With no receipts supplied, any completion or
  // number claim strips (nothing backs it) and promise phrasing always
  // strips — the worst case that proves the deterministic rules.
  const claim = params.get('claim');
  if (claim) {
    const write = params.get('write') !== null;
    const numbers = (params.get('numbers') ?? '')
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n));
    const receipts: Receipt[] = write || numbers.length
      ? [{ tool: 'diag', ok: true, effect: write ? 'write' : 'read', factLine: '', entities: [], numbers, observation: '' }]
      : [];
    const lines = claim.split('\n').map((line) => checkSentence(line, receipts));
    return Response.json({ claim, receipts: receipts.length, lines });
  }

  if (params.get('logs') !== null) {
    return Response.json({ logs: await recentLogs(50) });
  }

  const loopInput = params.get('loop');
  if (loopInput) {
    return Response.json({ loop: await probeLoop(loopInput) });
  }

  const env = {
    LLM_PROVIDER: optional('LLM_PROVIDER', '(unset)'),
    GEMINI_MODEL: optional('GEMINI_MODEL', '(unset)'),
    GROQ_MODEL: optional('GROQ_MODEL', '(unset)'),
    keys: {
      GEMINI_API_KEY: present('GEMINI_API_KEY'),
      GROQ_API_KEY: present('GROQ_API_KEY'),
      groqKeyCount: ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4', 'GROQ_API_KEY_5'].filter(present).length,
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
