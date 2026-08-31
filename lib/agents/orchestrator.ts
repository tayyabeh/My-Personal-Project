/**
 * The orchestrator.
 *
 * It does not just pick one agent — it plans a short sequence of them and
 * feeds each one's result into the next. "AI updates search karo aur uski
 * voice bana do" becomes research -> coach, with what research found
 * handed to coach to speak.
 *
 * Two limits shape this, and both are real rather than cautious:
 *
 *   Length. At most three agents. Each one is its own reasoning loop of
 *   several model calls, and Groq's free tier limits tokens per minute
 *   hard enough that a long chain spends the whole budget backing off.
 *
 *   Time. Vercel allows 60 seconds. Speech generation alone can take 30,
 *   so after BUDGET_MS the chain stops and returns what it has instead of
 *   being killed mid-step with nothing to show.
 *
 * It must also never promise. If nothing can do the job it says so —
 * that was the bug that started this rewrite.
 */
import { z } from 'zod';
import { completeJson } from '../llm/json';
import { llm } from '../llm';
import { log } from '../logger';
import { ROMAN_URDU } from '../lang';
import { AGENTS, findAgent } from './registry';
import { runAgent } from './loop';
import type { AgentContext, AgentResult } from './types';

/** Stop starting new agents after this much elapsed. */
const BUDGET_MS = 30_000;
const MAX_AGENTS = 3;

/**
 * Everything must finish inside this, including sending the reply.
 *
 * Vercel kills the function at 60 seconds. Before this existed the
 * pipeline simply ran until it was killed, and a killed function sends
 * nothing — the user saw silence rather than a partial answer, which is
 * indistinguishable from being ignored.
 */
const HARD_DEADLINE_MS = 45_000;

const PlanSchema = z.object({
  reason: z.string().max(300).default(''),
  steps: z
    .array(
      z.object({
        agent: z.string().min(1).max(40),
        /** What this agent should do, in its own right. */
        task: z.string().min(1).max(500),
      }),
    )
    .max(MAX_AGENTS)
    .default([]),
});

function roster(): string {
  return AGENTS.map((a) => `- ${a.name}: ${a.description}`).join('\n');
}

/** Just talk. No tools, so it must not claim anything was done. */
async function chat(ctx: AgentContext): Promise<string> {
  return llm().complete(
    [
      {
        role: 'system',
        content:
          'Tum Tayyab ke assistant ho, WhatsApp pe. Ye sirf baat-cheet hai — is waqt ' +
          'tumhare paas koi tool nahi hai.\n\n' +
          'SAB SE AHEM: koi kaam karne ka wada MAT karo. "abhi kar deta hoon", "add kar ' +
          'raha hoon", "check karke batata hoon" — ye sab mat kaho, kyunki tum abhi kuch ' +
          'kar nahi sakte. Agar user kaam karwana chahta hai to saaf kaho ke kaise maange, ' +
          'ya keh do ke ye tum nahi kar sakte.\n\n' +
          'Kya kya ho sakta hai:\n' + roster() + '\n\n' +
          'Do ya teen jumle. Voice notes tum sun sakte ho — wo transcribe ho kar aate hain.\n\n' +
          ROMAN_URDU,
      },
      ...ctx.history.map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: ctx.input },
    ],
    { temperature: 0.6, maxTokens: 500 },
  );
}

export async function makePlan(ctx: AgentContext) {
  return completeJson(
    PlanSchema,
    [
      {
        role: 'system',
        content:
          'Tum ek planner ho. User ka message parh kar tay karo ke kaam kaunse agents ' +
          'se, kis tarteeb mein hoga.\n\n' +
          'Sirf JSON:\n' +
          '  {"reason":"...","steps":[{"agent":"<naam>","task":"<is agent ka kaam>"}]}\n' +
          '  Sirf gap-shap ho to: {"reason":"...","steps":[]}\n\n' +
          'Ye agents hain:\n' + roster() + '\n\n' +
          'Qawaneen:\n' +
          `- Zyada se zyada ${MAX_AGENTS} steps. Har step mehnga hai, is liye sirf utne ` +
          'jitne waqai chahiye. Ek kaafi ho to ek hi do.\n' +
          '- Ek hi agent ko baar baar mat bulao. Har agent khud apne tools ka loop ' +
          'chalata hai, to ek hi step mein wo dhoond bhi lega, kaam bhi kar lega aur bata ' +
          'bhi dega. Naya step sirf tab jab DUSRE agent ki zaroorat ho.\n' +
          '- Tarteeb ahem hai. Pehle maloomat lao, phir us pe kaam karo. ' +
          '"AI updates search kar ke voice bana do" = research (dhoondo), phir coach (bolo).\n' +
          '- Har step ka "task" apne aap mein saaf ho. Agle agent ko pichle ka nateeja mil ' +
          'jayega, to "jo mila usko bol kar sunao" likhna kaafi hai.\n' +
          '- steps khali sirf tab jab koi kaam hi na ho (salam, shukriya, haal-chaal).\n' +
          '- Pichli baat ka khayal rakho. "usme kya likha hai" jaise sawal pichle jawab ' +
          'se jurte hain.\n' +
          '- Chhote jawab jaise "haan", "ok krdo", "kar do", "theek hai" akele bemani ' +
          'hote hain — inka matlab pichle message se nikaalo. Agar wahan koi kaam tay ho ' +
          'raha tha to usi agent ko bhejo. Inko gap-shap mat samjho, warna user ko jawab ' +
          'milega ke "main kuch nahi kar sakta" jabke kaam bilkul ho sakta tha.\n' +
          '- "AI updates", "khabren", "aaj kya hua" = research. "mere inbox", "email aaya" ' +
          '= email.',
      },
      ...ctx.history.map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: ctx.input },
    ],
    { temperature: 0, maxTokens: 500 },
  );
}

export async function handle(ctx: AgentContext): Promise<AgentResult> {
  const started = Date.now();
  const plan = await makePlan(ctx);

  if (!plan.ok || plan.data.steps.length === 0) {
    log.info('No agent needed', { reason: plan.ok ? plan.data.reason : 'plan failed' });
    return { reply: await chat(ctx), steps: [] };
  }

  log.info('Plan', {
    reason: plan.data.reason,
    chain: plan.data.steps.map((s) => s.agent).join(' -> '),
  });

  // The planner sometimes splits one agent's work across several steps.
  // An agent already loops over its own tools, so consecutive duplicates
  // are pure waste -- three model calls where one would do.
  const chain = plan.data.steps.filter(
    (step, i, all) => i === 0 || step.agent !== all[i - 1].agent,
  );

  if (chain.length !== plan.data.steps.length) {
    log.info('Collapsed repeated agents in plan', {
      from: plan.data.steps.length,
      to: chain.length,
    });
  }

  const allSteps: string[] = [];
  const results: Array<{ agent: string; reply: string }> = [];

  for (const [index, step] of chain.entries()) {
    const agent = findAgent(step.agent);
    if (!agent) {
      log.warn('Plan named an unknown agent', { agent: step.agent });
      continue;
    }

    if (index > 0 && Date.now() - started > BUDGET_MS) {
      log.warn('Chain stopped on time budget', {
        elapsedMs: Date.now() - started,
        skipped: step.agent,
      });
      break;
    }

    // Hand the previous agents' findings to this one, so it can act on
    // them rather than starting over.
    const carried = results.length
      ? results.map((r) => `[${r.agent} ne ye bataya]\n${r.reply}`).join('\n\n') + '\n\n'
      : '';

    const result = await runAgent(agent, {
      ...ctx,
      deadline: started + HARD_DEADLINE_MS,
      input: `${carried}Ab tumhara kaam: ${step.task}\n\n(User ka asal message: "${ctx.input}")`,
    });

    allSteps.push(...result.steps.map((s) => `${agent.name}.${s}`));
    if (result.reply.trim()) results.push({ agent: agent.name, reply: result.reply });
  }

  if (results.length === 0) {
    return { reply: 'Kaam pura nahi kar paya. Dobara bolo?', steps: allSteps };
  }

  // The last agent finished the job, so its reply is the answer. Earlier
  // ones were inputs to it, and repeating them would just be noise.
  return { reply: results[results.length - 1].reply, steps: allSteps };
}
