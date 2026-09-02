/**
 * Google Drive, read-only.
 *
 * Google Docs, Sheets and Slides are not stored as files you can simply
 * download — they have to be exported to a readable format first, via a
 * different endpoint. Ordinary uploads (PDFs, text) download directly.
 * That split is the only real complexity here.
 */
import { accessToken } from './oauth';

const BASE = 'https://www.googleapis.com/drive/v3';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
}

/** Which Google-native types we can export, and to what. */
const EXPORTABLE: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

export async function searchFiles(
  query: string,
  max = 10,
  signal?: AbortSignal,
): Promise<DriveFile[]> {
  const token = await accessToken(signal);

  // Escape single quotes, which would otherwise break Drive's query syntax.
  const safe = query.replace(/'/g, "\\'");

  const params = new URLSearchParams({
    q: `name contains '${safe}' or fullText contains '${safe}'`,
    pageSize: String(max),
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
  });

  const response = await fetch(`${BASE}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Drive search failed: ${(await response.text()).slice(0, 200)}`);
  }

  const json = (await response.json()) as { files?: DriveFile[] };
  return json.files ?? [];
}

/** One file's metadata by id, so a tool can re-open a specific search result. */
export async function getFileMetadata(id: string, signal?: AbortSignal): Promise<DriveFile | null> {
  const token = await accessToken(signal);

  const response = await fetch(
    `${BASE}/files/${id}?fields=${encodeURIComponent('id,name,mimeType,modifiedTime,webViewLink')}`,
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );
  if (!response.ok) return null;
  return (await response.json()) as DriveFile;
}

/** Files directly inside one folder. */
export async function listFolder(
  folderId: string,
  max = 20,
  signal?: AbortSignal,
): Promise<DriveFile[]> {
  const token = await accessToken(signal);

  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed = false`,
    pageSize: String(max),
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
  });

  const response = await fetch(`${BASE}/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Could not list folder: ${(await response.text()).slice(0, 200)}`);
  }

  const json = (await response.json()) as { files?: DriveFile[] };
  return json.files ?? [];
}

/** Readable text from a file, capped so it cannot blow the token budget. */
export async function readFile(
  file: DriveFile,
  maxChars = 6000,
  signal?: AbortSignal,
): Promise<string | null> {
  const token = await accessToken(signal);
  const exportAs = EXPORTABLE[file.mimeType];

  const url = exportAs
    ? `${BASE}/files/${file.id}/export?mimeType=${encodeURIComponent(exportAs)}`
    : `${BASE}/files/${file.id}?alt=media`;

  // Anything else (images, video, archives) has no text to read.
  if (!exportAs && !/^(text\/|application\/(pdf|json|xml))/.test(file.mimeType)) {
    return null;
  }

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!response.ok) return null;

  const text = await response.text();
  return text.slice(0, maxChars);
}
