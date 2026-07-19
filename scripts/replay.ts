/**
 * Mission Operator — journal replay demo.
 *
 * Replays an Elite Dangerous journal through the engine and prints the timeline
 * the operator would have produced live: mission briefings, redirects, arrival
 * hand-in reminders, completions, and — the headline feature — proactive
 * heartbeat nudges when the commander stalls.
 *
 * Usage:
 *   node scripts/replay.ts [journalPath] [--ai] [--fixture] [--max N]
 *     (no path)   -> newest journal in your Saved Games, else the bundled fixture
 *     --fixture   -> force the bundled real-session fixture
 *     --ai        -> also show live LM Studio guidance at key moments
 *     --max N      -> print only the first N timeline entries
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { defaultJournalDir, newestJournal, readJournalFile } from '../src/engine/journal.ts';
import { runReplay } from '../src/engine/replay.ts';
import type { ReplayEntry } from '../src/engine/replay.ts';
import { LmStudioClient } from '../src/engine/lmstudio.ts';
import {
  buildChat,
  describeMission,
  formatCredits,
  missionContext,
  ruleBasedAdvice,
  systemPromptFor,
} from '../src/engine/operator.ts';
import type { Mission, OperatorState } from '../src/engine/types.ts';
import type { MissionStateManager } from '../src/engine/state.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', 'fixtures', 'journal', 'session-couriers-assassinate.log');

const args = process.argv.slice(2);
const useAi = args.includes('--ai');
const useFixture = args.includes('--fixture');
const maxIdx = args.indexOf('--max');
const maxEntries = maxIdx >= 0 ? Number(args[maxIdx + 1]) : Infinity;
const positional = args.find((a) => !a.startsWith('--') && a !== String(maxEntries));

function resolveJournal(): string {
  if (positional && existsSync(positional)) return positional;
  if (useFixture) return FIXTURE;
  const newest = newestJournal(defaultJournalDir());
  return newest ?? FIXTURE;
}

const ICON: Record<ReplayEntry['kind'], string> = {
  briefing: '📋',
  redirect: '🎯',
  arrival: '🛬',
  complete: '✅',
  cargo: '📦',
  abandoned: '🏳️ ',
  failed: '❌',
  nudge: '💡',
};

const SEV_TAG: Record<string, string> = { info: 'INFO ', warn: 'WARN ', urgent: 'URGENT' };

const hhmmss = (iso: string): string => (iso.length >= 19 ? iso.slice(11, 19) : iso);

function renderEntry(e: ReplayEntry): string {
  if (e.kind === 'nudge') {
    const tag = SEV_TAG[e.severity ?? 'info'] ?? '';
    return `  ${hhmmss(e.time)}  💡 HEARTBEAT [${tag} · ${e.rule}]  ${e.text}`;
  }
  return `  ${hhmmss(e.time)}  ${ICON[e.kind]} ${e.text}`;
}

function main(): void {
  const path = resolveJournal();
  const events = readJournalFile(path);
  const { entries, state } = runReplay(events);

  const span =
    events.length > 0 ? `${hhmmss(events[0].timestamp)} → ${hhmmss(events[events.length - 1].timestamp)}` : 'n/a';

  console.log('═'.repeat(78));
  console.log('  ELITE DANGEROUS — MISSION OPERATOR · journal replay');
  console.log('═'.repeat(78));
  console.log(`  Journal : ${path}`);
  console.log(`  Events  : ${events.length}   Session: ${span}`);
  console.log(`  Output  : ${entries.length} operator messages`);
  console.log('─'.repeat(78));

  const shown = entries.slice(0, maxEntries);
  for (const e of shown) console.log(renderEntry(e));
  if (shown.length < entries.length) console.log(`  … (${entries.length - shown.length} more; use --max to change)`);

  printSummary(entries, state);

  if (useAi) {
    void aiSection(state).catch((err) => console.error('AI section error:', err));
  }
}

function printSummary(entries: ReplayEntry[], state: MissionStateManager): void {
  const completed = state.allMissions().filter((m) => m.state === 'COMPLETE');
  const credits = completed.reduce((s, m) => s + m.reward, 0);
  const nudges = entries.filter((e) => e.kind === 'nudge');
  const byRule = new Map<string, number>();
  for (const n of nudges) byRule.set(n.rule ?? '?', (byRule.get(n.rule ?? '?') ?? 0) + 1);

  console.log('─'.repeat(78));
  console.log('  SUMMARY');
  console.log(`    Missions completed : ${completed.length}   Credits earned: ${formatCredits(credits)}`);
  console.log(`    Proactive nudges   : ${nudges.length}`);
  for (const [rule, n] of byRule) console.log(`        • ${rule.padEnd(14)} ${n}`);
  const byCat = new Map<string, number>();
  for (const m of state.allMissions()) byCat.set(m.category, (byCat.get(m.category) ?? 0) + 1);
  console.log(`    Mission categories : ${[...byCat].map(([c, n]) => `${c}×${n}`).join(', ')}`);
  console.log('═'.repeat(78));
}

// --- Live LM Studio enrichment at a few marquee moments -----------------------

function fakeState(m: Mission, loc: OperatorState['location'], now: string): OperatorState {
  return { now, location: loc, docked: false, activeMissions: [m], lastActivityAt: now };
}

function questionFor(m: Mission): string {
  switch (m.category) {
    case 'Assassinate':
    case 'Massacre':
      return "I've just accepted this. How should I approach it?";
    case 'Delivery':
    case 'Collect':
    case 'Salvage':
    case 'Mining':
      return 'What do I need to complete this delivery efficiently?';
    default:
      return 'Any tips for completing this quickly?';
  }
}

async function aiSection(state: MissionStateManager): Promise<void> {
  // Generous timeout: local models may cold-load on the first request.
  const client = new LmStudioClient({ maxTokens: 300, timeoutMs: 120000 });
  console.log('');
  console.log('═'.repeat(78));
  console.log('  AI OPERATOR — live guidance via LM Studio');
  console.log('═'.repeat(78));
  const model = await client.resolveModel();
  if (!model) {
    console.log('  LM Studio not reachable at http://127.0.0.1:1234 — showing rule-based advice instead.');
  } else {
    console.log(`  Model: ${model}   (warming up…)`);
    await client.chat([{ role: 'user', content: 'Reply with the single word: ready.' }]); // load into memory
  }
  console.log('─'.repeat(78));

  // One representative mission per interesting category.
  const wanted = ['Assassinate', 'Delivery', 'PassengerVIP'];
  const picks: Mission[] = [];
  for (const cat of wanted) {
    const m = state.allMissions().find((x) => x.category === cat);
    if (m) picks.push(m);
  }

  for (const m of picks) {
    const os = fakeState(m, m.origin ?? { system: 'unknown' }, m.acceptedAt);
    const q = questionFor(m);
    console.log(`\n  ▶ ${describeMission(m)}`);
    console.log(`    Commander: "${q}"`);
    const ai = model ? await client.chat(buildChat(m, os, q)) : null;
    if (ai) console.log(indent(ai, '    🤖 '));
    else console.log(indent(ruleBasedAdvice(m, m.acceptedAt), '    (rule fallback) '));
  }

  // Proactive stall showcase: heartbeat detected the commander idling in the
  // assassination target system — ask the operator for a live proactive nudge.
  const kill = state.allMissions().find((m) => m.category === 'Assassinate');
  if (kill && model) {
    const os = fakeState(kill, { system: kill.origin?.system ?? 'the target system' }, kill.acceptedAt);
    console.log('\n  ▶ HEARTBEAT + AI  (commander stalled in the target system)');
    const msgs = [
      systemPromptFor(kill.category),
      {
        role: 'user' as const,
        content:
          `${missionContext(kill, os)}\n\n` +
          'The commander has been in the target system for 10 minutes without engaging the target. ' +
          'Give a short, proactive spoken nudge (2 sentences) to help them make progress now.',
      },
    ];
    const ai = await client.chat(msgs);
    console.log(indent(ai ?? '(no response)', '    🤖 '));
  }
  console.log('\n' + '═'.repeat(78));
}

function indent(text: string, prefix: string): string {
  const pad = ' '.repeat(prefix.length);
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? prefix : pad) + line)
    .join('\n');
}

main();
