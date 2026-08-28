/**
 * Print the EXACT prompt the comms writer is handed — no model, no scoring.
 *
 * When live output drifts, the argument is always about what the model was
 * told, and nobody can settle it from the HUD. This assembles the real thing
 * from the commander's own journals — same dossier, same rotation, same
 * situation pool, same spine — and prints it verbatim, then counts what kind
 * of material the briefing is actually made of.
 *
 * That last part is the point. A briefing whose lines are mostly factions and
 * stations will produce scenes about factions and stations no matter what the
 * standing instructions say: the model writes about what is vivid in front of
 * it. The census at the end is how you see that at a glance.
 *
 *   npx tsx scripts/comms-prompt-dump.ts [--system "HIP 71120"] [--scenes 3]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MissionStateManager } from '../src/engine/state.ts';
import { buildDossier } from '../src/engine/chatter/dossier.ts';
import { buildSceneChat, SITUATIONS, type SceneRequest } from '../src/engine/chatter/llm.ts';
import { textureBrief } from '../src/engine/chatter/brief.ts';
import { spineLines } from '../src/engine/spine.ts';
import type { CampaignView } from '../src/engine/campaign.ts';
import type { SystemIntel } from '../src/engine/types.ts';
import type { ChannelId, DramaticFunction } from '../src/engine/chatter/types.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const SYSTEM = arg('system', '');
const N = Number(arg('scenes', '3'));
const JOURNAL_DIR = arg(
  'journals',
  join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
);

function harvest(): { system: string; intel: SystemIntel; station: string | null } {
  const files = readdirSync(JOURNAL_DIR)
    .filter((f) => /^Journal\..*\.log$/.test(f))
    .sort();
  const sm = new MissionStateManager();
  let best: { system: string; intel: SystemIntel; station: string | null; score: number } | null =
    null;
  const keep = () => {
    const st = sm.getState();
    const sys = st.system;
    if (!sys || !st.location.system || st.location.system === 'unknown') return;
    if (SYSTEM && st.location.system.toLowerCase() !== SYSTEM.toLowerCase()) return;
    const score = (sys.factions?.length ?? 0) * 3 + (sys.signals?.length ?? 0) * 2;
    if (!best || score >= best.score) {
      best = {
        system: st.location.system,
        intel: JSON.parse(JSON.stringify(sys)) as SystemIntel,
        station: st.location.station ?? null,
        score,
      };
    }
  };
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(JOURNAL_DIR, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        sm.apply(JSON.parse(line));
      } catch {
        /* a torn last line while the game is running */
      }
      keep();
    }
  }
  if (!best) throw new Error('no system found in the journals');
  return best;
}

function campaignView(sys: SystemIntel): CampaignView {
  const patron =
    (sys.factions ?? [])
      .filter((f) => f.name !== sys.controllingFaction)
      .sort((a, b) => b.influence - a.influence)[0]?.name ?? 'Local Co-op';
  const now = new Date().toISOString();
  return {
    pursuer: null,
    patron: {
      role: 'patron',
      faction: patron,
      clock: 2,
      clockMovedAt: now,
      cooldownUntil: '',
      beats: [{ at: now, text: 'completed a contract for them' }],
      onAir: [{ at: now, text: `Word is ${patron} pays their haulers on time` }],
      electedAt: now,
    },
    vow: null,
    payoffs: {},
  };
}

const REFS: Record<string, [string, string]> = {
  STATION: ['control', 'ship'],
  LOCAL: ['hauler', 'hauler2'],
  CREW: ['crew:ops', 'crew:engineering'],
};
const NAMES: Record<string, string> = {
  control: 'Traffic Control',
  ship: 'Inbound Traffic',
  hauler: 'Yusuf Fiore',
  hauler2: 'Dmitri Sarkis',
  'crew:ops': 'Ops',
  'crew:engineering': 'Engineering',
};
const FUNCS: DramaticFunction[] = ['establish', 'complicate', 'texture'];

/**
 * What KIND of line is this briefing row?
 *
 * Crude on purpose — it keys off the row's own label, which is authored in
 * dossier.ts, so it cannot drift away from the thing it is measuring.
 */
function classify(line: string): 'politics' | 'places' | 'life' | 'commander' | 'other' {
  const head = line.split(':')[0].toLowerCase();
  if (/runs this system|also here|going on locally|mood on the ground|coming and going/.test(head))
    return 'politics';
  if (/^(what .*means|means)/.test(head)) return 'politics';
  if (/stations|fleet carriers|signals|nearest port/.test(head)) return 'places';
  if (/out the window|^people$|everyday|life/.test(head)) return 'life';
  if (/the commander/.test(head)) return 'commander';
  return 'other';
}

const snap = harvest();
const view = campaignView(snap.intel);
console.log(
  `SYSTEM ${snap.system} · docked at ${snap.station ?? '(none)'} · patron ${view.patron?.faction}\n`,
);

const channels = Object.keys(REFS) as ChannelId[];
const census = { politics: 0, places: 0, life: 0, commander: 0, other: 0 };
let rows = 0;

for (let i = 0; i < N; i++) {
  const channel = channels[i % channels.length];
  const speakers = REFS[channel];
  const dossier = buildDossier({
    system: snap.system,
    intel: snap.intel,
    docked: true,
    stationName: snap.station,
    rotate: i,
    recentAir: [],
    extra: spineLines(view, 'comms', i),
  });
  const req: SceneRequest = {
    channel,
    func: FUNCS[i % FUNCS.length],
    act: 'BUILDING',
    brief: textureBrief(`dump:${i}`),
    speakers: [...speakers],
    speakerNames: Object.fromEntries(speakers.map((r) => [r, NAMES[r] ?? r])),
    situation: SITUATIONS[channel][(i * 7) % SITUATIONS[channel].length],
    dossier,
    rotate: i,
    lines: i % 3 === 2 ? 3 : 2,
  };
  const chat = buildSceneChat(req, []);

  console.log('='.repeat(78));
  console.log(`SCENE ${i} · channel ${channel} · rotate ${i} · function ${req.func}`);
  console.log('='.repeat(78));
  for (const m of chat) {
    console.log(`\n----- ${m.role.toUpperCase()} -----`);
    console.log(m.content);
  }
  console.log();

  for (const line of dossier.split('\n')) {
    if (!line.trim()) continue;
    rows++;
    census[classify(line)]++;
  }
}

console.log('='.repeat(78));
console.log('WHAT THE BRIEFING IS MADE OF — rows across the scenes above');
console.log('='.repeat(78));
const pct = (n: number) => `${Math.round((n / rows) * 100)}%`.padStart(4);
for (const [k, v] of Object.entries(census).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(10)} ${String(v).padStart(3)} rows  ${pct(v)}  ${'█'.repeat(v)}`);
}
console.log(`  ${'total'.padEnd(10)} ${String(rows).padStart(3)} rows`);
