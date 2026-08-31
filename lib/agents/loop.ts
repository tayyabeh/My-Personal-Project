/**
 * The agent loop.
 *
 * Deliberately does NOT use the provider's native tool calling. The spec
 * warned about this and it still holds: open models are unreliable at it,
 * and the two providers behind our LLMProvider interface expose it
 * differently. Instead the model returns plain JSON that we validate
 * ourselves, which works identically on Groq and Gemini.
 *
 * Each turn the model may either call one tool or finish. Tool results
 * are appended as observations, so its final reply is written with the
 * real outcomes in front of it — including failures. That is what stops
 * it inventing "done!" for something that never ran.
 */
import { z } from 'zod';
import { completeJson } from '../llm/json';
import { log } from '../logger';
import { ROMAN_URDU } from '../lang';
import type { Agent, AgentContext, AgentResult, Tool } from './types';

const StepSchema = z.object({
  /**
   * One line of reasoning. Kept because it measurably improves tool
   * choice. The cap is generous on purpose: a tight one made the whole
   * step fail validation and burn a retry, which on a rate-limited free
   * tier costs far more than a long thought does.
   */
  thought: z.string().max(2000).default(''),
  /** Tool to call, or null when finished. */
  tool: z.string().nullable().default(null),
  args: z.record(z.string(), z.unknown()).default({}),
  /** The reply to send. Required when tool is null. */
  reply: z.string().max(3000).default(''),
});

function describeTools(tools: Tool<never>[]): string {
  return tools
    .map((t) => `- ${t.name}(${t.args})\n    ${t.description}`)
    .join('\n');
}

function systemPrompt(agent: Agent): string {
  return (
    `Tum "${agent.name}" agent ho. ${agent.description}\n\n` +
    `${agent.instructions}\n\n` +
    `Ye tools tumhare paas hain:\n${describeTools(agent.tools)}\n\n` +
    `Har baar sirf JSON do, aur bas ek hi cheez karo:\n` +
    `  Tool chalana ho:  {"thought":"...","tool":"tool_name","args":{...}}\n` +
    `  Baat khatam ho:   {"thought":"...","tool":null,"reply":"..."}\n\n` +
    `QAWANEEN — inko todna sab se badi ghalti hai:\n` +
    `- Jo tool tumne nahi chalaya, uska kaam hua hai ye MAT kaho. Koi wada ` +
    `mat karo ke "abhi kar deta hoon" — ya to tool chalao, ya saaf keh do ke nahi kar sakte.\n` +
    `- Tool ka nateeja hi sach hai. Agar tool fail hua to user ko batao ke fail hua.\n` +
    `- Ek waqt mein ek tool. Uska jawab dekh kar agla faisla karo.\n` +
    `- Jab kaafi maloomat mil jayen to tool:null kar ke reply likho. Bewajah ` +
    `tools mat chalate raho.\n` +
    `- reply chhota rakho, WhatsApp pe parha jayega.\n\n` +
    ROMAN_URDU
  );
}

export async function runAgent(agent: Agent, ctx: AgentContext): Promise<AgentResult> {
  const maxSteps = agent.maxSteps ?? 4;
  const byName = new Map(agent.tools.map((t) => [t.name, t]));
  const steps: string[] = [];

  // The conversation so far, so references like "uske andar" resolve.
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt(agent) },
    ...ctx.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: ctx.input },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    // Out of time. Answer with what has been gathered rather than
    // starting a step that will be killed half-finished.
    if (ctx.deadline && Date.now() > ctx.deadline) {
      log.warn('Agent stopped on deadline', { agent: agent.name, step, steps });
      break;
    }

    const result = await completeJson(StepSchema, messages, {
      temperature: 0.2,
      maxTokens: 900,
    });

    if (!result.ok) {
      log.error('Agent step unparseable', { agent: agent.name, step, error: result.error });
      return {
        reply: 'Samajh nahi aaya. Thora aur wazeh bolo?',
        steps,
      };
    }

    const { thought, tool, args, reply } = result.data;

    // Finished.
    if (!tool) {
      return {
        reply: reply.trim() || 'Ho gaya.',
        steps,
      };
    }

    const chosen = byName.get(tool);
    if (!chosen) {
      // Feed the mistake back rather than failing; the next step usually
      // picks a real tool.
      messages.push(
        { role: 'assistant', content: JSON.stringify({ thought, tool, args }) },
        {
          role: 'user',
          content: `"${tool}" naam ka koi tool nahi hai. Sirf ye hain: ${agent.tools
            .map((t) => t.name)
            .join(', ')}. Dobara chuno.`,
        },
      );
      continue;
    }

    let observation: string;
    const parsed = chosen.schema.safeParse(args);

    if (!parsed.success) {
      observation =
        'Galat arguments: ' +
        parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ');
    } else {
      try {
        observation = await (chosen as Tool<unknown>).run(parsed.data, ctx);
        steps.push(chosen.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('Tool threw', { agent: agent.name, tool: chosen.name, error: message });
        observation =
          message === 'NOT_CONNECTED'
            ? 'FAIL: Google account connect nahi hai.'
            : `FAIL: ${message.slice(0, 200)}`;
      }
    }

    log.info('Agent step', { agent: agent.name, step, tool: chosen.name });

    messages.push(
      { role: 'assistant', content: JSON.stringify({ thought, tool, args }) },
      { role: 'user', content: `Tool "${chosen.name}" ka nateeja:\n${observation}` },
    );
  }

  // Out of steps or out of time. Summarising costs one more model call,
  // so only make it if there is room — otherwise say plainly what ran.
  const outOfTime = ctx.deadline !== undefined && Date.now() > ctx.deadline - 6_000;

  if (outOfTime) {
    return {
      reply:
        steps.length > 0
          ? `Ye kar diya: ${steps.join(', ')}. Baaki poora nahi kar paya, dobara bolo.`
          : 'Itni der mein jawab nahi bana paya. Dobara bhejo?',
      steps,
    };
  }

  messages.push({
    role: 'user',
    content:
      'Ab aur tool mat chalao. Jo maloomat mil chuki hain unhi se jawab do: ' +
      '{"thought":"","tool":null,"reply":"..."}',
  });

  const final = await completeJson(StepSchema, messages, { temperature: 0.3, maxTokens: 700 });

  return {
    reply: final.ok && final.data.reply ? final.data.reply.trim() : 'Poori tarah nahi kar paya.',
    steps,
  };
}
