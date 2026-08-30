/**
 * Tiny logger. Everything it prints shows up in the Vercel dashboard
 * under your project -> Logs, which is where you will do most of your
 * debugging once this is deployed.
 */
type Fields = Record<string, unknown>;

function line(level: string, message: string, fields?: Fields) {
  const stamp = new Date().toISOString();
  const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
  return `[${stamp}] ${level} ${message}${extra}`;
}

export const log = {
  info: (message: string, fields?: Fields) => console.log(line('INFO ', message, fields)),
  warn: (message: string, fields?: Fields) => console.warn(line('WARN ', message, fields)),
  error: (message: string, fields?: Fields) => console.error(line('ERROR', message, fields)),
};
