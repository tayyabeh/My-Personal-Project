import { handle } from '../lib/agents/orchestrator';
async function main() {
  const r = await handle({
    to: '923273844643',
    input: 'AI updates search karo aur uski voice bana kar sunao mujhe',
    history: [],
    say: async (t) => console.log('  [interim] ' + t.slice(0, 60)),
  });
  console.log('> AI updates search karo aur uski voice bana kar sunao mujhe');
  console.log('  tools: ' + (r.steps.join(' -> ') || '(none)'));
  console.log('  reply: ' + r.reply.replace(/\n/g, ' ⏎ ').slice(0, 220));
}
main().catch(e => { console.error(e.message); process.exit(1); });
