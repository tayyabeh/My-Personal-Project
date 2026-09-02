/**
 * The agent loop.
 *
 * Replaces `lib/agents/orchestrator.ts` + `loop.ts` + `registry.ts`. There
 * is no planner picking an agent by description anymore — routing IS the
 * tool list. One flat array (`lib/tools/index.ts`), one loop: think, call
 * a tool, look at the Receipt, go again.
 *
 * Deliberately does NOT use the provider's native tool calling — open
 * models are unreliable at it, and Groq and Gemini expose it differently.
 * The model returns plain JSON we validate ourselves instead.
 *
 * The reply is never the model's raw prose. Every tool call produces a
 * Receipt, and `lib/honesty.ts` builds the final reply from those —
 * prose supplements the record of what really happened, never replaces
 * it.
 */
import { z } from 'zod';
import { completeJson } from './llm/json';
import { log } from './logger';
import { ROMAN_URDU } from './lang';
import { buildReply } from './honesty';
import { TOOLS } from './tools';
import { fail, type Receipt, type Turn, type ToolContext } from './tools/types';

/** How much of a Receipt's observation is carried forward into later steps. */
const MAX_OBSERVATION_CHARS = 2500;

/** No agent boundary forces a second model call anymore, so this needs headroom. */
const MAX_STEPS = 6;

const StepSchema = z.object({
  /** One line of reasoning. Generous cap — a rejected step burns a retry. */
  thought: z.string().max(2000).default(''),
  /** Tool to call, or null when finished. */
  tool: z.string().nullable().default(null),
  args: z.record(z.string(), z.unknown()).default({}),
  /** The reply to send. Required when tool is null. */
  reply: z.string().max(3000).default(''),
});

function describeTools(): string {
  return TOOLS.map((t) => `- ${t.name}(${t.args})\n    ${t.description}`).join('\n');
}

// The rules are the same on every call, so they are written in English:
// it tokenizes to fewer tokens than Roman Urdu and models follow English
// instructions more reliably. ROMAN_URDU below still forces the user-facing
// REPLY into Roman Urdu — only these internal rules are in English.
function systemPrompt(): string {
  return (
    `You are Tayyab's WhatsApp assistant. You can ONLY do what the tools below allow.\n\n` +
    `Tools:\n${describeTools()}\n\n` +
    `Every turn, output ONLY JSON, doing exactly one thing:\n` +
    `  Call a tool:  {"thought":"...","tool":"tool_name","args":{...}}\n` +
    `  Finish:       {"thought":"...","tool":null,"reply":"..."}\n\n` +
    `RULES (breaking these is the worst mistake):\n` +
    `- Never claim a tool's work happened if you did not run it. Never promise ` +
    `("I'll do it now") — either run a tool or plainly say you cannot.\n` +
    `- "saved it", "noted it", "remembered it" — only if a tool actually wrote it. ` +
    `You have no memory; after this reply you forget everything.\n` +
    `- If no tool fits, run cannot_do — an honest "can't" beats a false promise.\n` +
    `- The tool result is the only truth. If it failed, tell the user it failed.\n` +
    `- One tool at a time; decide the next from its result. For bulk actions use the ` +
    `tool's batch form (ids/all) — do NOT loop one call per item.\n` +
    `- When you have enough, finish with tool:null. Don't run tools needlessly.\n` +
    `- Keep the reply short; it is read on WhatsApp.\n\n` +
    ROMAN_URDU
  );
}

export interface LoopInput {
  to: string;
  input: string;
  history: Turn[];
  signal: AbortSignal;
  deadline: number;
  runId: string;
}

export interface LoopResult {
  reply: string;
  receipts: Receipt[];
  steps: string[];
}

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const steps: string[] = [];
  const receipts: Receipt[] = [];

  const ctx: ToolContext = {
    to: input.to,
    input: input.input,
    history: input.history,
    signal: input.signal,
    deadline: input.deadline,
    runId: input.runId,
  };

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt() },
    ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: input.input },
  ];

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (Date.now() > input.deadline) {
      log.warn('Loop stopped on deadline', { step, steps });
      break;
    }

    const thinkStarted = Date.now();
    const result = await completeJson(StepSchema, messages, {
      temperature: 0.2,
      maxTokens: 900,
      signal: input.signal,
    });
    steps.push(`think:${Date.now() - thinkStarted}ms`);

    if (!result.ok) {
      log.error('Loop step failed', { step, error: result.error });

      // A spent quota or a temporary backend outage is not a
      // misunderstanding. Saying "samajh nahi aaya" for it sends the user
      // off rephrasing a message that was perfectly clear — worse than
      // saying nothing useful. Both providers being momentarily down (a
      // Groq 429 falling back to a Gemini 503, say) lands here, so the
      // vocabulary covers rate limits AND transient backend failures.
      const rateLimited = /rate limit|429|quota|exceeded|limit/i.test(result.error);
      const transient = /timeout|aborted|overloaded|high demand|unavailable|HTTP 5\d\d|502|503|500/i.test(result.error);

      return {
        reply: rateLimited
          ? 'Abhi AI ki limit khatam ho gayi hai (roz ki had). Thori der baad ya kal dobara bolo.'
          : transient
            ? 'AI abhi thodi busy hai — samajh gaya tha, bas jawab nahi ban paya. Thori der baad wahi message dobara bhej do.'
            : 'Samajh nahi aaya. Thora aur wazeh bolo?',
        receipts,
        steps,
      };
    }

    const { thought, tool, args, reply } = result.data;

    if (!tool) {
      return { reply: buildReply(reply.trim() || 'Ho gaya.', receipts), receipts, steps };
    }

    const chosen = byName.get(tool);
    if (!chosen) {
      // Feed the mistake back rather than failing; the next step usually
      // picks a real tool.
      messages.push(
        { role: 'assistant', content: JSON.stringify({ thought, tool, args }) },
        {
          role: 'user',
          content: `"${tool}" naam ka koi tool nahi hai. Sirf ye hain: ${TOOLS.map((t) => t.name).join(', ')}. Dobara chuno.`,
        },
      );
      continue;
    }

    const parsed = chosen.schema.safeParse(args);
    let receipt: Receipt;

    if (!parsed.success) {
      receipt = fail(
        chosen.name,
        'Galat arguments diye gaye.',
        parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; '),
      );
    } else {
      const toolStarted = Date.now();
      try {
        receipt = await chosen.run(parsed.data, ctx);
        steps.push(`${chosen.name}:${Date.now() - toolStarted}ms`);
      } catch (error) {
        // A real cancellation propagates — it is not this tool's failure
        // to report, it is the whole run ending.
        if (input.signal.aborted) throw error;

        const message = error instanceof Error ? error.message : String(error);
        log.error('Tool threw', { tool: chosen.name, error: message });
        receipt = fail(
          chosen.name,
          message === 'NOT_CONNECTED' ? 'Google account connect nahi hai.' : `FAIL: ${message.slice(0, 200)}`,
        );
      }
    }

    receipts.push(receipt);
    log.info('Loop step', { step, tool: chosen.name, ok: receipt.ok, effect: receipt.effect });

    // Every later step re-sends the whole conversation, so a long
    // observation is paid for again on each one.
    const trimmed =
      receipt.observation.length > MAX_OBSERVATION_CHARS
        ? `${receipt.observation.slice(0, MAX_OBSERVATION_CHARS)}\n…(baaki kaat diya)`
        : receipt.observation;

    messages.push(
      { role: 'assistant', content: JSON.stringify({ thought, tool, args }) },
      { role: 'user', content: `Tool "${chosen.name}" ka nateeja:\n${trimmed}` },
    );
  }

  // Out of steps or out of time. Summarising costs one more model call,
  // so only make it if there is room — otherwise say plainly what ran.
  const outOfTime = Date.now() > input.deadline - 6_000;

  if (outOfTime) {
    const plain =
      steps.length > 0
        ? `Ye kar diya: ${steps.join(', ')}. Baaki poora nahi kar paya, dobara bolo.`
        : 'Itni der mein jawab nahi bana paya. Dobara bhejo?';
    return { reply: buildReply(plain, receipts), receipts, steps };
  }

  messages.push({
    role: 'user',
    content:
      'Ab aur tool mat chalao. Jo maloomat mil chuki hain unhi se jawab do: ' +
      '{"thought":"","tool":null,"reply":"..."}',
  });

  const final = await completeJson(StepSchema, messages, {
    temperature: 0.3,
    maxTokens: 700,
    signal: input.signal,
  });

  return {
    reply: buildReply(final.ok && final.data.reply ? final.data.reply.trim() : 'Poori tarah nahi kar paya.', receipts),
    receipts,
    steps,
  };
}
