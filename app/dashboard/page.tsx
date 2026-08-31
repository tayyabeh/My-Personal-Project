import { loadDashboard } from '@/lib/dashboard-data';
import TaskList from './TaskList';
import MessageLog from './MessageLog';
import { CompletionChart, ProgressRing } from './Charts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Dashboard' };

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <h2 className="text-sm font-semibold tracking-wide text-neutral-900 uppercase dark:text-neutral-100">
        {title}
      </h2>
      {subtitle ? <p className="mt-0.5 mb-3 text-xs text-neutral-500">{subtitle}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}

export default async function DashboardPage() {
  const data = await loadDashboard();

  const doneToday = data.todaysTasks.filter((t) => t.status === 'done').length;
  const average =
    data.daily.length > 0
      ? Math.round(
          data.daily.reduce((sum, d) => sum + (Number(d.completion_rate) || 0), 0) / data.daily.length,
        )
      : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 pb-20">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
          Personal AI Manager
        </h1>
        <div className="flex items-baseline gap-3">
        <a href="/dashboard/settings" className="text-xs text-neutral-500 underline">
          settings
        </a>
        <span className="text-xs text-neutral-500">
          {new Date().toLocaleDateString('en-GB', {
            timeZone: 'Asia/Karachi',
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          })}
        </span>
        </div>
      </header>

      {/* Headline block */}
      <div className="mb-4 flex items-center gap-5 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <ProgressRing done={doneToday} total={data.todaysTasks.length} />
        <div className="grid flex-1 grid-cols-2 gap-4">
          <div>
            <div className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
              {data.streak}
              <span className="ml-0.5 text-base font-normal text-neutral-400">day</span>
            </div>
            <div className="text-xs text-neutral-500">Current streak</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
              {average === null ? '—' : `${average}%`}
            </div>
            <div className="text-xs text-neutral-500">30-day average</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
              {data.avoided.length}
            </div>
            <div className="text-xs text-neutral-500">Being avoided</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
              {data.reminders.length}
            </div>
            <div className="text-xs text-neutral-500">Reminders set</div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <Card title="Today" subtitle="Tick these off here or over WhatsApp">
          <TaskList initial={data.todaysTasks} />
        </Card>

        <Card title="Completion rate" subtitle="Last 30 days">
          <CompletionChart daily={data.daily} />
        </Card>

        <Card title="Keeps slipping" subtitle="Carried over more than once">
          {data.avoided.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing is being avoided. Good.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.avoided.map((task) => (
                <li key={task.id} className="flex items-center justify-between text-sm">
                  <span className="text-neutral-800 dark:text-neutral-200">{task.title}</span>
                  <span className="ml-3 shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    {task.rollover_count}× rolled over
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {data.reminders.length > 0 ? (
          <Card title="Upcoming reminders">
            <ul className="space-y-1.5 text-sm">
              {data.reminders.map((reminder) => (
                <li key={reminder.id} className="flex justify-between">
                  <span className="text-neutral-800 dark:text-neutral-200">{reminder.text}</span>
                  <span className="ml-3 shrink-0 text-neutral-500">
                    {new Date(reminder.trigger_at).toLocaleString('en-GB', {
                      timeZone: 'Asia/Karachi',
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card title="Messages" subtitle="Everything in and out, searchable">
          <MessageLog messages={data.messages} />
        </Card>

        <Card title="Learnings">
          {data.learnings.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing saved yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.learnings.map((learning) => (
                <li key={learning.id} className="text-neutral-800 dark:text-neutral-200">
                  {learning.content}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Podcasts">
          {data.podcasts.length === 0 ? (
            <p className="text-sm text-neutral-500">
              None yet. Say &ldquo;I&apos;m feeling low&rdquo; on WhatsApp to generate one.
            </p>
          ) : (
            <ul className="space-y-3">
              {data.podcasts.map((podcast) => (
                <li key={podcast.id}>
                  <div className="mb-1 text-sm text-neutral-800 dark:text-neutral-200">
                    {podcast.topic}
                  </div>
                  {podcast.audio_url ? (
                    <audio controls src={podcast.audio_url} className="w-full" />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Connections">
          <div className="flex items-center justify-between text-sm">
            <span className="text-neutral-800 dark:text-neutral-200">Google (Calendar, Gmail, Drive)</span>
            {data.googleConnected ? (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                connected
              </span>
            ) : (
              <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                not connected
              </span>
            )}
          </div>
        </Card>
      </div>
    </main>
  );
}
