import { handle } from '../lib/agents/orchestrator';
async function main() {
  const r = await handle({
    to: '923273844643',
    input: '3 September wala reminder raat 11 baje kar do, 9 baje nahi',
    history: [], say: async () => {},
  });
  console.log('> 3 September wala reminder raat 11 baje kar do');
  console.log('  tools: ' + (r.steps.join(' -> ') || '(none)'));
  console.log('  reply: ' + r.reply.replace(/\n/g, ' ⏎ ').slice(0, 220));
}
main().catch(e => { console.error(e.message); process.exit(1); });
