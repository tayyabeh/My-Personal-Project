/**
 * The three templates registered in Meta Business Manager.
 *
 * These are used automatically whenever the 24-hour freeform window has
 * closed. The static text here must match what Meta approved.
 *
 * Meta rejects a template body that ENDS with a variable, which is why
 * reminder_alert and night_summary have trailing words after their last
 * placeholder.
 */
import type { TemplateSpec } from './types';

/** Change to 'en_US' if that is the language you picked in Meta. */
const LANG = 'en';

/** "Good morning! {{1}} What are your tasks for today?" */
export const morningGreeting = (motivationalLine: string): TemplateSpec => ({
  name: 'morning_greeting',
  language: LANG,
  params: [motivationalLine],
});

/** "Reminder: {{1}} starts in 5 minutes." */
export const reminderAlert = (what: string): TemplateSpec => ({
  name: 'reminder_alert',
  language: LANG,
  params: [what],
});

/** "Today you completed {{1}} of {{2}} tasks. {{3}} Open your dashboard for the full picture." */
export const nightSummary = (
  completed: number,
  planned: number,
  closingLine: string,
): TemplateSpec => ({
  name: 'night_summary',
  language: LANG,
  params: [String(completed), String(planned), closingLine],
});
