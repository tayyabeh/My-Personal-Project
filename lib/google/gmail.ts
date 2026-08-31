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
