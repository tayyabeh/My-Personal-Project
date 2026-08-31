/**
 * Gmail, read-only.
 *
 * Deliberately fetches metadata plus the snippet rather than full message
 * bodies. Whole emails — especially newsletters, which are mostly HTML —
 * would blow through Groq's tokens-per-minute limit in a single digest.
 * Subject, sender and snippet are enough to summarise and trivially
 * cheaper.
 */
import { accessToken } from './oauth';
import { log } from '../logger';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface MailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

function header(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/**
 * Search the mailbox using Gmail's own query syntax, e.g.
 *   'newer_than:1d category:primary'
 *   'is:unread -category:promotions'
 */
export async function searchMail(query: string, max = 12): Promise<MailSummary[]> {
  const token = await accessToken();

  const listResponse = await fetch(
    `${BASE}/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!listResponse.ok) {
    throw new Error(`Gmail search failed: ${(await listResponse.text()).slice(0, 200)}`);
  }

  const list = (await listResponse.json()) as { messages?: Array<{ id: string }> };
  const ids = (list.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return [];

  // Fetched in parallel; a dozen metadata reads is fast and well within
  // Gmail's quota.
  const messages = await Promise.all(
    ids.map(async (id) => {
      const params = new URLSearchParams({ format: 'metadata' });
      for (const name of ['Subject', 'From', 'Date']) params.append('metadataHeaders', name);

      const response = await fetch(`${BASE}/messages/${id}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return null;

      const json = (await response.json()) as {
        id: string;
        snippet?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      };

      return {
        id: json.id,
        from: header(json.payload?.headers, 'From'),
        subject: header(json.payload?.headers, 'Subject') || '(no subject)',
        date: header(json.payload?.headers, 'Date'),
        snippet: (json.snippet ?? '').slice(0, 400),
      } satisfies MailSummary;
    }),
  );

  return messages.filter((m): m is MailSummary => m !== null);
}

/** Save a draft reply. Never sends — sending requires explicit confirmation. */
export async function createDraft(to: string, subject: string, body: string): Promise<string> {
  const token = await accessToken();

  const raw = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join(
    '\r\n',
  );

  const encoded = Buffer.from(raw)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await fetch(`${BASE}/drafts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw: encoded } }),
  });

  if (!response.ok) {
    throw new Error(`Could not create draft: ${(await response.text()).slice(0, 200)}`);
  }

  const json = (await response.json()) as { id: string };
  log.info('Gmail draft created', { id: json.id });
  return json.id;
}

/**
 * The full text of one email.
 *
 * This is what was missing: searchMail only ever returned subject and a
 * snippet, so "andar kya likha hai" was unanswerable — the body was never
 * fetched at all.
 *
 * Gmail nests body parts in a tree and base64url-encodes each one. We
 * walk it preferring text/plain, falling back to text/html with the tags
 * stripped, because newsletters are frequently HTML-only.
 */
export async function readMessage(id: string, maxChars = 3000): Promise<{
  from: string;
  subject: string;
  date: string;
  body: string;
} | null> {
  const token = await accessToken();

  const response = await fetch(`${BASE}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;

  const json = (await response.json()) as {
    payload?: GmailPart & { headers?: Array<{ name: string; value: string }> };
    snippet?: string;
  };

  const headers = json.payload?.headers;
  const plain = collect(json.payload, 'text/plain');
  const html = plain ? '' : collect(json.payload, 'text/html');

  const body = (plain || stripHtml(html) || json.snippet || '').replace(/\n{3,}/g, '\n\n').trim();

  return {
    from: header(headers, 'From'),
    subject: header(headers, 'Subject') || '(no subject)',
    date: header(headers, 'Date'),
    body: body.slice(0, maxChars),
  };
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

/** Depth-first search for the first part of the wanted mime type. */
function collect(part: GmailPart | undefined, want: string): string {
  if (!part) return '';

  if (part.mimeType === want && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }

  for (const child of part.parts ?? []) {
    const found = collect(child, want);
    if (found) return found;
  }
  return '';
}

function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Add and remove labels on a message.
 *
 * Gmail models everything as labels: archiving removes INBOX, marking
 * read removes UNREAD, trashing adds TRASH. One endpoint covers all of
 * it, and every one of these is reversible — nothing here deletes
 * permanently.
 */
export async function modifyLabels(
  id: string,
  add: string[] = [],
  remove: string[] = [],
): Promise<boolean> {
  const token = await accessToken();

  const response = await fetch(`${BASE}/messages/${id}/modify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
  });

  if (!response.ok) {
    log.warn('Gmail label change failed', {
      id,
      detail: (await response.text()).slice(0, 140),
    });
    return false;
  }
  return true;
}

/**
 * Move a message to Trash. Recoverable for 30 days in Gmail; this never
 * deletes permanently, which is not something the assistant should do.
 */
export async function trashMessage(id: string): Promise<boolean> {
  const token = await accessToken();
  const response = await fetch(`${BASE}/messages/${id}/trash`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.ok;
}
