/**
 * Coach agent: podcasts, books, learnings, and the honest weekly look.
 */
import { z } from 'zod';
import { askReflection, sendBookPodcast } from '../features/podcast';
import { bookFromRequest } from '../features/books';
import { saveLearning } from '../features/learnings';
import { contextSummary } from '../context';
import { sendAsVoice } from './shared-tools';
import type { Agent, Tool } from './types';

const makePodcast: Tool<{ request: string }> = {
  name: 'make_podcast',
  description:
    'Kisi kitab ka summary podcast bana kar voice message bhejo. Sirf tab chalao jab ' +
    'user ne KITAB ka naam liya ho, ya pehle apne haal ke baare mein bata diya ho.',
  args: 'request: string (user ka poora jumla, ya uska bataya hua haal)',
  schema: z.object({ request: z.string().min(2).max(2000) }),
  async run({ request }, ctx) {
    const named = await bookFromRequest(request);
    return await sendBookPodcast(request, named, ctx.to);
  },
};

const askHowTheyAre: Tool<Record<string, never>> = {
  name: 'ask_reflection',
  description:
    'User se poocho ke aaj kal kya soch rahe hain aur kahan kamzori lagti hai. Tab ' +
    'chalao jab podcast maanga ho lekin kitab ka naam na liya ho aur haal bhi na bataya ho.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run(_args, ctx) {
    await askReflection(ctx.to);
    return 'Sawal poochh liya. Ab user ke jawab ka intezaar hai — abhi podcast mat banao.';
  },
};

const noteLearning: Tool<{ text: string }> = {
  name: 'save_learning',
  description:
    'Koi seekhi hui cheez mehfooz karo. 3 din, 1 hafte, 2 hafte aur 1 mahine baad ' +
    'wapas yaad dilai jayegi.',
  args: 'text: string',
  schema: z.object({ text: z.string().min(3).max(2000) }),
  async run({ text }) {
    const saved = await saveLearning(text);
    return saved ? `Save ho gaya: ${saved}` : 'FAIL: samajh nahi aaya kya save karna hai.';
  },
};

const howAmIDoing: Tool<Record<string, never>> = {
  name: 'my_progress',
  description: 'Tayyab ki asli surat-e-haal: completion rate, pending tasks, kya tala ja raha hai.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    return contextSummary();
  },
};

export const coachAgent: Agent = {
  name: 'coach',
  description:
    'Himmat, kitabon ke podcast, seekhi hui baaton ko mehfooz karna, aur progress ka ' +
    'sach batana. Jab user udaas ho ya podcast maange to yahi.',
  instructions:
    '- Podcast maanga aur kitab ka naam bhi diya? Seedha make_podcast.\n' +
    '- Podcast maanga lekin kuch nahi bataya? Pehle ask_reflection, phir ruk jao.\n' +
    '- User ne apna haal bata diya (pareshan hoon, focus nahi hota)? make_podcast chalao ' +
    'aur wahi baat request mein daalo.\n' +
    '- Jhooti tareef mat karo. Jo my_progress bataye wahi sach hai.',
  tools: [makePodcast, askHowTheyAre, noteLearning, howAmIDoing, sendAsVoice] as unknown as Tool<never>[],
  maxSteps: 3,
};
