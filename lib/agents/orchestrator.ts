/**
 * The orchestrator.
 *
 * Reads the message plus the recent conversation and picks one agent, or
 * decides no agent is needed and just talks.
 *
 * Two things it must never do, both of which the old design did:
 *   - Promise an action. If nothing can do the job, it says so.
 *   - Lose the thread. It sees history, so "uske andar kya likha hai"
 *     still points at the email discussed a moment ago.
 */
import { z } from 'zod';
import { completeJson } from '../llm/json';
import { llm } from '../llm';
import { log } from '../logger';
import { ROMAN_URDU } from '../lang';
import { AGENTS, findAgent } from './registry';
import { runAgent } from './loop';
import type { AgentContext, AgentResult } from './types';

const RouteSchema = z.object({
  reason: z.string().max(200).default(''),
  /** Agent name, or null to answer conversationally. */
  agent: z.string().nullable().default(null),
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
          'kar nahi sakte. Agar user kaam karwana chahta hai to saaf kaho ke wo kaam kaise ' +
          'maangna hai, ya keh do ke ye tum nahi kar sakte.\n\n' +
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

export async function handle(ctx: AgentContext): Promise<AgentResult> {
  const route = await completeJson(
    RouteSchema,
    [
      {
        role: 'system',
        content:
          'Tum ek router ho. Message parh kar batao kaunsa agent isko sambhale.\n\n' +
          'Sirf JSON: {"reason":"...","agent":"<naam>"} ya {"reason":"...","agent":null}\n\n' +
          'Ye agents maujood hain:\n' + roster() + '\n\n' +
          'Qawaneen:\n' +
          '- agent:null sirf tab jab ye sirf gap-shap ho (salam, shukriya, haal-chaal).\n' +
          '- Agar user koi KAAM karwana chahta hai to agent chuno, chahe thora shak ho.\n' +
          '- Pichli baat ka khayal rakho. Agar abhi email ki baat ho rahi thi aur user ' +
          'kahe "andar kya likha hai", to ye email agent ka kaam hai.\n' +
          '- "AI updates", "khabren", "aaj kya hua" = research (internet). ' +
          '"mere inbox mein", "email aaya" = email.',
      },
      ...ctx.history.map((t) => ({ role: t.role, content: t.content })),
      { role: 'user', content: ctx.input },
    ],
    { temperature: 0, maxTokens: 250 },
  );

  const name = route.ok ? route.data.agent : null;

  if (!name) {
    log.info('Routed to chat', { reason: route.ok ? route.data.reason : 'route failed' });
    return { reply: await chat(ctx), steps: [] };
  }

  const agent = findAgent(name);
  if (!agent) {
    log.warn('Router picked an unknown agent', { name });
    return { reply: await chat(ctx), steps: [] };
  }

  log.info('Routed to agent', { agent: agent.name, reason: route.ok ? route.data.reason : '' });
  return runAgent(agent, ctx);
}
