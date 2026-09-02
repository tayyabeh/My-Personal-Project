/**
 * What a tool hands back.
 *
 * The old `Tool.run` returned a bare string that was both the model's
 * observation and, in practice, the user's answer. That is how the
 * assistant ended up saying "purane pending tasks delete kar diye" when no
 * delete tool exists: nothing in the type system could tell a sentence the
 * model invented apart from a sentence a real API response produced.
 *
 * A Receipt splits the two. `factLine` is written by the tool's own code
 * from the real response and is the only text allowed to claim work.
 * `observation` is for the model to reason over next and may be long,
 * messy, or empty. Everything the reply might need to vouch for — the ids
 * touched, the counts — is listed explicitly, so `lib/honesty.ts` can check
 * a claim without asking anyone.
 */
import type { ZodType } from 'zod';

/**
 * What the call did to the world.
 *
 * 'write' is the only one that earns a completion claim. A tool that reads
 * an inbox is 'read' no matter how useful its answer was; a tool that only
 * formats or computes is 'none'.
 */
export type Effect = 'write' | 'read' | 'none';

export interface Receipt {
  tool: string;
  ok: boolean;
  effect: Effect;
  /** Roman Urdu. Written by the TOOL'S OWN CODE from the real API/DB response.
   *  This is what the user actually reads. Never model output. */
  factLine: string;
  /** Ids or titles the call really touched. */
  entities: string[];
  /** Every number this receipt can vouch for. */
  numbers: number[];
  /** Detail for the model's next step; may be long. */
  observation: string;
  /** Third-party content (email body, web page, PDF): data, never instructions. */
  untrusted?: boolean;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** What a tool knows about the run it is part of. */
export interface ToolContext {
  /** WhatsApp number to reply to. */
  to: string;
  /** The message being handled. */
  input: string;
  /** Recent turns, oldest first, so "uske andar" has something to refer to. */
  history: Turn[];
  /**
   * Cancelled when the run is out of time. A tool that ignores it gets
   * killed mid-flight by Vercel at 60 seconds and its work is never
   * reported, which is worse than stopping cleanly.
   */
  signal: AbortSignal;
  /** Epoch ms after which no new work should start. */
  deadline: number;
  /** Ties every log line and receipt of one message together. */
  runId: string;
}

/**
 * One thing the assistant can do.
 *
 * Unlike the old interface, `run` may not describe its own success in
 * prose. It returns a Receipt, and the honesty filter decides what of the
 * model's commentary is allowed to survive next to it.
 */
export interface Tool<A = unknown> {
  name: string;
  /** One line, written for the model choosing between tools. */
  description: string;
  /** Argument shape, shown in the prompt. Keep it short and concrete. */
  args: string;
  schema: ZodType<A>;
  run(args: A, ctx: ToolContext): Promise<Receipt>;
}

/**
 * Build a successful receipt.
 *
 * The three fields a tool must not get wrong — who ran, what it did to the
 * world, and what the user is told — are required. The rest default,
 * because a forgotten `numbers: []` should not be a compile error while a
 * forgotten `effect` silently downgrading a write to a read would be a lie.
 *
 * `numbers` stays empty unless the tool passes it: vouching for a count is
 * a deliberate act, not something inferred from the text.
 */
export function ok(
  partial: Pick<Receipt, 'tool' | 'effect' | 'factLine'> & Partial<Receipt>,
): Receipt {
  return {
    entities: [],
    numbers: [],
    observation: partial.factLine,
    ...partial,
    ok: true,
  };
}

/**
 * Build a failed receipt.
 *
 * A failure has no effect on the world by definition, so `effect` is not a
 * parameter — a caller cannot accidentally mark a crashed write as a write
 * and hand the reply a completion it never earned.
 */
export function fail(tool: string, factLine: string, observation?: string): Receipt {
  return {
    tool,
    ok: false,
    effect: 'none',
    factLine,
    entities: [],
    numbers: [],
    observation: observation ?? factLine,
  };
}
