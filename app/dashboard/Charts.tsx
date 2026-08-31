/**
 * Dashboard visuals, drawn as plain SVG.
 *
 * No charting library: this is a handful of rectangles and one arc, and a
 * chart package would be a large dependency on a free-tier bundle.
 *
 * Both of these are built to look like a chart on day one, before any
 * history exists. An empty panel reads as broken; a chart showing thirty
 * empty days reads as "nothing here yet", which is the truth.
 */

interface DailyRow {
  log_date: string;
  completion_rate: number;
  tasks_completed: number;
  tasks_planned: number;
}

/** A ring showing today's progress. */
export function ProgressRing({ done, total }: { done: number; total: number }) {
  const fraction = total === 0 ? 0 : done / total;
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const filled = circumference * fraction;

  return (
    <div className="relative grid size-24 place-items-center">
      <svg viewBox="0 0 80 80" className="size-24 -rotate-90">
        <circle
          cx="40"
          cy="40"
          r={radius}
          fill="none"
          strokeWidth="7"
          className="stroke-neutral-200 dark:stroke-neutral-800"
        />
        <circle
          cx="40"
          cy="40"
          r={radius}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${circumference - filled}`}
          className={
            fraction >= 0.7
              ? 'stroke-emerald-500'
              : fraction > 0
                ? 'stroke-amber-500'
                : 'stroke-neutral-300 dark:stroke-neutral-700'
          }
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-xl leading-none font-semibold text-neutral-900 dark:text-neutral-100">
          {done}
          <span className="text-neutral-400">/{total}</span>
        </div>
        <div className="mt-0.5 text-[10px] tracking-wide text-neutral-500 uppercase">today</div>
      </div>
    </div>
  );
}

/**
 * Thirty days of completion rate. Days with no log are drawn as faint
 * placeholders rather than skipped, so the axis stays honest about gaps.
 */
export function CompletionChart({ daily }: { daily: DailyRow[] }) {
  const byDate = new Map(daily.map((d) => [d.log_date, d]));

  const days: Array<{ date: string; row: DailyRow | undefined }> = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Karachi',
    });
    days.push({ date, row: byDate.get(date) });
  }

  const width = 300;
  const height = 90;
  const gap = 2;
  const barWidth = (width - gap * (days.length - 1)) / days.length;
  const logged = daily.length;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-28 w-full" preserveAspectRatio="none">
        {/* 50% guide line */}
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          strokeDasharray="3 3"
          className="stroke-neutral-200 dark:stroke-neutral-800"
          strokeWidth="1"
        />
        {days.map((day, index) => {
          const x = index * (barWidth + gap);
          if (!day.row) {
            return (
              <rect
                key={day.date}
                x={x}
                y={height - 3}
                width={barWidth}
                height={3}
                rx={1}
                className="fill-neutral-200 dark:fill-neutral-800"
              />
            );
          }
          const value = Number(day.row.completion_rate) || 0;
          const barHeight = Math.max(3, (value / 100) * height);
          return (
            <rect
              key={day.date}
              x={x}
              y={height - barHeight}
              width={barWidth}
              height={barHeight}
              rx={1}
              className={
                value >= 70
                  ? 'fill-emerald-500'
                  : value >= 40
                    ? 'fill-amber-500'
                    : 'fill-red-400 dark:fill-red-500'
              }
            >
              <title>{`${day.date}: ${value}% (${day.row.tasks_completed}/${day.row.tasks_planned})`}</title>
            </rect>
          );
        })}
      </svg>

      <div className="mt-2 flex items-center justify-between text-xs text-neutral-500">
        <span>30 days ago</span>
        {logged === 0 ? (
          <span className="text-neutral-400">no days logged yet — first one lands tonight at 3am</span>
        ) : (
          <span>
            {logged} day{logged === 1 ? '' : 's'} logged
          </span>
        )}
        <span>today</span>
      </div>
    </div>
  );
}
