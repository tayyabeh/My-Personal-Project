/**
 * Link summarising. Send a URL, get the gist back.
 *
 * Strips HTML with regex rather than pulling in a parser. That is
 * normally poor practice, but here the output only ever feeds a language
 * model — there is no DOM to get wrong, and it avoids a dependency.
 */
import { llm } from '../llm';
import { log } from '../logger';

/** Finds the first http(s) URL in a message. */
export function findUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0] : null;
}

function extractText(html: string): { title: string; body: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim().slice(0, 200) : '';

  const body = html
    // Drop anything that is not prose before stripping tags.
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title, body };
}

export async function summariseLink(url: string): Promise<string> {
  let html: string;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) return `That link returned an error (HTTP ${response.status}).`;

    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('html') && !type.includes('text')) {
      return `That link is a ${type.split(';')[0] || 'file'}, not a web page, so I can't read it.`;
    }

    html = await response.text();
  } catch (error) {
    log.warn('Link fetch failed', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return "I couldn't open that link — it may be blocking automated readers.";
  }

  const { title, body } = extractText(html);

  if (body.length < 200) {
    return "That page didn't have enough readable text to summarise. It may need JavaScript to load.";
  }

  // Cap the input: keeping context small is what avoids Groq's TPM limit.
  const excerpt = body.slice(0, 6000);

  const summary = await llm().complete(
    [
      {
        role: 'system',
        content:
          'Summarise this web page for someone reading on WhatsApp. Four or five short ' +
          'sentences. Lead with what the page is actually about, then the key points. ' +
          'Summarise only what the text says; never add outside knowledge. No markdown.',
      },
      { role: 'user', content: `${title ? `Title: ${title}\n\n` : ''}${excerpt}` },
    ],
    { temperature: 0.3, maxTokens: 700 },
  );

  return title ? `${title}\n\n${summary}` : summary;
}
