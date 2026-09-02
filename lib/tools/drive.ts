/**
 * Google Drive: search, read, list a folder.
 *
 * Read-only for now. Uploading needs the `drive.file` scope, which is a
 * Phase 4 re-consent — until then `upload_to_drive` honestly refuses via
 * cannot_do rather than pretending.
 */
import { z } from 'zod';
import { searchDrive } from '../features/drive';
import { getFileMetadata, listFolder, readFile } from '../google/drive';
import { llm } from '../llm';
import { ROMAN_URDU } from '../lang';
import { recordRefusal } from './meta';
import { ok, fail, type Tool } from './types';

const searchDriveTool: Tool<{ request: string }> = {
  name: 'search_drive',
  description: 'Drive mein file dhoondo (jumla do).',
  args: 'request: string',
  schema: z.object({ request: z.string().min(2).max(300) }),
  async run({ request }) {
    const result = await searchDrive(request);
    return ok({ tool: 'search_drive', effect: 'read', factLine: result, untrusted: true });
  },
};

const readDriveFile: Tool<{ id: string }> = {
  name: 'read_drive_file',
  description: 'Drive file khol kar khulasa (id search_drive se).',
  args: 'id: string',
  schema: z.object({ id: z.string().min(5).max(120) }),
  async run({ id }, ctx) {
    const file = await getFileMetadata(id, ctx.signal);
    if (!file) return fail('read_drive_file', `Is id se koi file nahi mili: ${id}`);

    const content = await readFile(file, 6000, ctx.signal);
    if (!content) {
      return ok({
        tool: 'read_drive_file',
        effect: 'read',
        factLine: `"${file.name}" mili, lekin readable text file nahi hai.`,
        observation: file.webViewLink ?? '',
      });
    }

    const summary = await llm().complete(
      [
        {
          role: 'system',
          content:
            'Summarise this document for someone reading on WhatsApp. Four or five short ' +
            'sentences. Sirf wahi jo document mein hai. No markdown.\n\n' + ROMAN_URDU,
        },
        { role: 'user', content },
      ],
      { temperature: 0.3, maxTokens: 700, signal: ctx.signal },
    );

    return ok({
      tool: 'read_drive_file',
      effect: 'read',
      factLine: `${file.name}\n\n${summary}${file.webViewLink ? `\n\n${file.webViewLink}` : ''}`.trim(),
      untrusted: true,
      entities: [file.name],
    });
  },
};

const listDriveFolder: Tool<{ folderId: string }> = {
  name: 'list_drive_folder',
  description: 'Folder ke andar ki files (folderId).',
  args: 'folderId: string',
  schema: z.object({ folderId: z.string().min(5).max(120) }),
  async run({ folderId }, ctx) {
    const files = await listFolder(folderId, 20, ctx.signal);
    if (files.length === 0) return ok({ tool: 'list_drive_folder', effect: 'read', factLine: 'Is folder mein koi file nahi.', numbers: [0] });
    return ok({
      tool: 'list_drive_folder',
      effect: 'read',
      factLine: `${files.length} files is folder mein.`,
      numbers: [files.length],
      entities: files.map((f) => f.name),
      observation: files.map((f, i) => `${i + 1}. ${f.name}`).join('\n'),
    });
  },
};

const uploadToDrive: Tool<{ note: string }> = {
  name: 'upload_to_drive',
  description: 'Drive pe upload — abhi band (Phase 4).',
  args: 'note: string (kya upload karna tha)',
  schema: z.object({ note: z.string().max(500).default('') }),
  async run({ note }, ctx) {
    return recordRefusal(
      'upload_to_drive',
      `Drive pe upload abhi possible nahi — drive.file scope chahiye (Phase 4). ${note}`.trim(),
      ctx,
    );
  },
};

export const driveTools: Tool<any>[] = [searchDriveTool, readDriveFile, listDriveFolder, uploadToDrive];
