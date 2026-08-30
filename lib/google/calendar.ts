/**
 * Google Calendar, over the REST API.
 *
 * All times go to Google as ISO strings with an explicit timeZone, so
 * there is never any ambiguity about what 3pm means.
 */
import { accessToken } from './oauth';
import { TIMEZONE } from '../env';

const BASE = 'https://www.googleapis.com/calendar/v3';

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  htmlLink?: string;
}

/** Create an event on the primary calendar. Returns its Google event id. */
export async function createEvent(
  title: string,
  startsAt: Date,
  durationMinutes = 30,
): Promise<CalendarEvent> {
  const token = await accessToken();
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);

  const response = await fetch(`${BASE}/calendars/primary/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: title,
      start: { dateTime: startsAt.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: endsAt.toISOString(), timeZone: TIMEZONE },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
    }),
  });

  if (!response.ok) {
    throw new Error(`Calendar event creation failed: ${await response.text()}`);
  }

  const json = (await response.json()) as {
    id: string;
    summary: string;
    start: { dateTime: string };
    htmlLink: string;
  };

  return {
    id: json.id,
    summary: json.summary,
    start: json.start.dateTime,
    htmlLink: json.htmlLink,
  };
}

/** Events starting between now and `hours` from now. */
export async function upcomingEvents(hours = 24): Promise<CalendarEvent[]> {
  const token = await accessToken();
  const now = new Date();
  const until = new Date(now.getTime() + hours * 60 * 60 * 1000);

  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: until.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '20',
  });

  const response = await fetch(`${BASE}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Could not list calendar events: ${await response.text()}`);
  }

  const json = (await response.json()) as {
    items?: Array<{
      id: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      htmlLink?: string;
    }>;
  };

  return (json.items ?? [])
    .filter((item) => item.start?.dateTime)
    .map((item) => ({
      id: item.id,
      summary: item.summary ?? '(untitled)',
      start: item.start!.dateTime!,
      htmlLink: item.htmlLink,
    }));
}
