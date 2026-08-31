import { db } from '@/lib/supabase';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings' };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Times arrive from Postgres as "13:00:00"; the input wants "13:00". */
function hhmm(value: unknown, fallback: string): string {
  const text = String(value ?? '');
  return /^\d{2}:\d{2}/.test(text) ? text.slice(0, 5) : fallback;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200">{label}</span>
      {hint ? <span className="mt-0.5 block text-xs text-neutral-500">{hint}</span> : null}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100';

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string }>;
}) {
  const params = await searchParams;

  const { data } = await db()
    .from('settings')
    .select('morning_time, night_time, checkin_times, weekly_time, weekly_dow, resurface_time, timezone')
    .eq('id', 1)
    .maybeSingle();

  const checkins = ((data?.checkin_times as string[] | null) ?? []).map((t) => t.slice(0, 5));

  return (
    <main className="mx-auto max-w-xl px-4 py-8 pb-20">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">Settings</h1>
        <Link href="/dashboard" className="text-sm text-neutral-500 underline">
          back
        </Link>
      </header>

      {params.saved ? (
        <p className="mb-4 rounded-lg bg-emerald-100 px-3 py-2 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
          Save ho gaya. Agle tick se naya waqt chalu.
        </p>
      ) : null}

      <form
        action="/api/settings"
        method="post"
        className="space-y-5 rounded-2xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <p className="text-xs text-neutral-500">
          Sab waqt {String(data?.timezone ?? 'Asia/Karachi')} ke hisab se. 24-hour format:{' '}
          <code>07:00</code>, <code>22:30</code>.
        </p>

        <Field label="Morning greeting" hint="Din ka pehla message, tasks poochne ke liye">
          <input name="morning_time" defaultValue={hhmm(data?.morning_time, '10:00')} className={inputClass} />
        </Field>

        <Field label="Night summary" hint="Din band karne ka waqt. Aadhi raat ke baad ho to pichla din summarise hoga.">
          <input name="night_time" defaultValue={hhmm(data?.night_time, '03:00')} className={inputClass} />
        </Field>

        <Field label="Check-ins" hint="Comma se alag karo. Jitne chaho utne. Khali list nahi chalegi.">
          <input
            name="checkin_times"
            defaultValue={checkins.join(', ')}
            placeholder="13:00, 16:00, 19:00, 22:00, 01:00"
            className={inputClass}
          />
        </Field>

        <Field label="Learning reminder" hint="Purani seekhi hui cheez wapas dikhane ka waqt">
          <input name="resurface_time" defaultValue={hhmm(data?.resurface_time, '18:00')} className={inputClass} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Weekly review — din">
            <select
              name="weekly_dow"
              defaultValue={String(data?.weekly_dow ?? 0)}
              className={inputClass}
            >
              {DAYS.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Weekly review — waqt">
            <input name="weekly_time" defaultValue={hhmm(data?.weekly_time, '21:00')} className={inputClass} />
          </Field>
        </div>

        <button
          type="submit"
          className="w-full rounded-lg bg-neutral-900 px-4 py-2.5 font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
        >
          Save
        </button>

        <p className="text-xs text-neutral-500">
          Scheduler har 5 minute chalta hai, to naya waqt 5 minute ke andar lag jata hai. Koi SQL
          dobara chalane ki zaroorat nahi.
        </p>
      </form>
    </main>
  );
}
