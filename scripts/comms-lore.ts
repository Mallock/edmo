/**
 * What does the comms writer sound like on REAL systems?
 *
 * The unit tests prove a scene parses. They cannot tell you whether it is worth
 * overhearing, and they cannot tell you whether the dossier is doing its job —
 * which is the whole claim of the LLM tier now that the fact fence is gone.
 * Grounding is supposed to come from handing the model enough real material that
 * writing about somewhere else would be more effort than writing about here. The
 * only way to check that is to read the output.
 *
 * So this replays the commander's actual journals through the app's own
 * MissionStateManager, keeps the richest intel snapshot it saw for each system,
 * and runs the real prompt against the real engine for a handful of them. No
 * fixtures and no invented systems: if the writer only sounds good on tidy test
 * data, that is exactly what this is meant to expose.
 *
 *   npx tsx scripts/comms-lore.ts --port 51999 --key probe [--systems 4] [--scenes 3]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MissionStateManager } from '../src/engine/state.ts';
import { buildDossier } from '../src/engine/chatter/dossier.ts';
import { buildSceneChat, parseSceneReply, SITUATIONS, type SceneRequest } from '../src/engine/chatter/llm.ts';
import { textureBrief } from '../src/engine/chatter/brief.ts';
import { acceptSceneReply } from '../src/engine/chatter/llm.ts';
import type { SystemIntel } from '../src/engine/types.ts';
import type { ChannelId, DramaticFunction } from '../src/engine/chatter/types.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const PORT = arg('port', '51999');
const KEY = arg('key', 'probe');
const N_SYSTEMS = Number(arg('systems', '4'));
const N_SCENES = Number(arg('scenes', '3'));
const JOURNAL_DIR =
  arg('journals', join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous'));

// --------------------------------------------------------------- the journals

interface Snapshot {
  system: string;
  intel: SystemIntel;
  station: string | null;
  docked: boolean;
  score: number;
}

/** How much a model could actually DO with this system. */
function richness(s: SystemIntel): number {
  return (
    (s.factions?.length ?? 0) * 3 +
    (s.signals?.length ?? 0) * 2 +
    (s.factionStates?.length ?? 0) * 2 +
    (s.controllingFaction ? 4 : 0) +
    (s.economy ? 2 : 0) +
    (s.government ? 2 : 0) +
    (s.security ? 1 : 0)
  );
}

function harvest(): Snapshot[] {
  const files = readdirSync(JOURNAL_DIR)
    .filter((f) => /^Journal\..*\.log$/.test(f))
    .sort();
  console.log(`Reading ${files.length} journal files from ${JOURNAL_DIR}\n`);

  const best = new Map<string, Snapshot>();
  const sm = new MissionStateManager();

  const keep = (): void => {
    const st = sm.getState();
    const sys = st.system;
    const name = st.location.system;
    if (!sys || !name || name === 'unknown') return;
    const score = richness(sys);
    const prev = best.get(name);
    if (prev && prev.score >= score) return;
    best.set(name, {
      system: name,
      // Deep copy: the manager keeps mutating this object as the replay runs.
      intel: JSON.parse(JSON.stringify(sys)) as SystemIntel,
      station: st.location.station ?? null,
      docked: st.docked,
      score,
    });
  };

  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(JOURNAL_DIR, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        sm.apply(JSON.parse(line));
      } catch {
        continue;
      }
    }
    keep();
  }
  keep();

  return [...best.values()].sort((a, b) => b.score - a.score);
}

// ----------------------------------------------------------------- the engine

const MODEL = arg(
  'model',
  join(
    homedir(),
    'AppData', 'Roaming', 'ai.laiton.edmissionoperator', 'engine', 'models', 'gemma-4-e4b.gguf',
  ),
);
/** Off for text-only models, whose reasoning kwarg the template does not know. */
const NO_THINKING = arg('thinking', 'off') === 'off';

async function write(req: SceneRequest): Promise<{ ms: number; raw: string; err?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: buildSceneChat(req),
        max_tokens: 700,
        temperature: 0.8,
        stream: false,
        // What the app sends for gemma on the comms path. Omitted for models
        // whose chat template has no such switch — sending it can 4xx.
        ...(NO_THINKING ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      }),
    });
    if (!res.ok) return { ms: Date.now() - t0, raw: '', err: `HTTP ${res.status}` };
    const j = await res.json();
    return { ms: Date.now() - t0, raw: j.choices?.[0]?.message?.content ?? '' };
  } catch (e) {
    return { ms: Date.now() - t0, raw: '', err: String(e).slice(0, 120) };
  }
}

// The roster the store uses, so the scenes read the way they will in the app.
const REFS: Record<string, [string, string]> = {
  STATION: ['control', 'ship'],
  LOCAL: ['hauler', 'hauler2'],
  CREW: ['crew:ops', 'crew:engineering'],
  CARRIER: ['carrier', 'hauler'],
  CONCOURSE: ['pa', 'traveller'],
};
const NAMES: Record<string, string> = {
  control: 'Traffic Control', ship: 'Inbound Traffic',
  hauler: 'Yusuf Fiore', hauler2: 'Dmitri Sarkis',
  'crew:ops': 'Ops', 'crew:engineering': 'Engineering',
  carrier: 'Carrier Operations', pa: 'Concourse PA', traveller: 'Station Traveller',
};

const FUNCS: DramaticFunction[] = ['establish', 'complicate', 'texture', 'reverse'];

async function main() {
  const systems = harvest();
  if (!systems.length) {
    console.log('No systems with intel found in the journals.');
    return;
  }
  console.log(`Found ${systems.length} systems with intel. Richest ${N_SYSTEMS}:\n`);

  let ok = 0;
  let total = 0;
  const times: number[] = [];

  for (const snap of systems.slice(0, N_SYSTEMS)) {
    const dossier = buildDossier({
      system: snap.system,
      intel: snap.intel,
      docked: snap.docked,
      stationName: snap.station,
      supercruise: !snap.docked,
      portSeparationLs: snap.docked ? null : 1200,
    });

    console.log('\n' + '█'.repeat(76));
    console.log(`  ${snap.system}   (richness ${snap.score})`);
    console.log('█'.repeat(76));
    console.log('\n--- WHAT THE MODEL IS GIVEN ---');
    console.log(dossier);
    console.log('\n--- WHAT IT WROTE ---');

    const channels = Object.keys(REFS) as ChannelId[];
    for (let i = 0; i < N_SCENES; i++) {
      const channel = channels[i % channels.length];
      const pool = SITUATIONS[channel];
      const situation = pool[(i * 3 + snap.score) % pool.length];
      const speakers = REFS[channel];
      const func = FUNCS[i % FUNCS.length];

      const req: SceneRequest = {
        channel,
        func,
        act: 'BUILDING',
        brief: textureBrief(`t:${snap.system}:${i}`),
        speakers: [...speakers],
        speakerNames: Object.fromEntries(speakers.map((r) => [r, NAMES[r] ?? r])),
        situation,
        dossier,
      };

      total++;
      const { ms, raw, err } = await write(req);
      times.push(ms);
      if (err) {
        console.log(`\n  [${channel}/${func}] ${situation}\n    !! ${err}`);
        continue;
      }
      const out = acceptSceneReply(raw, req, `x:${i}`, 60_000);
      console.log(`\n  [${channel}/${func}] ${situation}   ${ms}ms`);
      if (!out.ok) {
        console.log(`    DROPPED (${out.why})  raw: ${JSON.stringify(raw).slice(0, 120)}`);
        continue;
      }
      ok++;
      for (const t of out.scene.turns) {
        console.log(`    ${(NAMES[t.speakerRef] ?? t.speakerRef).padEnd(18)} ${t.text}`);
      }
      // Which dossier nouns actually surfaced — the grounding check.
      const hits = dossier
        .split('\n')
        .flatMap((l) => l.replace(/^[^:]*:\s*/, '').split(/ · |, /))
        .map((x) => x.trim())
        .filter((x) => x.length > 4 && !/^\d/.test(x))
        .filter((x) => parseSceneReply(raw, req.speakers).some((t) => t.text.includes(x)));
      if (hits.length) console.log(`    ^ used from the dossier: ${[...new Set(hits)].join(', ')}`);
    }
  }

  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  console.log('\n' + '='.repeat(76));
  console.log(`  ${ok}/${total} accepted · avg ${avg}ms`);
  console.log('='.repeat(76));
}

void main();
