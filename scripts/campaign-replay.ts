/**
 * What campaign would the spine have told from the REAL journals?
 *
 * The unit tests prove the fold's rules; they cannot tell you whether those
 * rules elect a pursuer a commander would recognise, or whether the clocks
 * move at a pace worth watching. So this replays the commander's actual
 * journal history through the app's own MissionStateManager (for standings
 * and controlling factions, exactly as the store provides them) and the real
 * CampaignTracker, and prints the timeline: elections, usurps, closures,
 * clock movement, payoffs, and every vow the missions would have derived.
 *
 *   npx tsx scripts/campaign-replay.ts [--journals <dir>]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MissionStateManager } from '../src/engine/state.ts';
import { CampaignTracker } from '../src/engine/campaign.ts';
import { spineLines } from '../src/engine/spine.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const JOURNAL_DIR = arg(
  'journals',
  join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
);

const files = readdirSync(JOURNAL_DIR)
  .filter((f) => /^Journal\..*\.log$/.test(f))
  .sort();
console.log(`Reading ${files.length} journal files from ${JOURNAL_DIR}\n`);

const sm = new MissionStateManager();
const campaign = new CampaignTracker();

interface Threadprint {
  faction: string | null;
  clock: number;
}
const state = {
  pursuer: { faction: null, clock: 0 } as Threadprint,
  patron: { faction: null, clock: 0 } as Threadprint,
  vow: null as string | null,
  payoffs: 0,
};

const day = (ts: string): string => ts.slice(0, 10);
let events = 0;
let folds = 0;

for (const f of files) {
  let lines: string[];
  try {
    lines = readFileSync(join(JOURNAL_DIR, f), 'utf8').split('\n');
  } catch {
    continue;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: JournalEvent;
    try {
      ev = JSON.parse(line) as JournalEvent;
    } catch {
      continue;
    }
    events += 1;
    sm.apply(ev);
    const sys = sm.getState().system;
    const changed = campaign.observe(
      ev,
      { factions: sys?.factions, controlling: sys?.controllingFaction },
      true,
    );
    if (
      ev.event === 'MissionAccepted' ||
      ev.event === 'MissionCompleted' ||
      ev.event === 'MissionFailed' ||
      ev.event === 'MissionAbandoned' ||
      ev.event === 'Missions'
    ) {
      campaign.updateVow(sm.activeMissions(), null);
    }
    if (!changed) continue;
    folds += 1;

    const v = campaign.view();
    const stamp = `${day(ev.timestamp ?? '')}  ${(ev.event ?? '').padEnd(18)}`;
    for (const role of ['pursuer', 'patron'] as const) {
      const now = v[role];
      const was = state[role];
      if ((now?.faction ?? null) !== was.faction) {
        console.log(
          now
            ? `${stamp} ${role.toUpperCase()} ELECTED: ${now.faction}`
            : `${stamp} ${role.toUpperCase()} CLOSED: ${was.faction}`,
        );
        state[role] = { faction: now?.faction ?? null, clock: now?.clock ?? 0 };
      } else if (now && now.clock !== was.clock) {
        console.log(`${stamp} ${role} clock ${was.clock} -> ${now.clock}  (${now.faction})`);
        state[role].clock = now.clock;
      }
    }
    if ((v.vow ?? null) !== state.vow) {
      console.log(`${stamp} VOW: ${v.vow ?? '(none)'}`);
      state.vow = v.vow ?? null;
    }
    const pending = Object.keys(v.payoffs).length;
    if (pending > state.payoffs) {
      const p = v.payoffs.comms ?? v.payoffs.news ?? v.payoffs.operator;
      console.log(`${stamp} *** PAYOFF QUEUED: ${p?.faction} — ${p?.cause}`);
    }
    state.payoffs = pending;
  }
}

console.log(`\n${events} events, ${folds} campaign changes.\n`);
console.log('FINAL CAMPAIGN:');
const v = campaign.view();
console.log(`  pursuer: ${v.pursuer ? `${v.pursuer.faction} (clock ${v.pursuer.clock}/6)` : '(none)'}`);
console.log(`  patron:  ${v.patron ? `${v.patron.faction} (clock ${v.patron.clock}/6)` : '(none)'}`);
console.log(`  vow:     ${v.vow ?? '(none)'}`);
console.log('\nWHAT EACH VOICE WOULD SEE:');
for (const voice of ['operator', 'news', 'comms'] as const) {
  console.log(`\n  [${voice}]`);
  for (const l of spineLines(v, voice)) console.log(`    ${l}`);
}
