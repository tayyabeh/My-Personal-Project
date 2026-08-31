/**
 * Converts the remaining hard-coded English message bodies to Roman Urdu.
 *
 * A file rather than an inline command, and every replacement is checked,
 * because two earlier inline attempts silently matched nothing and one
 * corrupted string literals.
 */
import { readFileSync, writeFileSync } from 'node:fs';

let missed = 0;

function edit(file, pairs) {
  let text = readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    if (!text.includes(from)) {
      console.log(`  MISS  ${file} :: ${from.slice(0, 60)}`);
      missed++;
      continue;
    }
    text = text.split(from).join(to);
    console.log(`  ok    ${file} :: ${from.slice(0, 60)}`);
  }
  writeFileSync(file, text);
}

edit('lib/features/summary.ts', [
  // night summary
  ['`No tasks logged today. ${line}`', '`Aaj koi task log nahi hua. ${line}`'],
  ['`Today: ${completed} of ${planned} done (${rate}%).`', '`Aaj: ${planned} mein se ${completed} ho gaye (${rate}%).`'],
  ['`\\n\\nRolled to tomorrow:\\n${unfinished.map((t) => `• ${t.title}`).join(\'\\n\')}`',
   '`\\n\\nKal pe chale gaye:\\n${unfinished.map((t) => `• ${t.title}`).join(\'\\n\')}`'],
  // morning greeting
  ['`Good morning! ${line}` +', '`Subah bakhair! ${line}` +'],
  ['`\\n\\nStill carried over:\\n${rolled', '`\\n\\nAb tak taale hue:\\n${rolled'],
  ['`\\n\\nWhat are your tasks for today?`', '`\\n\\nAaj kya karna hai?`'],
  // check-in
  ['`\\n\\nTell me if any of these are done.`', '`\\n\\nBatao inmein se kuch ho gaya?`'],
]);

edit('lib/features/weekly-review.ts', [
  ['"Weekly review: there\'s nothing to review. No tasks were logged at all this week. " +\n        \'If you want this to be useful, it needs something to work with.\'',
   "'Weekly review: review karne ko kuch hai hi nahi. Is hafte koi task log nahi hua. ' +\n        'Ye cheez kaam ki tab hai jab isko kuch data mile.'"],
  ['const heading = `Weekly review — ${new Date().toLocaleDateString(\'en-GB\', {',
   'const heading = `Hafte ka review — ${new Date().toLocaleDateString(\'en-GB\', {'],
]);

edit('lib/features/search.ts', [
  ['"I couldn\'t search for that right now — DuckDuckGo is blocking requests from the " +\n        \'server and Wikipedia had nothing. Ask me again later, or tell me to set up a proper \' +\n        \'search key.\'',
   "'Abhi search nahi kar paya. Thori der baad pooch lo.'"],
]);

edit('lib/features/email.ts', [
  ['return `Nothing in your inbox matched "${topic}". (Searched: ${query})`;',
   'return `Inbox mein "${topic}" ke baare mein kuch nahi mila.`;'],
  ["if (mail.length === 0) return 'Nothing unread in the last three days that looks like it needs you.';",
   "if (mail.length === 0) return 'Pichle 3 din mein aisa kuch unread nahi jiska jawab chahiye.';"],
]);

edit('lib/features/expenses.ts', [
  ["if (!data || data.length === 0) return 'Nothing logged this month.';",
   "if (!data || data.length === 0) return 'Is mahine kuch log nahi hua.';"],
  ['return `This month: ${format(total)}\\n\\n${lines.join(\'\\n\')}`;',
   'return `Is mahine: ${format(total)}\\n\\n${lines.join(\'\\n\')}`;'],
]);

edit('lib/features/drive.ts', [
  ['return `Nothing in your Drive matched "${terms}".`;',
   'return `Drive mein "${terms}" se kuch nahi mila.`;'],
  ["return `Found \"${file.name}\", but it isn't a readable text file.\\n${file.webViewLink ?? ''}`;",
   'return `"${file.name}" mila, lekin ye readable text file nahi hai.\\n${file.webViewLink ?? \'\'}`;'],
  ["return `${files.length} files matched \"${terms}\":\\n${list}\\n\\nName one and I'll summarise it.`;",
   'return `${files.length} files mili "${terms}" ke liye:\\n${list}\\n\\nKisi ek ka naam lo, summary bana dunga.`;'],
]);

console.log(missed === 0 ? '\nALL APPLIED' : `\n${missed} MISSED`);
