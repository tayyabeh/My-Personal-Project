/**
 * Tiny logger. Everything it prints shows up in the Vercel dashboard
 * under your project -> Logs, which is where you will do most of your
 * debugging once this is deployed.
 *
 * `error` is also persisted to `records` (kind 'log'), because Vercel's
 * logs are not reachable from inside the app — that blind spot is what
 * made an earlier timeout bug so slow to diagnose. The persist is
 * fire-and-forget so the logger stays synchronous for its ~30 callers,
 * and a failed persist falls back to console (the always-available sink)
 * rather than throwing into an arbitrary call site.
 */
import { writeLog } from './db/log-store';

type Fields = Record<string, unknown>;

function line(level: string, message: string, fields?: Fields) {
  const stamp = new Date().toISOString();
  const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
  return `[${stamp}] ${level} ${message}${extra}`;
}

export const log = {
  info: (message: string, fields?: Fields) => console.log(line('INFO ', message, fields)),
  warn: (message: string, fields?: Fields) => console.warn(line('WARN ', message, fields)),
  error: (message: string, fields?: Fields) => {
    console.error(line('ERROR', message, fields));
    void writeLog('error', message, fields).catch((e) =>
      console.error('[log-store] failed to persist log', e),
    );
  },
};
