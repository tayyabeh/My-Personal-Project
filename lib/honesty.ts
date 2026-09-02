/**
 * The claim filter.
 *
 * Zero LLM tokens, on purpose — this is the last line of defence between
 * what the model wrote and what Tayyab reads, so it cannot itself depend
 * on the model being trustworthy. Every line of a reply is checked
 * against the turn's Receipts:
 *
 *   - A promise ("abhi kar deta hoon") is stripped unconditionally. The
 *     model has already finished acting for this turn; anything phrased
 *     as future work is a promise it cannot keep.
 *   - A completed-action claim ("tasks add kar diye") survives only if at
 *     least one Receipt this turn is a successful write. Otherwise it is
 *     invented.
 *   - A number survives only if some Receipt vouches for it. An
 *     un-vouched count is exactly how "purane pending tasks delete kar
 *     diye" happened with nothing behind it.
 *
 * The unit of analysis is one newline-delimited line, not a `.!?`-split
 * sentence — every tool observation in this codebase is already
 * newline-joined, and splitting on punctuation risks mangling Roman Urdu.
 */
import type { Receipt } from './tools/types';

export interface ClaimCheck {
  line: string;
  verdict: 'kept' | 'stripped';
  reason?: string;
}

const PROMISE_PATTERNS: RegExp[] = [
  /\bkar\s+d[uo]ng[ai]\b/i,
  /\bkar\s+doon?g[ai]\b/i,
  /\bkarwa\s+doon?g[ai]\b/i,
  /\bho\s+jaye[gy]i?\b/i,
  /\bkar\s+deta\s+hoon\b/i,
  /\bkar\s+deti\s+hoon\b/i,
  /\bkarke\s+batata\s+hoon\b/i,
  /\bkar\s+ke\s+batata\s+hoon\b/i,
  /\bdekh\s+kar\s+batata\s+hoon\b/i,
  /\bcheck\s+kar\s+ke\s+batata\s+hoon\b/i,
  /\bkar\s+raha\s+hoon\b/i,
  /\bkar\s+rahi\s+hoon\b/i,
  /\bkarne\s+wala\s+hoon\b/i,
  /\bwill\s+do\b/i,
  /\bi'?ll\b/i,
  /\bi\s+will\b/i,
  /\bworking\s+on\s+it\b/i,
  /\bgive\s+me\s+a\s+(moment|sec|second|minute)\b/i,
  /\blet\s+me\b/i,
  /\bon\s+it\b/i,
];

// "di\w*" covers kar di / diya / diye / diyi in one shape; the earlier
// [yae] form could not match the y-then-e of "diye" without the word
// boundary falling mid-word.
const COMPLETION_PATTERNS: RegExp[] = [
  /\bkar\s+di\w*/i, // kar diya / kar di / kar diye / add-delete-etc kar diya
  /\bho\s+ga\w*/i, // ho gaya / gayi / gaye
  /\bkar\s+li\w*/i, // save/note kar li / kar liya
  /\brakh\s+li\w*/i, // yaad rakh li / liya
  /\bbhej\s+di\w*/i, // bhej diya / diye
  /\bdone\b/i,
  /\bsent\b/i,
  /\bdeleted\b/i,
  /\badded\b/i,
  /\bsaved\b/i,
  /\bupdated\b/i,
  /\bcreated\b/i,
  /\bcancelled\b/i,
  /\bcompleted\b/i,
];

export function checkSentence(line: string, receipts: Receipt[]): ClaimCheck {
  const trimmed = line.trim();
  if (!trimmed) return { line, verdict: 'kept' };

  if (PROMISE_PATTERNS.some((re) => re.test(trimmed))) {
    return { line, verdict: 'stripped', reason: 'promise-phrasing' };
  }

  const hasBackingWrite = receipts.some((r) => r.effect === 'write' && r.ok);
  if (!hasBackingWrite && COMPLETION_PATTERNS.some((re) => re.test(trimmed))) {
    return { line, verdict: 'stripped', reason: 'no backing write receipt' };
  }

  const vouched = new Set(receipts.flatMap((r) => r.numbers));
  const numbers = trimmed.match(/\d+(\.\d+)?/g) ?? [];
  for (const raw of numbers) {
    if (!vouched.has(Number(raw))) {
      return { line, verdict: 'stripped', reason: `unbacked number: ${raw}` };
    }
  }

  return { line, verdict: 'kept' };
}

/** Runs every line of `reply` through checkSentence and rejoins survivors. */
export function filterReply(reply: string, receipts: Receipt[]): string {
  return reply
    .split('\n')
    .filter((line) => checkSentence(line, receipts).verdict === 'kept')
    .join('\n')
    .trim();
}

/** A cheap, punctuation-insensitive containment check. */
function keyToken(factLine: string): string {
  return factLine
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim()
    .slice(0, 24);
}

/**
 * The reply the user actually receives.
 *
 * Built from Receipts, not handed over from the model as-is: any
 * successful write's factLine that the model's own prose never mentioned
 * is prepended, so a tool that ran is never silently missing from the
 * answer. What's left of the model's prose after filterReply supplements
 * that — it never replaces it.
 */
export function buildReply(modelReply: string, receipts: Receipt[]): string {
  const factLines = receipts.filter((r) => r.effect === 'write' && r.ok).map((r) => r.factLine);
  const stripped = filterReply(modelReply, receipts);
  const strippedLower = stripped.toLowerCase();

  const missing = factLines.filter((f) => {
    const token = keyToken(f);
    return token.length > 0 && !strippedLower.includes(token);
  });

  const final = [...missing, stripped].filter(Boolean).join('\n').trim();
  if (final) return final;

  // Nothing survived. A failed write must still be reported, never
  // silently dropped into an empty reply.
  const failures = receipts.filter((r) => !r.ok).map((r) => r.factLine);
  if (failures.length) return failures.join('\n');

  return stripped;
}
