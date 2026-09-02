/**
 * Gmail: search, read, digest, drafts, label changes, and newsletters.
 *
 * Everything that changes the mailbox is reversible — archive, mark-read,
 * trash (30-day recoverable). Sending is deliberately absent: the
 * assistant drafts, Tayyab sends.
 */
import { z } from 'zod';
import {
  searchMail,
  readMessage,
  createDraft,
  modifyLabels,
  trashMessage,
  listLabels,
} from '../google/gmail';
import { topicDigest } from '../features/email';
import { db } from '../supabase';
import { insertOnce } from '../db/idempotency';
import { ok, fail, type Tool } from './types';

const searchInbox: Tool<{ query: string }> = {
  name: 'search_mail',
  description:
    'Inbox mein emails dhoondo. Gmail syntax: newer_than:2d, from:, subject:, is:unread, ' +
    'category:primary. Har result ka id wapas milta hai.',
  args: 'query: string',
  schema: z.object({ query: z.string().min(1).max(300) }),
  async run({ query }, ctx) {
    const mail = await searchMail(query, 10, ctx.signal);
    if (mail.length === 0) {
      return ok({ tool: 'search_mail', effect: 'read', factLine: `Koi email nahi mila. Query: ${query}`, numbers: [0] });
    }
    return ok({
      tool: 'search_mail',
      effect: 'read',
      factLine: `${mail.length} email mile.`,
      numbers: [mail.length],
      untrusted: true,
      observation: mail
        .map(
          (m, i) =>
            `${i + 1}. id=${m.id}\n   From: ${m.from}\n   Subject: ${m.subject}\n   Date: ${m.date}\n   ${m.snippet.slice(0, 160)}`,
        )
        .join('\n'),
    });
  },
};

const readEmail: Tool<{ id: string }> = {
  name: 'read_email',
  description: 'Ek email ka POORA matn parho, us id se jo search_mail ne di.',
  args: 'id: string',
  schema: z.object({ id: z.string().min(5).max(80) }),
  async run({ id }, ctx) {
    const mail = await readMessage(id, 3000, ctx.signal);
    if (!mail) return fail('read_email', `Is id se email nahi khul saki: ${id}`);
    return ok({
      tool: 'read_email',
      effect: 'read',
      factLine: `Email khol li: "${mail.subject}".`,
      untrusted: true,
      observation: `From: ${mail.from}\nSubject: ${mail.subject}\nDate: ${mail.date}\n\n--- poora matn ---\n${mail.body || '(khali)'}`,
    });
  },
};

const emailDigest: Tool<{ request: string }> = {
  name: 'email_digest',
  description:
    'Kisi topic par inbox ka khulasa banao, jaise "aaj ke AI updates" ya "is hafte bank ke ' +
    'emails". Poora jumla do.',
  args: 'request: string',
  schema: z.object({ request: z.string().min(2).max(300) }),
  async run({ request }) {
    const digest = await topicDigest(request);
    return ok({
      tool: 'email_digest',
      effect: 'read',
      factLine: digest,
      untrusted: true,
    });
  },
};

const draftReply: Tool<{ to: string; subject: string; body: string }> = {
  name: 'draft_reply',
  description:
    'Gmail mein ek DRAFT banao. Ye bhejta NAHI — sirf draft save karta hai jise Tayyab khud ' +
    'dekh kar bhejega.',
  args: 'to: string, subject: string, body: string',
  schema: z.object({
    to: z.string().min(3).max(200),
    subject: z.string().max(200),
    body: z.string().min(1).max(4000),
  }),
  async run({ to, subject, body }, ctx) {
    const { ok: done, result } = await insertOnce(
      `${ctx.runId}:draft_reply:${to}:${subject}`,
      { runId: ctx.runId, tool: 'draft_reply', effect: 'write' },
      async () => {
        const id = await createDraft(to, subject, body, ctx.signal);
        return { ok: true, result: { id }, target: id };
      },
    );
    if (!done) return fail('draft_reply', 'Draft ban nahi saka.');
    return ok({
      tool: 'draft_reply',
      effect: 'write',
      factLine: `Draft ban gaya (id ${(result as { id: string }).id}). Bheja NAHI gaya — Gmail mein dekh lo.`,
    });
  },
};

const markRead: Tool<{ id: string; read: boolean }> = {
  name: 'mark_read',
  description: 'Email ko read ya unread mark karo.',
  args: 'id: string, read: boolean',
  schema: z.object({ id: z.string().min(5).max(80), read: z.boolean().default(true) }),
  async run({ id, read }, ctx) {
    const { ok: done } = await insertOnce(
      `${ctx.runId}:mark_read:${id}:${read}`,
      { runId: ctx.runId, tool: 'mark_read', effect: 'write', target: id },
      async () => {
        const changed = read
          ? await modifyLabels(id, [], ['UNREAD'], ctx.signal)
          : await modifyLabels(id, ['UNREAD'], [], ctx.signal);
        return { ok: changed, result: { id }, error: changed ? undefined : 'label change failed' };
      },
    );
    return done
      ? ok({ tool: 'mark_read', effect: 'write', factLine: `Email ${read ? 'read' : 'unread'} mark ho gaya.` })
      : fail('mark_read', `Mark nahi hua (${id}). Shayad gmail.modify scope nahi hai.`);
  },
};

const archiveEmail: Tool<{ id: string }> = {
  name: 'archive_email',
  description: 'Email ko inbox se hata kar archive karo. Delete nahi hota — search mein milta rahega.',
  args: 'id: string',
  schema: z.object({ id: z.string().min(5).max(80) }),
  async run({ id }, ctx) {
    const { ok: done } = await insertOnce(
      `${ctx.runId}:archive_email:${id}`,
      { runId: ctx.runId, tool: 'archive_email', effect: 'write', target: id },
      async () => {
        const changed = await modifyLabels(id, [], ['INBOX'], ctx.signal);
        return { ok: changed, result: { id }, error: changed ? undefined : 'archive failed' };
      },
    );
    return done
      ? ok({ tool: 'archive_email', effect: 'write', factLine: 'Email archive kar diya (inbox se hat gaya).' })
      : fail('archive_email', `Archive nahi hua (${id}). Shayad gmail.modify scope nahi hai.`);
  },
};

const trashEmail: Tool<{ id: string }> = {
  name: 'trash_email',
  description:
    'Email ko Trash mein daalo (30 din tak wapas mil sakta hai). SIRF tab jab Tayyab ne saaf ' +
    'kaha ho ke isko delete karo — khud se andaza laga kar kabhi nahi.',
  args: 'id: string',
  schema: z.object({ id: z.string().min(5).max(80) }),
  async run({ id }, ctx) {
    const { ok: done } = await insertOnce(
      `${ctx.runId}:trash_email:${id}`,
      { runId: ctx.runId, tool: 'trash_email', effect: 'write', target: id },
      async () => {
        const changed = await trashMessage(id, ctx.signal);
        return { ok: changed, result: { id }, error: changed ? undefined : 'trash failed' };
      },
    );
    return done
      ? ok({ tool: 'trash_email', effect: 'write', factLine: 'Email Trash mein chala gaya. 30 din tak wapas mil sakta hai.' })
      : fail('trash_email', `Trash nahi hua (${id}). Shayad gmail.modify scope nahi hai.`);
  },
};

const listLabelsTool: Tool<Record<string, never>> = {
  name: 'list_labels',
  description: 'Gmail ke sare labels dikhao (system aur khud banaye hue).',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run(_args, ctx) {
    const labels = await listLabels(ctx.signal);
    if (labels.length === 0) return ok({ tool: 'list_labels', effect: 'read', factLine: 'Koi label nahi mila.', numbers: [0] });
    return ok({
      tool: 'list_labels',
      effect: 'read',
      factLine: `${labels.length} labels hain.`,
      numbers: [labels.length],
      observation: labels.map((l) => `• ${l.name} (${l.type})`).join('\n'),
    });
  },
};

// ---------------------------------------------------------------------
// Newsletters — stored in `records` (kind 'newsletter'), no new table.
// ---------------------------------------------------------------------

const listNewsletters: Tool<Record<string, never>> = {
  name: 'list_newsletters',
  description: 'Wo newsletters dikhao jinka khulasa 12 baje ke digest mein alag banta hai.',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run() {
    const { data, error } = await db()
      .from('records')
      .select('data')
      .eq('kind', 'newsletter')
      .order('happened_at', { ascending: false });
    if (error) return fail('list_newsletters', error.message);
    const names = (data ?? []).map((r) => String((r.data as { name?: string })?.name ?? '')).filter(Boolean);
    if (names.length === 0) return ok({ tool: 'list_newsletters', effect: 'read', factLine: 'Koi newsletter set nahi hai.', numbers: [0] });
    return ok({
      tool: 'list_newsletters',
      effect: 'read',
      factLine: `${names.length} newsletters: ${names.join(', ')}`,
      numbers: [names.length],
      entities: names,
    });
  },
};

const addNewsletter: Tool<{ name: string; sender?: string }> = {
  name: 'add_newsletter',
  description:
    'Ek newsletter add karo jiska digest mein alag khulasa bane. name us newsletter ka naam, ' +
    'sender us ka email address ya from-ka-hissa.',
  args: 'name: string, sender?: string',
  schema: z.object({ name: z.string().min(1).max(80), sender: z.string().max(200).optional() }),
  async run({ name, sender }, ctx) {
    const { ok: done } = await insertOnce(
      `${ctx.runId}:add_newsletter:${name.toLowerCase()}`,
      { runId: ctx.runId, tool: 'add_newsletter', effect: 'write' },
      async () => {
        const { error } = await db().from('records').insert({ kind: 'newsletter', data: { name, sender: sender ?? '' } });
        return error ? { ok: false, result: null, error: error.message } : { ok: true, result: { name } };
      },
    );
    return done
      ? ok({ tool: 'add_newsletter', effect: 'write', factLine: `"${name}" newsletters mein add kar diya.`, entities: [name] })
      : fail('add_newsletter', 'Add nahi ho saka.');
  },
};

const removeNewsletter: Tool<{ name: string }> = {
  name: 'remove_newsletter',
  description: 'Ek newsletter hata do. name wahi jo list_newsletters mein dikha.',
  args: 'name: string',
  schema: z.object({ name: z.string().min(1).max(80) }),
  async run({ name }, ctx) {
    const { data } = await db().from('records').select('id, data').eq('kind', 'newsletter');
    const row = (data ?? []).find(
      (r) => String((r.data as { name?: string })?.name ?? '').toLowerCase() === name.toLowerCase(),
    );
    if (!row) return fail('remove_newsletter', `"${name}" newsletters mein nahi mila.`);

    const { ok: done } = await insertOnce(
      `${ctx.runId}:remove_newsletter:${row.id}`,
      { runId: ctx.runId, tool: 'remove_newsletter', effect: 'write', target: String(row.id) },
      async () => {
        const { error } = await db().from('records').delete().eq('id', row.id);
        return error ? { ok: false, result: null, error: error.message } : { ok: true, result: { name } };
      },
    );
    return done
      ? ok({ tool: 'remove_newsletter', effect: 'write', factLine: `"${name}" newsletters se hata diya.`, entities: [name] })
      : fail('remove_newsletter', 'Hataya nahi ja saka.');
  },
};

export const gmailTools: Tool<any>[] = [
  searchInbox,
  readEmail,
  emailDigest,
  draftReply,
  markRead,
  archiveEmail,
  trashEmail,
  listLabelsTool,
  listNewsletters,
  addNewsletter,
  removeNewsletter,
];
