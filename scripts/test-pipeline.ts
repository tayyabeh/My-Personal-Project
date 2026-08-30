/**
 * Dry run of the language pipeline. Sends no WhatsApp messages and writes
 * nothing to the database — it only exercises the model calls.
 *
 *   npx tsx --env-file=.env.local scripts/test-pipeline.ts
 */
import { classifyIntent } from '../lib/features/intent';
import { extractTasks, matchCompletion } from '../lib/features/tasks';
import type { TaskRow } from '../lib/context';

const INTENT_CASES: Array<[string, string]> = [
  ['today I need to finish the proposal and call ammi', 'add_tasks'],
  ['done with the proposal', 'complete_task'],
  ['proposal ho gaya', 'complete_task'],
  ['what do I have left', 'list_tasks'],
  ['how are you doing', 'other'],
  ['gym done', 'complete_task'],
];

const FAKE_PENDING: TaskRow[] = [
  { id: 'a1', title: 'Finish the client proposal', status: 'pending', rollover_count: 3 },
  { id: 'b2', title: 'Call my brother', status: 'pending', rollover_count: 0 },
  { id: 'c3', title: 'Go to the gym', status: 'pending', rollover_count: 1 },
];

async function main() {
  console.log('=== 1. INTENT CLASSIFICATION ===');
  let passed = 0;
  for (const [input, expected] of INTENT_CASES) {
    const got = await classifyIntent(input);
    const ok = got === expected;
    if (ok) passed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  "${input}"`);
    console.log(`        expected=${expected}  got=${got}`);
  }
  console.log(`  -> ${passed}/${INTENT_CASES.length} correct\n`);

  console.log('=== 2. TASK EXTRACTION (messy speech) ===');
  const messy =
    'umm ok so today I need to finish the client proposal uh call my brother about ' +
    'the thing and go to the gym also maybe pick up groceries if theres time and ' +
    'the flurgen report is urgent';
  const extracted = await extractTasks(messy);
  if (!extracted.ok) {
    console.log('  FAILED:', extracted.error);
  } else {
    for (const task of extracted.tasks) {
      console.log(
        `  • ${task.title}  [${task.priority}]${task.uncertain ? '  <- uncertain, will ask' : ''}`,
      );
    }
  }
  console.log();

  console.log('=== 3. COMPLETION MATCHING ===');
  const matchCases = [
    ['done with the proposal', 'Finish the client proposal'],
    ['finished at the gym', 'Go to the gym'],
    ['talked to bhai', 'Call my brother'],
    ['washed the car', null],
  ] as const;

  for (const [phrase, expectedTitle] of matchCases) {
    const match = await matchCompletion(phrase, FAKE_PENDING);
    const got = match?.title ?? null;
    const ok = got === expectedTitle;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  "${phrase}"`);
    console.log(`        expected=${expectedTitle ?? 'no match'}  got=${got ?? 'no match'}`);
  }
}

main().catch((error) => {
  console.error('FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
