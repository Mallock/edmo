/** The full acceptance battery for a candidate model: gate, news, tools. */
import { buildBeatGateChat, parseBeatGate } from './src/engine/copilot.ts';
import { buildStoryChat, parseStory, newsMaxTokens, acceptNews, buildNewsBrief } from './src/engine/news.ts';
import { idleAskSystem } from './src/engine/operator.ts';
import { TOOL_SCHEMAS } from './src/engine/tools.ts';
import type { SystemIntel } from './src/engine/types.ts';
const [PORT, KEY, MODEL, THINK] = process.argv.slice(2);
async function call(messages: unknown[], max: number, temp = 0, tools = false) {
  const body: Record<string, unknown> = { model: MODEL, messages, max_tokens: max, temperature: temp, stream: false,
    // 4th arg 'plain' omits the reasoning switch — Llama-family templates
    // do not know it and can 400 on the unexpected kwarg.
    ...(THINK === 'plain' ? {} : { chat_template_kwargs: { enable_thinking: false } }) };
  if (tools) body.tools = TOOL_SCHEMAS;
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  const m = j.choices?.[0]?.message ?? {};
  return { ms: Date.now() - t0, text: (m.content ?? '').trim(),
    calls: (m.tool_calls ?? []).map((c: { function?: { name?: string } }) => c.function?.name) };
}
const INTEL: SystemIntel = { security: 'Low Security', controllingFaction: 'Explorer on Tour',
  factions: [{ name: 'Explorer on Tour', influence: 0.45 }], signals: [{ name: 'Anders City', isStation: true }] };
async function main() {
  console.log('--- BEAT GATE (4 SPEAK-worthy, 2 skip controls) ---');
  const events: [string, string][] = [
    ['SPEAK', 'EVENT: Interdicted by a wanted Anaconda - shields down to 12%.'],
    ['SPEAK', 'EVENT: Mission completed - 4,180,000 cr paid.'],
    ['SPEAK', 'EVENT: First discovery - you are the first commander to scan this body.'],
    ['SPEAK', 'EVENT: Hull at 31% after taking fire.'],
    ['skip ', 'EVENT: Docked at Anders City.'],
    ['skip ', 'EVENT: Undocked from Anders City.'],
  ];
  let gateOk = 0;
  for (const [want, e] of events) {
    const r = await call(buildBeatGateChat(e), 8);
    const got = parseBeatGate(r.text) ? 'SPEAK' : 'skip ';
    if (got === want) gateOk++;
    console.log(`  want ${want} got ${got} ${got === want ? ' ' : '✗'} (${r.ms}ms)`);
  }
  console.log(`  gate: ${gateOk}/6 correct`);
  console.log('\n--- NEWS (prose wire, 3 desks) ---');
  const brief = buildNewsBrief('HIP 71120', INTEL);
  const stories = [];
  for (const desk of ['civic', 'crime', 'life'] as const) {
    const r = await call(buildStoryChat(brief, desk, [], 'wry', 0), newsMaxTokens(1), 0.85);
    const s = parseStory(r.text, desk);
    if (s) { stories.push(s); console.log(`  [${desk}] ${r.ms}ms  ${s.headline.slice(0, 70)}`); }
    else console.log(`  [${desk}] ${r.ms}ms  !! unparseable: ${JSON.stringify(r.text).slice(0, 80)}`);
  }
  const { items, rejected } = acceptNews(stories, { brief, system: 'HIP 71120', at: 'x', max: 3, desks: ['civic','crime','life'] });
  console.log(`  news: parsed ${stories.length}/3, published ${items.length}, spiked ${rejected.length}`);
  console.log('\n--- TOOL LOOP (the Llama trap: a tool call for "hello") ---');
  for (const q of ['hello', 'What should I be doing here?']) {
    const r = await call([
      { role: 'system', content: idleAskSystem('Mikal') },
      { role: 'user', content: `FACTS:\nCurrent system (HIP 71120): Low Security\n\nCommander asks: ${q}` },
    ], 220, 0.8, true);
    console.log(`  "${q}" -> ${r.calls.length ? 'CALLED ' + r.calls.join(',') : 'prose'} (${r.ms}ms)`);
    if (r.text) console.log(`     ${r.text.slice(0, 130).replace(/\n/g, ' ')}`);
  }
}
void main();
