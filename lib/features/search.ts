/**
 * Web search, then answer with sources.
 *
 * DuckDuckGo needs no API key and no account, which is why it is here.
 * The model is only allowed to summarise what the results actually say —
 * it is explicitly told to admit when the results do not answer the
 * question, rather than filling the gap from memory.
 */
import { search as ddg, SafeSearchType } from 'duck-duck-scrape';
import { llm } from '../llm';
import { log } from '../logger';
import { ROMAN_URDU } from '../lang';

export interface SearchAnswer {
  answer: string;
  sources: Array<{ title: string; url: string }>;
}

/** Strip the HTML bold tags DuckDuckGo puts around matched terms. */
function clean(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

interface Hit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * DuckDuckGo, by scraping. Free and keyless, but DDG actively blocks
 * datacenter traffic, so this fails often from a server. Treated as
 * best-effort rather than the main path.
 */
async function tryDuckDuckGo(question: string): Promise<Hit[]> {
  try {
    const results = await ddg(question, { safeSearch: SafeSearchType.MODERATE });
    return (results.results ?? []).slice(0, 5).map((r) => ({
      title: clean(r.title),
      url: r.url,
      snippet: clean(r.description),
    }));
  } catch (error) {
    log.warn('DuckDuckGo unavailable, falling back', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Wikipedia's official API. No key, no scraping, no blocking — it is a
 * documented public endpoint. Excellent for people, places and concepts;
 * useless for today's exchange rate. That trade is why DDG is tried first.
 */
async function tryWikipedia(question: string): Promise<Hit[]> {
  try {
    const searchUrl =
      'https://en.wikipedia.org/w/api.php?' +
      new URLSearchParams({
        action: 'query',
        list: 'search',
        srsearch: question,
        srlimit: '3',
        format: 'json',
        origin: '*',
      });

    const response = await fetch(searchUrl, {
      headers: { 'User-Agent': 'PersonalAIManager/1.0 (personal use)' },
    });
    if (!response.ok) return [];

    const json = (await response.json()) as {
      query?: { search?: Array<{ title: string; snippet: string }> };
    };

    const hits = json.query?.search ?? [];
    if (hits.length === 0) return [];

    // Fetch a proper summary for the best match rather than the search snippet.
    const best = hits[0];
    const summaryResponse = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(best.title)}`,
      { headers: { 'User-Agent': 'PersonalAIManager/1.0 (personal use)' } },
    );

    const results: Hit[] = [];
    if (summaryResponse.ok) {
      const summary = (await summaryResponse.json()) as {
        extract?: string;
        content_urls?: { desktop?: { page?: string } };
      };
      if (summary.extract) {
        results.push({
          title: best.title,
          url:
            summary.content_urls?.desktop?.page ??
            `https://en.wikipedia.org/wiki/${encodeURIComponent(best.title)}`,
          snippet: summary.extract,
        });
      }
    }

    for (const hit of hits.slice(1)) {
      results.push({
        title: hit.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`,
        snippet: clean(hit.snippet),
      });
    }

    return results;
  } catch (error) {
    log.warn('Wikipedia lookup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function searchAndAnswer(question: string): Promise<SearchAnswer> {
  let top = await tryDuckDuckGo(question);
  if (top.length === 0) top = await tryWikipedia(question);

  if (top.length === 0) {
    return {
      answer:
        'Abhi search nahi kar paya. Thori der baad pooch lo.',
      sources: [],
    };
  }

  const context = top
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nSource: ${r.url}`)
    .join('\n\n');

  const answer = await llm().complete(
    [
      {
        role: 'system',
        content:
          'Answer the question using ONLY the search results provided. Three or four ' +
          'sentences maximum — this is read on WhatsApp. Cite which result you used with ' +
          '[1], [2] etc. Agar results se jawab nahi milta to saaf keh do, apni yaadasht se ' +
          'jawab mat do.\n\n' + ROMAN_URDU,
      },
      { role: 'user', content: `Question: ${question}\n\nSearch results:\n\n${context}` },
    ],
    { temperature: 0.3, maxTokens: 600 },
  );

  return {
    answer,
    sources: top.map((r) => ({ title: r.title, url: r.url })),
  };
}

/** The whole thing formatted for a WhatsApp message. */
export async function answerWithSources(question: string): Promise<string> {
  const { answer, sources } = await searchAndAnswer(question);
  if (sources.length === 0) return answer;

  const list = sources
    .slice(0, 3)
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}`)
    .join('\n');

  return `${answer}\n\n${list}`;
}
