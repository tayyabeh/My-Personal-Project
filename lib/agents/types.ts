/**
 * The agent framework.
 *
 * Why this replaces the old flat classifier: that design picked one label
 * and ran one function, which meant it could not remember the previous
 * turn, could not chain steps ("find the email, then open it, then
 * summarise it"), and — worst — could reply with a promise it had no way
 * to keep. It told Tayyab "teeno tasks add kar raha hoon" and did nothing.
 *
 * Here an agent runs a loop: think, call a tool, look at the result, go
 * again. Its final reply is written only after the tools have actually
 * run, so it can only claim what really happened.
 */
import type { ZodType } from 'zod';

/** What an agent knows about the conversation it is in. */
export interface AgentContext {
  /** WhatsApp number to reply to. */
  to: string;
  /** Recent turns, oldest first, so "uske andar" has something to refer to. */
  history: Turn[];
  /** The message being handled. */
  input: string;
  /**
   * Send an interim message. Used when a step will take a while, so the
   * user is not left staring at silence.
   */
  say(text: string): Promise<void>;
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * One thing an agent can do.
 *
 * `run` returns an observation string — what the agent "sees" after the
 * action. It should describe the outcome factually, including failure,
 * because that text is what the model reasons over next.
 */
export interface Tool<Args = unknown> {
  name: string;
  /** One line, written for the model choosing between tools. */
  description: string;
  /** Argument shape, shown in the prompt. Keep it short and concrete. */
  args: string;
  schema: ZodType<Args>;
  run(args: Args, ctx: AgentContext): Promise<string>;
}

export interface Agent {
  name: string;
  /** Used by the orchestrator to route. Write it as "handles X, Y, Z". */
  description: string;
  /** Extra instructions for this agent's own reasoning. */
  instructions: string;
  tools: Tool<never>[];
  /** Steps before the loop gives up. Most agents need 2-4. */
  maxSteps?: number;
}

export interface AgentResult {
  /** What to send the user. */
  reply: string;
  /** Tool names actually executed, in order. For logging and honesty. */
  steps: string[];
}
