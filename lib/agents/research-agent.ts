/**
 * Research agent: the outside world.
 *
 * Note the split from the email agent. "AI updates search karo" used to
 * be forced into Gmail by a hard-coded rule, which is not what Tayyab
 * wanted. Now both agents exist and the orchestrator picks, so asking for
 * news gets the web and asking about the inbox gets the inbox.
 */
import { z } from 'zod';
import { answerWithSources } from '../features/search';
import { summariseLink } from '../features/links';
import { sendAsVoice } from './shared-tools';
import type { Agent, Tool } from './types';

const webSearch: Tool<{ query: string }> = {
  name: 'web_search',
  description:
    'Internet pe dhoondo aur sources ke saath jawab lao. Duniya ki khabron, taazgi ' +
    'wali maloomat, ya kisi cheez ki tafseel ke liye.',
  args: 'query: string',
  schema: z.object({ query: z.string().min(2).max(300) }),
  async run({ query }) {
    return answerWithSources(query);
  },
};

const readLink: Tool<{ url: string }> = {
  name: 'read_link',
  description: 'Kisi web page ko khol kar parho aur uska khulasa do.',
  args: 'url: string',
  schema: z.object({ url: z.string().url().max(500) }),
  async run({ url }) {
    return summariseLink(url);
  },
};

export const researchAgent: Agent = {
  name: 'research',
  description:
    'Internet se maloomat lata hai: khabren, AI updates, koi bhi sawal jiska jawab ' +
    'bahar se chahiye, aur bheje gaye links parhta hai.',
  instructions:
    '- web_search ka jawab hi sach hai. Agar usmein jawab nahi mila to saaf keh do, ' +
    'apni yaadasht se jawab mat banao.\n' +
    '- Sources zaroor saath do.\n' +
    '- Agar user ne awaz maangi ho ("voice mein sunao", "bol kar batao"), to pehle ' +
    'search karo, phir jo mila usko apne lafzon mein 150-200 lafz ka khulasa bana kar ' +
    'send_as_voice ko do. Voice bhejne ke baad sirf ek chhoti line likho.',
  tools: [webSearch, readLink, sendAsVoice] as unknown as Tool<never>[],
  // search -> speak -> reply needs three, so leave headroom.
  maxSteps: 5,
};
