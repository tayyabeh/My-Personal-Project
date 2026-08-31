/**
 * Web search, then answer with sources.
 *
 * Providers are tried in order and the first one that returns anything
 * wins. Every one of them is free and none needs a credit card, but they
 * differ in what they can actually reach:
 *
 *   SerpAPI    - real Google results. Free plan is 100 searches a month.
 *   Tavily     - built for agents. Free plan is 1,000 a month.
 *   Google CSE - kept only in case access ever opens; see below.
 *   Wikipedia  - no key at all, but encyclopedic only. Cannot answer
 *                "what happened today", so it is the last resort.
 *
 * What was removed and why:
 *   duck-duck-scrape - DuckDuckGo now answers server requests with a
 *     CAPTCHA ("select all squares containing a duck"). It failed on every
 *     single call, so it was costing a round trip and log noise for
 *     nothing. Solving that challenge is not something this should do.
 *   Google Custom Search JSON API - returns 403 "this project does not
 *     have the access" no matter how it is configured, because Google has
 *     closed it to new customers. The code stays because it costs nothing
 *     and would start working if that ever changes.
 *
 * The model is only ever allowed to summarise what the results say, and
 * is told to admit when they do not answer the question rather than
 * filling the gap from memory.
 */
import { llm } from '../llm';
import { log } from '../logger';
import { ROMAN_URDU } from '../lang';
import { optional } from '../env';

export interface SearchAnswer {
  answer: string;
  sources: Array<{ title: string; url: string }>;
}

interface Hit {
  title: string;
  url: string;
  snippet: string;
}

/** Strip any HTML a provider leaves in titles or snippets. */
function clean(text: string): string {
  return (text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Never let a slow provider eat the function's 60-second budget. */
const TIMEOUT_MS = 12_000;

async function getJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) {
      log.warn('Search provider rejected the request', {
        url: url.split('?')[0],
        status: response.status,
        detail: (await response.text()).slice(0, 140),
      });
      return null;
    }
    return await response.json();
  } catch (error) {
    log.warn('Search provider unreachable', {
      url: url.split('?')[0],
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** SerpAPI — real Google results. */
async function trySerpApi(question: string): Promise<Hit[]> {
  const key = optional('SERPAPI_API_KEY');
  if (!key) return [];

  const params = new URLSearchParams({ q: question, api_key: key, engine: 'google', num: '5' });
  const json = (await getJson(`https://serpapi.com/search.json?${params}`)) as {
    organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
    answer_box?: { answer?: string; snippet?: string; title?: string; link?: string };
  } | null;

  if (!json) return [];

  const hits: Hit[] = [];

  // The answer box is often the whole answer for things like exchange rates.
  const box = json.answer_box;
  if (box && (box.answer || box.snippet)) {
    hits.push({
      title: clean(box.title ?? 'Google answer'),
      url: box.link ?? 'https://google.com',
      snippet: clean(box.answer ?? box.snippet ?? ''),
    });
  }

  for (const item of json.organic_results ?? []) {
    if (!item.link) continue;
    hits.push({ title: clean(item.title ?? ''), url: item.link, snippet: clean(item.snippet ?? '') });
  }

  return hits.slice(0, 5);
}

/** Tavily — search built for agents, and it summarises as it goes. */
async function tryTavily(question: string): Promise<Hit[]> {
  const key = optional('TAVILY_API_KEY');
  if (!key) return [];

  const json = (await getJson('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      query: question,
      max_results: 5,
      search_depth: 'basic',
      include_answer: true,
    }),
  })) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string }>;
  } | null;

  if (!json) return [];

  const hits: Hit[] = [];
  if (json.answer) {
    hits.push({ title: 'Summary', url: 'https://tavily.com', snippet: clean(json.answer) });
  }
  for (const item of json.results ?? []) {
    if (!item.url) continue;
    hits.push({ title: clean(item.title ?? ''), url: item.url, snippet: clean(item.content ?? '') });
  }

  return hits.slice(0, 5);
}

/**
 * Google Programmable Search. Currently returns 403 for new projects
 * because the JSON API is closed to new customers; harmless to keep.
 */
async function tryGoogle(question: string): Promise<Hit[]> {
  const key = optional('GOOGLE_SEARCH_API_KEY');
  const cx = optional('GOOGLE_SEARCH_CX');
  if (!key || !cx) return [];

  const params = new URLSearchParams({ key, cx, q: question, num: '5' });
  const json = (await getJson(`https://www.googleapis.com/customsearch/v1?${params}`)) as {
    items?: Array<{ title?: string; link?: string; snippet?: string }>;
  } | null;

  if (!json) return [];

  return (json.items ?? [])
    .filter((item) => item.link)
    .map((item) => ({
      title: clean(item.title ?? ''),
      url: item.link!,
      snippet: clean(item.snippet ?? ''),
    }));
}

/** Wikipedia's official API. No key, never blocks, but encyclopedic only. */
async function tryWikipedia(question: string): Promise<Hit[]> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: question,
    srlimit: '3',
    format: 'json',
    origin: '*',
  });

  const json = (await getJson(`https://en.wikipedia.org/w/api.php?${params}`, {
    headers: { 'User-Agent': 'PersonalAIManager/1.0 (personal use)' },
  })) as { query?: { search?: Array<{ title: string; snippet: string }> } } | null;

  const found = json?.query?.search ?? [];
  if (found.length === 0) return [];

  const hits: Hit[] = [];

  // A proper summary for the best match beats the search snippet.
  const best = found[0];
  const summary = (await getJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(best.title)}`,
    { headers: { 'User-Agent': 'PersonalAIManager/1.0 (personal use)' } },
  )) as { extract?: string; content_urls?: { desktop?: { page?: string } } } | null;

  if (summary?.extract) {
    hits.push({
      title: best.title,
      url:
        summary.content_urls?.desktop?.page ??
        `https://en.wikipedia.org/wiki/${encodeURIComponent(best.title)}`,
      snippet: summary.extract,
    });
  }

  for (const hit of found.slice(1)) {
    hits.push({
      title: hit.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`,
      snippet: clean(hit.snippet),
    });
  }

  return hits;
}

/** In order of how much they can actually reach. */
const PROVIDERS: Array<[string, (q: string) => Promise<Hit[]>]> = [
  ['serpapi', trySerpApi],
  ['tavily', tryTavily],
  ['google', tryGoogle],
  ['wikipedia', tryWikipedia],
];

export async function searchAndAnswer(question: string): Promise<SearchAnswer> {
  let hits: Hit[] = [];
  let used = 'none';

  for (const [name, provider] of PROVIDERS) {
    hits = await provider(question);
    if (hits.length > 0) {
      used = name;
      break;
    }
  }

  log.info('Search finished', { provider: used, hits: hits.length });

  if (hits.length === 0) {
    return {
      answer:
        'Search nahi kar paya — abhi koi search provider set nahi hai jo chal raha ho. ' +
        'Wikipedia se bhi kuch nahi mila.',
      sources: [],
    };
  }

  const context = hits
    .map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}\nSource: ${h.url}`)
    .join('\n\n');

  const answer = await llm().complete(
    [
      {
        role: 'system',
        content:
          'Sawal ka jawab SIRF diye gaye search results se do. Zyada se zyada 4 jumle — ' +
          'WhatsApp pe parha jayega. Jo result istemal kiya uska number likho: [1], [2]. ' +
          'Agar results se jawab nahi milta to saaf keh do, apni yaadasht se jawab mat do.\n\n' +
          ROMAN_URDU,
      },
      { role: 'user', content: `Sawal: ${question}\n\nSearch results:\n\n${context}` },
    ],
    { temperature: 0.3, maxTokens: 600 },
  );

  return { answer, sources: hits.map((h) => ({ title: h.title, url: h.url })) };
}

/** The whole thing formatted for a WhatsApp message. */
export async function answerWithSources(question: string): Promise<string> {
  const { answer, sources } = await searchAndAnswer(question);
  if (sources.length === 0) return answer;

  const list = sources
    .filter((s) => !s.url.startsWith('https://tavily.com'))
    .slice(0, 3)
    .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}`)
    .join('\n');

  return list ? `${answer}\n\n${list}` : answer;
}
