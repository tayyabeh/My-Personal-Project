/**
 * Manual smoke test for the outbound path.
 *
 * Run it with:
 *   npx tsx --env-file=.env.local scripts/test-send.ts
 *
 * It exercises the real adapter — the same code the webhook uses — so a
 * pass here means environment loading, the Graph API call, and the
 * Supabase write are all genuinely working.
 */
import { messaging } from '../lib/messaging';
import { db } from '../lib/supabase';

async function main() {
  console.log('1. Sending the hello_world template through our WhatsAppAdapter...');
  await messaging.sendTemplate({
    name: 'hello_world',
    language: 'en_US', // hello_world is registered as en_US, not en
    params: [],
  });
  console.log('   sent.');

  console.log('2. Checking it was recorded in Supabase...');
  const { data, error } = await db()
    .from('messages')
    .select('direction, content, created_at')
    .order('created_at', { ascending: false })
    .limit(3);

  if (error) throw new Error(`Supabase read failed: ${error.message}`);
  console.log('   last rows in messages table:');
  for (const row of data ?? []) {
    console.log(`     [${row.direction}] ${String(row.content).slice(0, 60)}`);
  }

  console.log('\nOutbound path works end to end.');
}

main().catch((error) => {
  console.error('\nFAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
