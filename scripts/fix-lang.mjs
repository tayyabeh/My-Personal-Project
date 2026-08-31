/**
 * Repairs string literals broken by an earlier inline edit.
 *
 * Passing "\n\n" through a shell heredoc into a node -e script turned it
 * into a real newline inside single-quoted JavaScript strings, which is a
 * syntax error. This rewrites those back into escape sequences.
 *
 * Written as a file, not an inline command, because the inline route is
 * precisely what broke them.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILES = [
  'lib/features/links.ts',
  'lib/features/weekly-review.ts',
  'lib/features/search.ts',
  'lib/features/email.ts',
  'lib/features/drive.ts',
];

let fixed = 0;

for (const file of FILES) {
  const before = readFileSync(file, 'utf8');
  // A real newline pair immediately before the closing quote of a string
  // that is concatenated with ROMAN_URDU.
  const after = before.replace(/\n\n' \+ ROMAN_URDU/g, "\\n\\n' + ROMAN_URDU");

  if (after !== before) {
    writeFileSync(file, after);
    const count = (before.match(/\n\n' \+ ROMAN_URDU/g) || []).length;
    console.log(`  fixed ${count} broken string(s) in ${file}`);
    fixed += count;
  } else {
    console.log(`  nothing to fix in ${file}`);
  }
}

// The two replacements that silently did not match earlier.
const tasks = 'lib/features/tasks.ts';
let t = readFileSync(tasks, 'utf8');
if (t.includes('…and ${tasks.length - 15} more.')) {
  t = t.replace('…and ${tasks.length - 15} more.', '…aur ${tasks.length - 15} baaki.');
  writeFileSync(tasks, t);
  console.log('  fixed pendingSummary overflow line');
  fixed++;
}

const learn = 'lib/features/learnings.ts';
let l = readFileSync(learn, 'utf8');
if (l.includes('Remember this?')) {
  l = l.replace('Remember this?', 'Ye yaad hai?');
  writeFileSync(learn, l);
  console.log('  fixed learning resurface message');
  fixed++;
}

console.log(`\n${fixed} repair(s) applied.`);
