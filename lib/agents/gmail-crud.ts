/**
 * Gmail tools beyond reading.
 *
 * Everything here is reversible on purpose. Archiving, marking read and
 * trashing can all be undone from Gmail; permanent deletion cannot, so
 * it is not offered at all. Sending is likewise absent — the assistant
 * drafts, and Tayyab sends.
 */
import { z } from 'zod';
import { modifyLabels, trashMessage } from '../google/gmail';
import type { Tool } from './types';

export const archiveEmail: Tool<{ id: string }> = {
  name: 'archive_email',
  description:
    'Email ko inbox se hata kar archive karo. Delete nahi hota — Gmail search mein milta ' +
    'rahega. id search_inbox se lo.',
  args: 'id: string',
  schema: z.object({ id: z.string().min(5).max(80) }),
  async run({ id }) {
    const ok = await modifyLabels(id, [], ['INBOX']);
    return ok ? 'Email archive kar diya (inbox se hat gaya).' : `FAIL: archive nahi hua (${id}).`;
  },
};

export const markEmailRead: Tool<{ id: string; read: boolean }> = {
  name: 'mark_email_read',
  description: 'Email ko read ya unread mark karo.',
  args: 'id: string, read: boolean',
  schema: z.object({ id: z.string().min(5).max(80), read: z.boolean().default(true) }),
  async run({ id, read }) {
    const ok = read
      ? await modifyLabels(id, [], ['UNREAD'])
      : await modifyLabels(id, ['UNREAD'], []);
    return ok
      ? `Email ${read ? 'read' : 'unread'} mark ho gaya.`
      : `FAIL: mark nahi hua (${id}).`;
  },
};

export const trashEmail: Tool<{ id: string }> = {
  name: 'trash_email',
  description:
    'Email ko Trash mein daalo. Gmail mein 30 din tak wapas nikaala ja sakta hai. ' +
    'SIRF tab chalao jab Tayyab ne saaf kaha ho ke isko delete karo — khud se andaza ' +
    'laga kar kabhi nahi.',
  args: 'id: string',
  schema: z.object({ id: z.string().min(5).max(80) }),
  async run({ id }) {
    const ok = await trashMessage(id);
    return ok
      ? 'Email Trash mein chala gaya. Gmail se 30 din tak wapas mil sakta hai.'
      : `FAIL: trash nahi hua (${id}).`;
  },
};
