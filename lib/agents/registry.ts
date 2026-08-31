/**
 * Every agent the orchestrator can route to.
 *
 * Adding one is two steps and nothing else:
 *   1. Write lib/agents/<name>-agent.ts exporting an Agent.
 *   2. Add it to AGENTS below.
 *
 * The orchestrator builds its routing prompt from these descriptions, so
 * a new agent becomes reachable the moment it is listed — there is no
 * intent enum to extend and no switch statement to edit. That was the
 * whole point of the rewrite.
 */
import type { Agent } from './types';
import { emailAgent } from './email-agent';
import { tasksAgent } from './tasks-agent';
import { calendarAgent } from './calendar-agent';
import { researchAgent } from './research-agent';
import { coachAgent } from './coach-agent';
import { moneyAgent } from './money-agent';
import { settingsAgent } from './settings-agent';

export const AGENTS: Agent[] = [
  emailAgent,
  tasksAgent,
  calendarAgent,
  researchAgent,
  coachAgent,
  moneyAgent,
  settingsAgent,
];

export function findAgent(name: string): Agent | undefined {
  return AGENTS.find((a) => a.name === name);
}
