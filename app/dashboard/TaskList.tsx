'use client';

import { useState, useTransition } from 'react';

interface Task {
  id: string;
  title: string;
  status: string;
  priority: string;
}

export default function TaskList({ initial }: { initial: Task[] }) {
  const [tasks, setTasks] = useState(initial);
  const [, startTransition] = useTransition();

  async function toggle(id: string, done: boolean) {
    // Update the checkbox immediately; the network call catches up.
    setTasks((current) =>
      current.map((task) => (task.id === id ? { ...task, status: done ? 'done' : 'pending' } : task)),
    );

    startTransition(async () => {
      const response = await fetch('/api/tasks/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, done }),
      });

      // Put it back if the server disagreed, rather than showing a lie.
      if (!response.ok) {
        setTasks((current) =>
          current.map((task) =>
            task.id === id ? { ...task, status: done ? 'pending' : 'done' } : task,
          ),
        );
      }
    });
  }

  if (tasks.length === 0) {
    return <p className="text-sm text-neutral-500">Nothing scheduled for today.</p>;
  }

  return (
    <ul className="space-y-1">
      {tasks.map((task) => {
        const done = task.status === 'done';
        return (
          <li key={task.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-neutral-100 dark:hover:bg-neutral-800">
              <input
                type="checkbox"
                checked={done}
                onChange={(event) => toggle(task.id, event.target.checked)}
                className="size-4 shrink-0 accent-neutral-900 dark:accent-neutral-100"
              />
              <span
                className={
                  done
                    ? 'text-neutral-400 line-through dark:text-neutral-600'
                    : 'text-neutral-800 dark:text-neutral-200'
                }
              >
                {task.title}
              </span>
              {task.priority === 'high' && !done ? (
                <span className="ml-auto rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
                  high
                </span>
              ) : null}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
