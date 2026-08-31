/**
 * Drive search and summarising, for WhatsApp.
 */
import { z } from 'zod';
import { completeJson } from '../llm/json';
import { llm } from '../llm';
import { readFile, searchFiles } from '../google/drive';
import { ROMAN_URDU } from '../lang';

const TermsSchema = z.object({ terms: z.string().min(1).max(80) });

/** Pull the actual search words out of a sentence. */
async function searchTerms(request: string): Promise<string> {
  const result = await completeJson(
    TermsSchema,
    [
      {
        role: 'system',
        content:
          'Extract the words to search a file store for. Reply ONLY with JSON: {"terms":"..."}\n' +
          'Keep only the distinctive words — drop "find", "my", "file", "document", "in drive".',
      },
      { role: 'user', content: 'find my file about the client proposal' },
      { role: 'assistant', content: JSON.stringify({ terms: 'client proposal' }) },
      { role: 'user', content: 'summarise the budget spreadsheet in my drive' },
      { role: 'assistant', content: JSON.stringify({ terms: 'budget' }) },
      { role: 'user', content: request },
    ],
    { temperature: 0, maxTokens: 200 },
  );

  return result.ok ? result.data.terms : request;
}

export async function searchDrive(request: string): Promise<string> {
  const terms = await searchTerms(request);
  const files = await searchFiles(terms, 8);

  if (files.length === 0) return `Drive mein "${terms}" se kuch nahi mila.`;

  // One file: summarise it. Several: list them, because guessing which one
  // they meant and summarising the wrong document wastes their time.
  if (files.length === 1) {
    const file = files[0];
    const content = await readFile(file);

    if (!content) {
      return `"${file.name}" mila, lekin ye readable text file nahi hai.\n${file.webViewLink ?? ''}`;
    }

    const summary = await llm().complete(
      [
        {
          role: 'system',
          content:
            'Summarise this document for someone reading on WhatsApp. Four or five short ' +
            'sentences. Sirf wahi jo document mein hai. No markdown.\n\n' + ROMAN_URDU,
        },
        { role: 'user', content: content },
      ],
      { temperature: 0.3, maxTokens: 700 },
    );

    return `${file.name}\n\n${summary}\n\n${file.webViewLink ?? ''}`.trim();
  }

  const list = files
    .slice(0, 6)
    .map((f, i) => `${i + 1}. ${f.name}`)
    .join('\n');

  return `${files.length} files mili "${terms}" ke liye:\n${list}\n\nKisi ek ka naam lo, summary bana dunga.`;
}
