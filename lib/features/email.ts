/**
 * Email features.
 *
 * Two different jobs, kept apart because they want different mail and
 * different prompts:
 *
 *  - needsReply()   : "what needs my reply today?"
 *  - topicDigest()  : "search all AI updates for today" — the newsletter
 *                     digest Tayyab described wanting.
 *
 * Neither ever sends anything. Drafting is a separate, explicit step and
 * a draft is only ever saved to Gmail, never sent.
 */
import { searchMail, type MailSummary } from '../google/gmail';
import { llm } from '../llm';
import { z } from 'zod';
import { completeJson } from '../llm/json';

/** Turn a request like "AI updates from today" into a Gmail query. */
const QuerySchema = z.object({
  query: z.string().min(1).max(200),
  topic: z.string().min(1).max(80),
});

export async function buildQuery(request: string): Promise<{ query: string; topic: string }> {
  const result = await completeJson(
    QuerySchema,
    [
      {
        role: 'system',
        content:
          'Turn a request about someone\'s inbox into a Gmail search query.\n\n' +
          'Reply ONLY with JSON: {"query":"<gmail query>","topic":"<short label>"}\n\n' +
          'Use Gmail search syntax: newer_than:2d, older_than:, from:, subject:, is:unread, ' +
          'category:primary, category:updates, has:attachment. Combine keywords with OR in ' +
          'braces, e.g. {AI "machine learning" LLM}.\n' +
          'Default to newer_than:2d when no period is given. Keep it broad enough to match.',
      },
      { role: 'user', content: 'search all AI updates for today' },
      {
        role: 'assistant',
        content: JSON.stringify({
          query: 'newer_than:1d {AI "artificial intelligence" LLM "machine learning" OpenAI Anthropic}',
          topic: 'AI updates',
        }),
      },
      { role: 'user', content: 'any emails from the bank this week' },
      {
        role: 'assistant',
        content: JSON.stringify({ query: 'newer_than:7d {bank statement transaction}', topic: 'bank emails' }),
      },
      { role: 'user', content: request },
    ],
    { temperature: 0, maxTokens: 300 },
  );

  return result.ok
    ? result.data
    : { query: 'newer_than:2d category:primary', topic: 'recent email' };
}

function render(mail: MailSummary[]): string {
  return mail
    .map((m, i) => `[${i + 1}] From: ${m.from}\nSubject: ${m.subject}\n${m.snippet}`)
    .join('\n\n');
}

/** A digest of whatever the user asked about. */
export async function topicDigest(request: string): Promise<string> {
  const { query, topic } = await buildQuery(request);
  const mail = await searchMail(query, 12);

  if (mail.length === 0) {
    return `Nothing in your inbox matched "${topic}". (Searched: ${query})`;
  }

  const summary = await llm().complete(
    [
      {
        role: 'system',
        content:
          `Summarise what these emails say about "${topic}", for someone reading on WhatsApp.\n\n` +
          'Group related items together. Lead with what actually matters. Use short lines, ' +
          'no markdown headings. Around 150 words.\n' +
          'Summarise ONLY what the emails say — never add outside knowledge. If they are thin ' +
          'on detail, say so rather than padding.',
      },
      { role: 'user', content: render(mail) },
    ],
    { temperature: 0.4, maxTokens: 800 },
  );

  return `${topic} — ${mail.length} email${mail.length === 1 ? '' : 's'}\n\n${summary}`;
}

/** What actually needs a reply. */
export async function needsReply(): Promise<string> {
  const mail = await searchMail(
    'newer_than:3d is:unread -category:promotions -category:social',
    15,
  );

  if (mail.length === 0) return 'Nothing unread in the last three days that looks like it needs you.';

  const summary = await llm().complete(
    [
      {
        role: 'system',
        content:
          'These are unread emails. Say which ones genuinely need a reply from the reader and ' +
          'why, in one short line each. Ignore newsletters, notifications, receipts and ' +
          'marketing entirely — do not list them. If none need a reply, say so plainly. ' +
          'No markdown. Under 150 words.',
      },
      { role: 'user', content: render(mail) },
    ],
    { temperature: 0.3, maxTokens: 700 },
  );

  return summary;
}
