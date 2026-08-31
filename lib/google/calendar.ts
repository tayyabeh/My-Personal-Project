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

/**
 * An all-day event, used for tasks.
 *
 * Tasks have a due date but no time, so a timed event would be a lie —
 * it would sit at an arbitrary hour and clutter the day view. All-day
 * events stack neatly at the top of the date instead.
 *
 * Google's all-day `end.date` is EXCLUSIVE, so a single-day event ends on
 * the following date. Passing the same date twice creates a zero-length
 * event that does not render.
 */
export async function createAllDayEvent(title: string, date: string): Promise<string | null> {
  const token = await accessToken();

  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const endDate = next.toISOString().slice(0, 10);

  const response = await fetch(`${BASE}/calendars/primary/events`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: title,
      start: { date },
      end: { date: endDate },
      transparency: 'transparent', // a task should not mark you busy
    }),
  });

  if (!response.ok) return null;
  const json = (await response.json()) as { id: string };
  return json.id;
}

/** Remove an event, used when a task is deleted. Never throws. */
export async function deleteEvent(eventId: string): Promise<void> {
  try {
    const token = await accessToken();
    await fetch(`${BASE}/calendars/primary/events/${eventId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // A stale calendar entry is not worth failing a delete over.
  }
}
