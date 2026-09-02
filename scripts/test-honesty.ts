/**
 * Standalone check of the claim filter. No env, no network — pure logic.
 * Run: npx tsx scripts/test-honesty.ts
 */
import { checkSentence, buildReply } from '../lib/honesty';
import { ok, type Receipt } from '../lib/tools/types';

let failures = 0;
function expect(label: string, got: string, want: string) {
  const pass = got === want;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  (got: ${got}${pass ? '' : `, want: ${want}`})`);
}

const noReceipts: Receipt[] = [];
const writeReceipt: Receipt[] = [ok({ tool: 't', effect: 'write', factLine: '2 task save hue.', numbers: [2] })];

// 1. Completion claim with no backing write -> stripped
expect('completion no-backing', checkSentence('tasks add kar diye', noReceipts).verdict, 'stripped');
// 2. Promise phrasing -> always stripped
expect('promise', checkSentence('abhi kar deta hoon', noReceipts).verdict, 'stripped');
expect('promise english', checkSentence("i'll add that for you", noReceipts).verdict, 'stripped');
// 3. Unbacked number -> stripped
expect('unbacked number', checkSentence('3 tasks pending hain', noReceipts).verdict, 'stripped');
// 4. Completion claim WITH backing write -> kept
expect('completion backed', checkSentence('2 task save kar diye', writeReceipt).verdict, 'kept');
// 5. Backed number -> kept
expect('backed number', checkSentence('total 2 hue', writeReceipt).verdict, 'kept');
// 6. Plain factual line, no claim -> kept
expect('neutral kept', checkSentence('theek hai bhai', noReceipts).verdict, 'kept');

// buildReply prepends an ok write factLine the model prose omitted, and
// strips an invented promise.
const built = buildReply('abhi kar deta hoon', writeReceipt);
console.log(`\nbuildReply -> "${built}"`);
expect('buildReply keeps factLine', built.includes('2 task save hue') ? 'yes' : 'no', 'yes');
expect('buildReply drops promise', built.includes('kar deta hoon') ? 'yes' : 'no', 'no');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
