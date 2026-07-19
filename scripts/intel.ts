/**
 * Diagnostic: fold the newest journal session(s) and print what the operator
 * knows right now — location, missions, system intel, and due heartbeat nudges.
 * Usage: node scripts/intel.ts [--sessions N] [--ask "question"]
 *   --ask sends the question to live LM Studio with the full mission context
 *   (exactly what the HUD sends) and prints the answer.
 */
import { defaultJournalDir, listJournals, readJournalFile } from '../src/engine/journal.ts';
import { MissionStateManager } from '../src/engine/state.ts';
import { Heartbeat } from '../src/engine/heartbeat.ts';
import { SessionStats } from '../src/engine/stats.ts';
import { buildChat, describeSystemIntel, missionContext } from '../src/engine/operator.ts';
import { LmStudioClient } from '../src/engine/lmstudio.ts';

const argIdx = process.argv.indexOf('--sessions');
const sessions = argIdx >= 0 ? Math.max(1, Number(process.argv[argIdx + 1]) || 2) : 2;

const dir = defaultJournalDir();
const files = listJournals(dir).slice(-sessions);
if (!files.length) {
  console.error(`No journals found in ${dir}`);
  process.exit(1);
}
const sm = new MissionStateManager();
const stats = new SessionStats();
for (const f of files) {
  for (const ev of readJournalFile(f)) {
    sm.apply(ev);
    stats.apply(ev);
  }
}
const st = sm.getState();

console.log(`Journals   : ${files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`);
console.log(`Location   : ${st.location.station ? `${st.location.station}, ` : ''}${st.location.system}${st.docked ? ' (docked)' : ''}`);
console.log(`Missions   : ${st.activeMissions.length}`);
for (const m of st.activeMissions) {
  console.log(`  #${m.id} ${m.category} — ${m.title} (${m.reward.toLocaleString('en-US')} cr)`);
  for (const s of m.steps) console.log(`      [${s.done ? 'x' : ' '}] ${s.label}`);
}
console.log('\n--- Session ledger ---');
console.log(stats.ledgerSummary() ?? '(nothing earned this session)');
if (stats.riskNote()) console.log(stats.riskNote());
if (sm.communityGoals.length) {
  console.log('\n--- Community Goals ---');
  for (const cg of sm.communityGoals) {
    console.log(`  "${cg.title}" — ${cg.market} in ${cg.system} · ${cg.contributors} pilots · bonus ${cg.bonus.toLocaleString('en-US')} cr`);
  }
}

console.log('\n--- System intel (what the AI sees) ---');
console.log(describeSystemIntel(st) ?? '(nothing known yet — no FSS signals this session)');
console.log('\n--- Heartbeat nudges due right now ---');
const nudges = new Heartbeat().evaluate(st, new Date().toISOString());
if (!nudges.length) console.log('(none)');
for (const n of nudges) console.log(`[${n.severity}] ${n.rule}: ${n.message}`);
const focus =
  st.activeMissions.find((m) => m.category === 'Assassinate' || m.category === 'Massacre') ??
  st.activeMissions[0];
if (focus) {
  console.log(`\n--- Full AI context for "${focus.title}" ---`);
  console.log(missionContext(focus, { ...st, now: new Date().toISOString() }));
}

if (process.argv.includes('--story')) {
  const { buildFlavorChat, planStory, ruleBasedFlavor } = await import('../src/engine/flavor.ts');
  const live = { ...st, now: new Date().toISOString() };
  const plan = planStory(st.activeMissions, Math.random);
  console.log('\n--- Operator chatter (offline template) ---');
  console.log(ruleBasedFlavor(st.activeMissions, live, Math.random) ?? '(no missions)');
  if (plan) {
    console.log('\n--- Operator chatter (LM Studio) ---');
    const answer = await new LmStudioClient({ timeoutMs: 120_000, temperature: 0.9 }).chat(
      buildFlavorChat(plan, live),
    );
    console.log(answer ?? '(LM Studio unavailable or empty reply)');
  }
}

const askIdx = process.argv.indexOf('--ask');
if (askIdx >= 0) {
  const question = process.argv[askIdx + 1] ?? 'What should I do right now?';
  const target = st.activeMissions[0];
  if (!target) {
    console.error('No active mission to ask about.');
    process.exit(1);
  }
  const messages = buildChat(target, { ...st, now: new Date().toISOString() }, question);
  console.log(`\n--- Asking LM Studio: "${question}" ---`);
  const answer = await new LmStudioClient({ timeoutMs: 120_000 }).chat(messages);
  console.log(answer ?? '(LM Studio unavailable or empty reply)');
}
