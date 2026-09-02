/**
 * The entire routing mechanism.
 *
 * There is no planner picking an agent by description anymore — every
 * tool the assistant can call lives in this one flat array, one file per
 * domain. Adding a capability is: write a file, import its export, spread
 * it here.
 */
import type { Tool } from './types';
import { routineTools } from './routine';
import { calendarTools } from './calendar';
import { gmailTools } from './gmail';
import { searchTools } from './search';
import { driveTools } from './drive';
import { knowledgeTools } from './knowledge';
import { voiceTools } from './voice';
import { settingsTools } from './settings';
import { recordsTools } from './records';
import { metaTools } from './meta';

export const TOOLS: Tool<any>[] = [
  ...routineTools,
  ...calendarTools,
  ...gmailTools,
  ...searchTools,
  ...driveTools,
  ...knowledgeTools,
  ...voiceTools,
  ...settingsTools,
  ...recordsTools,
  ...metaTools,
];
