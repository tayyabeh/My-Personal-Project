/**
 * Email agent.
 *
 * The old email feature could only ever see subjects and snippets, so
 * "andar kya likha hai" was impossible to answer — it replied asking for
 * a screenshot. Now searching and reading are separate tools, and the
 * agent decides for itself when it needs to open something.
 */
import { z } from 'zod';
import { searchMail, readMessage, createDraft } from '../google/gmail';
import type { Agent, Tool } from './types';

const searchInbox: Tool<{ query: string }> = {
  name: 'search_inbox',
  description:
    'Inbox mein emails dhoondo. Gmail syntax: newer_than:2d, from:, subject:, is:unread, ' +
    'category:primary. Keywords ko braces mein OR karo: {AI LLM OpenAI}. Har result ka id ' +
    'wapas milta hai — usi id se email khol sakte ho.',
  args: 'query: string',
  schema: z.object({ query: z.string().min(1).max(300) }),
  async run({ query }) {
    const mail = await searchMail(query, 10);
    if (mail.length === 0) return `Koi email nahi mila. Query thi: ${query}`;

    return mail
      .map(
        (m, i) =>
          `${i + 1}. id=${m.id}\n   From: ${m.from}\n   Subject: ${m.subject}\n   Date: ${m.date}\n   ${m.snippet.slice(0, 160)}`,
      )
      .join('\n');
  },
};

const readEmail: Tool<{ id: string }> = {
  name: 'read_email',
  description:
    'Ek email ka POORA matn parho, us id se jo search_inbox ne di. Jab user pooche ke ' +
    '"andar kya likha hai" ya kisi email ki tafseel maange, to yahi chalao.',
  args: 'id: string',
  schema: z.object({ id: z.string().min(5).max(80) }),
  async run({ id }) {
    const mail = await readMessage(id);
    if (!mail) return `Is id se email nahi khul saki: ${id}`;

    return (
      `From: ${mail.from}\nSubject: ${mail.subject}\nDate: ${mail.date}\n\n` +
      `--- poora matn ---\n${mail.body || '(khali)'}`
    );
  },
};

const draftReply: Tool<{ to: string; subject: string; body: string }> = {
  name: 'draft_reply',
  description:
    'Gmail mein ek DRAFT banao. Ye bhejta NAHI hai — sirf draft save karta hai jise Tayyab ' +
    'khud dekh kar bhejega.',
  args: 'to: string, subject: string, body: string',
  schema: z.object({
    to: z.string().min(3).max(200),
    subject: z.string().max(200),
    body: z.string().min(1).max(4000),
  }),
  async run({ to, subject, body }) {
    const id = await createDraft(to, subject, body);
    return `Draft ban gaya (id ${id}). Bheja NAHI gaya — Gmail mein jaa kar dekh lo.`;
  },
};

export const emailAgent: Agent = {
  name: 'email',
  description:
    'Gmail sambhalta hai: emails dhoondna, kisi email ka poora matn parhna, ' +
    'newsletters ka khulasa, aur draft jawab banana.',
  instructions:
    'Kaam ka tareeqa:\n' +
    '- Agar user kisi KHAAS email ke baare mein pooch raha hai ("andar kya likha hai", ' +
    '"is email mein kya hai"), to pehle search_inbox se use dhoondo, phir read_email se ' +
    'kholo. Sirf subject aur snippet se jawab MAT do — wo poori baat nahi hoti.\n' +
    '- Agar sirf khulasa chahiye ("aaj kya kya aaya"), to search_inbox kaafi hai.\n' +
    '- Email kabhi bhejna nahi. Sirf draft bana sakte ho, aur user ko batana hai ke ' +
    'bheja nahi gaya.\n' +
    '- Jo email mein likha hai sirf wahi batao. Apni taraf se kuch mat jodo.',
  tools: [searchInbox, readEmail, draftReply] as unknown as Tool<never>[],
  maxSteps: 4,
};
