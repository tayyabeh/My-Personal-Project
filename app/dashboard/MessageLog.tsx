'use client';

import { useMemo, useState } from 'react';

interface Message {
  id: string;
  direction: string;
  content: string | null;
  was_voice: boolean;
  created_at: string;
}

export default function MessageLog({ messages }: { messages: Message[] }) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return messages.slice(0, 40);
    return messages.filter((m) => (m.content ?? '').toLowerCase().includes(needle)).slice(0, 60);
  }, [messages, query]);

  return (
    <div>
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search messages…"
        className="mb-3 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950"
      />

      {query && (
        <p className="mb-2 text-xs text-neutral-500">
          {filtered.length} match{filtered.length === 1 ? '' : 'es'}
        </p>
      )}

      <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
        {filtered.map((message) => {
          const inbound = message.direction === 'inbound';
          return (
            <div
              key={message.id}
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                inbound
                  ? 'ml-auto bg-emerald-100 text-neutral-800 dark:bg-emerald-900/40 dark:text-neutral-100'
                  : 'bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100'
              }`}
            >
              {message.was_voice ? (
                <span className="mr-1 text-xs text-neutral-500">🎤</span>
              ) : null}
              {message.content ?? <em className="text-neutral-500">(no text)</em>}
              <div className="mt-1 text-[10px] text-neutral-500">
                {new Date(message.created_at).toLocaleString('en-GB', {
                  timeZone: 'Asia/Karachi',
                  day: 'numeric',
                  month: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 ? (
          <p className="text-sm text-neutral-500">No messages match that.</p>
        ) : null}
      </div>
    </div>
  );
}
