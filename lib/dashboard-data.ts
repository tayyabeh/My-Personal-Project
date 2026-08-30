/**
 * Everything the dashboard renders, read in one place.
 *
 * Kept server-side: the service_role key never reaches the browser.
 */
import { db } from './supabase';
import { todayLocal } from './context';

export interface DashboardData {
  todaysTasks: Array<{ id: string; title: string; status: string; priority: string }>;
  avoided: Array<{ id: string; title: string; rollover_count: number }>;
  daily: Array<{ log_date: string; completion_rate: number; tasks_completed: number; tasks_planned: number }>;
  streak: number;
  messages: Array<{ id: string; direction: string; content: string | null; was_voice: boolean; created_at: string }>;
  learnings: Array<{ id: string; content: string; topics: string[]; created_at: string }>;
  podcasts: Array<{ id: string; topic: string; audio_url: string | null; created_at: string }>;
  reminders: Array<{ id: string; text: string; trigger_at: string; sent: boolean }>;
  googleConnected: boolean;
}

/**
 * Consecutive days, counting back from the most recent logged day, where
 * at least one task was completed. A gap ends the streak.
 */
function computeStreak(
  logs: Array<{ log_date: string; tasks_completed: number }>,
): number {
  if (logs.length === 0) return 0;

  const sorted = [...logs].sort((a, b) => (a.log_date < b.log_date ? 1 : -1));
  let streak = 0;
  let expected = sorted[0].log_date;

  for (const log of sorted) {
    if (log.log_date !== expected) break;
    if (log.tasks_completed <= 0) break;
    streak++;
    const previous = new Date(`${expected}T00:00:00Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    expected = previous.toISOString().slice(0, 10);
  }

  return streak;
}

export async function loadDashboard(): Promise<DashboardData> {
  const client = db();
  const today = todayLocal();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [tasksRes, avoidedRes, dailyRes, messagesRes, learningsRes, podcastsRes, remindersRes, settingsRes] =
    await Promise.all([
      client.from('tasks').select('id, title, status, priority').eq('due_date', today).order('created_at'),
      client
        .from('tasks')
        .select('id, title, rollover_count')
        .eq('status', 'pending')
        .gt('rollover_count', 0)
        .order('rollover_count', { ascending: false })
        .limit(10),
      client
        .from('daily_logs')
        .select('log_date, completion_rate, tasks_completed, tasks_planned')
        .gte('log_date', thirtyDaysAgo)
        .order('log_date'),
      client
        .from('messages')
        .select('id, direction, content, was_voice, created_at')
        .order('created_at', { ascending: false })
        .limit(200),
      client.from('learnings').select('id, content, topics, created_at').order('created_at', { ascending: false }).limit(50),
      client.from('podcasts').select('id, topic, audio_url, created_at').order('created_at', { ascending: false }).limit(20),
      client.from('reminders').select('id, text, trigger_at, sent').eq('sent', false).order('trigger_at').limit(10),
      client.from('settings').select('google_refresh_token').eq('id', 1).maybeSingle(),
    ]);

  const daily = (dailyRes.data ?? []) as DashboardData['daily'];

  return {
    todaysTasks: (tasksRes.data ?? []) as DashboardData['todaysTasks'],
    avoided: (avoidedRes.data ?? []) as DashboardData['avoided'],
    daily,
    streak: computeStreak(daily),
    messages: (messagesRes.data ?? []) as DashboardData['messages'],
    learnings: (learningsRes.data ?? []) as DashboardData['learnings'],
    podcasts: (podcastsRes.data ?? []) as DashboardData['podcasts'],
    reminders: (remindersRes.data ?? []) as DashboardData['reminders'],
    googleConnected: Boolean(settingsRes.data?.google_refresh_token),
  };
}
