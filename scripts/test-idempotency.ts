/**
 * Idempotency check at the primitive level — no WhatsApp, no LLM.
 *
 * Proves the two new guarantees directly against the real schema:
 *   1. createRun() claims a WhatsApp message id exactly once.
 *   2. insertOnce() runs its effect once and replays on a repeat key.
 *
 * Needs env + migration 7 applied:
 *   npx tsx --env-file=.env.local scripts/test-idempotency.ts
 */
import { db } from '../lib/supabase';
import { createRun } from '../lib/db/runs';
import { insertOnce } from '../lib/db/idempotency';

const runId = crypto.randomUUID();
const waId = `idem-test-${Date.now()}`;

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
  const pass = got === want;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  (got ${String(got)}${pass ? '' : `, want ${String(want)}`})`);
}

async function main() {
  // 1. createRun twice with the same WhatsApp id.
  const first = await createRun({ id: runId, whatsappMessageId: waId, to: '92300', input: 'test' });
  const second = await createRun({ id: crypto.randomUUID(), whatsappMessageId: waId, to: '92300', input: 'test' });
  check('createRun first claim', first, true);
  check('createRun duplicate rejected', second, false);

  const { count: runCount } = await db()
    .from('runs')
    .select('*', { count: 'exact', head: true })
    .eq('whatsapp_message_id', waId);
  check('exactly one runs row', runCount, 1);

  // 2. insertOnce twice with the same key — effect must run once.
  let effectRuns = 0;
  const key = `${runId}:test_write:thing`;
  const a = await insertOnce(key, { runId, tool: 'test_write', effect: 'write' }, async () => {
    effectRuns++;
    return { ok: true, result: { n: 1 } };
  });
  const b = await insertOnce(key, { runId, tool: 'test_write', effect: 'write' }, async () => {
    effectRuns++;
    return { ok: true, result: { n: 2 } };
  });
  check('effect ran exactly once', effectRuns, 1);
  check('first call fresh', a.fresh, true);
  check('second call replay', b.fresh, false);
  check('replay returns first result', (b.result as { n: number } | null)?.n, 1);

  const { count: opCount } = await db()
    .from('write_ops')
    .select('*', { count: 'exact', head: true })
    .eq('idempotency_key', key);
  check('exactly one write_ops row', opCount, 1);

  // Cleanup (write_ops cascades from runs).
  await db().from('runs').delete().eq('whatsapp_message_id', waId);

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
