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
import { optional } from '../env';

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


/**
 * Google Programmable Search, the JSON API.
 *
 * This is the only one of the three that reliably answers "what happened
 * today" — Wikipedia cannot, and DuckDuckGo blocks servers. It is free
 * for 100 queries a day with no card, but it does need two values set up
 * once: an API key and a search-engine id.
 *
 * Silently skipped when those are absent, so the feature degrades to the
 * other sources rather than erroring.
 */
async function tryGoogle(question: string): Promise<Hit[]> {
  const key = optional('GOOGLE_SEARCH_API_KEY');
  const cx = optional('GOOGLE_SEARCH_CX');
  if (!key || !cx) return [];

  try {
    const params = new URLSearchParams({ key, cx, q: question, num: '5' });
    const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);

    if (!response.ok) {
      // 429 here means the 100/day free quota is spent.
      log.warn('Google search unavailable', {
        status: response.status,
        detail: (await response.text()).slice(0, 160),
      });
      return [];
    }

    const json = (await response.json()) as {
      items?: Array<{ title?: string; link?: string; snippet?: string }>;
    };

    return (json.items ?? [])
      .filter((item) => item.link)
      .map((item) => ({
        title: clean(item.title ?? ''),
        url: item.link!,
        snippet: clean(item.snippet ?? ''),
      }));
  } catch (error) {
    log.warn('Google search failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function searchAndAnswer(question: string): Promise<SearchAnswer> {
  // Google first: it is the only source that knows about today.
  let top = await tryGoogle(question);
  if (top.length === 0) top = await tryDuckDuckGo(question);
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
