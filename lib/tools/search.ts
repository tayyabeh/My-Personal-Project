/**
 * The outside world: web search, reading a link, and researching against
 * the inbox.
 *
 * These are read-only — they fetch and summarise, and are told to admit
 * when the results do not answer rather than filling the gap from memory.
 * Their content is third-party, so receipts are marked untrusted.
 */
import { z } from 'zod';
import { answerWithSources } from '../features/search';
import { summariseLink } from '../features/links';
import { searchMail } from '../google/gmail';
import { llm } from '../llm';
import { ROMAN_URDU } from '../lang';
import { ok, type Tool } from './types';

const webSearch: Tool<{ query: string }> = {
  name: 'web_search',
  description:
    'Internet pe dhoondo aur sources ke saath jawab lao. Khabron, taazgi wali maloomat, ya ' +
    'kisi cheez ki tafseel ke liye.',
  args: 'query: string',
  schema: z.object({ query: z.string().min(2).max(300) }),
  async run({ query }) {
    const answer = await answerWithSources(query);
    return ok({ tool: 'web_search', effect: 'read', factLine: answer, untrusted: true });
  },
};

const readLink: Tool<{ url: string }> = {
  name: 'read_link',
  description: 'Kisi web page ko khol kar parho aur uska khulasa do.',
  args: 'url: string',
  schema: z.object({ url: z.string().url().max(500) }),
  async run({ url }) {
    const summary = await summariseLink(url);
    return ok({ tool: 'read_link', effect: 'read', factLine: summary, untrusted: true });
  },
};

const researchEmail: Tool<{ question: string }> = {
  name: 'research_email',
  description:
    'Kisi sawal ka jawab web se lao aur usko inbox ke emails se milao — jaise "is topic pe ' +
    'jo email aayi thi wo bahar ki khabar se match karti hai?".',
  args: 'question: string',
  schema: z.object({ question: z.string().min(3).max(300) }),
  async run({ question }, ctx) {
    const [web, mail] = await Promise.all([
      answerWithSources(question),
      searchMail(`newer_than:14d ${question}`, 6, ctx.signal).catch(() => []),
    ]);

    if (mail.length === 0) {
      return ok({
        tool: 'research_email',
        effect: 'read',
        factLine: `${web}\n\n(Is baare mein inbox mein kuch nahi mila.)`,
        untrusted: true,
      });
    }

    const inbox = mail
      .map((m, i) => `[${i + 1}] From: ${m.from}\nSubject: ${m.subject}\n${m.snippet}`)
      .join('\n\n');

    const combined = await llm().complete(
      [
        {
          role: 'system',
          content:
            'Neeche ek web jawab hai aur kuch emails. Batao ke inbox ke emails web wali baat ' +
            'se kaise judte hain — kya match karta hai, kya nahi. Sirf diye gaye matn se, ' +
            'apni yaadasht se kuch mat jodo. 4-5 chhote jumle.\n\n' + ROMAN_URDU,
        },
        { role: 'user', content: `Web jawab:\n${web}\n\nInbox:\n${inbox}` },
      ],
      { temperature: 0.3, maxTokens: 700, signal: ctx.signal },
    );

    return ok({
      tool: 'research_email',
      effect: 'read',
      factLine: combined,
      numbers: [mail.length],
      untrusted: true,
    });
  },
};

export const searchTools: Tool<any>[] = [webSearch, readLink, researchEmail];
