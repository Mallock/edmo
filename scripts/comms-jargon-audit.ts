/**
 * Does this channel sound like people, or like a systems manual?
 *
 * The live complaint that made this script: the air had gone technical. Not
 * wrong, not off-lore — just relentlessly about equipment. Conduits, cycles,
 * couplings, calibration, flow rates. A refinery system of a quarter of a
 * million people, and two haulers on the open channel were discussing
 * harmonics.
 *
 * The life audit answers "is anybody living a life". This answers the opposite
 * question, and it has to be its own script because the two failures are not
 * each other's inverse: a scene can mention a meal AND spend both its lines on
 * a coupling. What matters here is the SHARE of scenes carrying hardware
 * vocabulary at all, and WHICH WORDS are doing it — because the fix is a
 * prompt change, and you cannot write one without knowing whether the model is
 * reaching for "conduit" or for "flow regulator".
 *
 * Every scene is printed in full. The whole point is reading them.
 *
 * WHAT IT FOUND, so the numbers do not have to be rediscovered. Against the
 * reference corpus — EDCoPilot's hand-written static chatter, 872 lines, which
 * averages 6.8 words a line and carries hardware vocabulary on 3% of them:
 *
 *   before the house-style blocks   18.7 w/line   26% of lines
 *   after them (32 scenes)          12.2 w/line    9% of scenes, 3% of lines
 *
 * The cause turned out to be length, not vocabulary. A small model told to
 * write a long radio line fills it, and its filler for science fiction is
 * machinery — so the words per line were buying the jargon, and capping them
 * bought it back.
 *
 *   npx tsx scripts/comms-jargon-audit.ts --port 51999 --key probe [--scenes 16]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MissionStateManager } from '../src/engine/state.ts';
import { buildDossier } from '../src/engine/chatter/dossier.ts';
import {
  buildSceneChat,
  acceptSceneReply,
  SITUATIONS,
  type SceneRequest,
} from '../src/engine/chatter/llm.ts';
import { textureBrief } from '../src/engine/chatter/brief.ts';
import { sceneTranscript } from '../src/engine/chatter/scenes.ts';
import { spineLines } from '../src/engine/spine.ts';
import type { CampaignView } from '../src/engine/campaign.ts';
import type { SystemIntel } from '../src/engine/types.ts';
import type { ChannelId, DramaticFunction } from '../src/engine/chatter/types.ts';
import type { ChatMessage } from '../src/engine/lmstudio.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const PORT = arg('port', '51999');
const KEY = arg('key', 'probe');
const N = Number(arg('scenes', '16'));
const SYSTEM = arg('system', '');
const LABEL = arg('label', 'run');
const TEMP = Number(arg('temp', '0.95'));
const VARIANT = arg('variant', 'baseline');
const JOURNAL_DIR = arg(
  'journals',
  join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
);

/**
 * The hardware register — words nobody reaches for on a working radio.
 *
 * Deliberately NOT a list of everything mechanical. "Fuel", "pad", "cargo",
 * "thrusters" are the furniture of the setting and belong on the air. What is
 * counted here is the layer above that: the maintenance-manual noun, the
 * process word, the diagnostic verb. That is the register the complaint was
 * about, and it is the one a prompt change has to move.
 */
const JARGON_RE =
  /\b(conduits?|couplings?|capacitors?|manifolds?|relays?|regulators?|injectors?|actuators?|induction|inductors?|harmonics?|resonan\w*|oscillat\w*|calibrat\w*|recalibrat\w*|realign\w*|alignment|diagnostics?|telemetry|subroutines?|subsystems?|modulat\w*|flux|plasma|ionis\w*|ioniz\w*|polarity|impedance|variance|differential|throughput|feedback loop|power cycle|cycles?|cycling|sequencers?|sequencing|arrays?|nodes?|coolant|thermal|heat sink|scrubbers?|filtration|hydraulics?|pneumatic|servos?|gyros?|baffles?|damp\w*ners?|inertial|reactors?|core temperature|output curve|load.balanc\w*|tolerances?|parameters?|readouts?|waveforms?|bandwidth|spectral)\b/gi;

/** The other half of the same failure: talk with no people in it. */
const HUMAN_RE =
  /\b(he|she|they|him|her|them|somebody|someone|anybody|anyone|nobody|mate|friend|boss|kid|lad|lass|bloke|folks|people|crew|family|wife|husband|son|daughter|mother|father|brother|sister)\b/i;

interface Pilot {
  name: string;
  rank?: string;
  ship?: string;
  faction?: string | null;
  legal?: string | null;
}
const seenPilots: Pilot[] = [];

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
      let ev: Record<string, unknown> | null = null;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
        sm.apply(ev);
      } catch {
        /* torn last line, game is running */
      }
      if (ev && ev.event === 'ShipTargeted' && typeof ev.PilotName_Localised === 'string') {
        const name = ev.PilotName_Localised;
        if (!seenPilots.some((p) => p.name === name)) {
          seenPilots.unshift({
            name,
            rank: ev.PilotRank as string,
            ship: (ev.Ship_Localised as string) ?? (ev.Ship as string),
            faction: (ev.Faction as string) ?? null,
            legal: (ev.LegalStatus as string) ?? null,
          });
        }
      }
      keep();
    }
  }
  if (!best) throw new Error('no system in the journals');
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
  CONCOURSE: ['pa', 'traveller'],
};
const NAMES: Record<string, string> = {
  control: 'Traffic Control',
  ship: 'Inbound Traffic',
  hauler: 'Yusuf Fiore',
  hauler2: 'Dmitri Sarkis',
  'crew:ops': 'Ops',
  'crew:engineering': 'Engineering',
  pa: 'Concourse PA',
  traveller: 'Station Traveller',
};
const FUNCS: DramaticFunction[] = ['establish', 'complicate', 'texture', 'reverse'];

// --------------------------------------------------------------- the variants
//
// A variant is the REAL chat the app builds plus exactly one delta, so a run
// measures the product and one change and nothing else.
//
// The three house-style blocks now SHIP, at the tail of the user message
// in buildSceneChat. What is left to test here is the contradiction they were
// measured alongside: the system prompt still tells the model that "lines may
// run to a sentence or two", which is the opposite of what the tail now asks
// for. A prompt that argues with itself is worth a run either way — and the
// prior failure this guards is real, so removing it has to be measured rather
// than assumed.
const LICENCE =
  'Radio length, not prose length: lines may run to a sentence or two when the moment ' +
  'carries it — a complaint, an explanation, a story half-told. Never padding. ';

const VARIANTS: Record<string, (chat: ChatMessage[]) => ChatMessage[]> = {
  /** What the app now does, unmodified. */
  baseline: (c) => c,
  /** Same, minus the sentence that licenses the long lines we just banned. */
  nolicence: (c) => {
    if (!c[0].content.includes(LICENCE)) {
      // A silent no-match would report the baseline twice and look like a
      // null result, which is the one outcome a probe must never fake.
      throw new Error('nolicence: the licence sentence is no longer in the system prompt');
    }
    return c.map((m, i) => (i === 0 ? { ...m, content: m.content.replace(LICENCE, '') } : m));
  },
};

function applyVariant(chat: ChatMessage[]): ChatMessage[] {
  const fn = VARIANTS[VARIANT];
  if (!fn) throw new Error(`unknown variant ${VARIANT} — have ${Object.keys(VARIANTS).join(', ')}`);
  return fn(chat);
}

/** Words per line, the density the reference corpus keeps low and we do not. */
const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

async function main() {
  const snap = harvest();
  const view = campaignView(snap.intel);
  console.log(`[${LABEL}] ${snap.system} · ${N} scenes · temp ${TEMP}\n`);

  const history: ChatMessage[] = [];
  const texts: string[] = [];
  const hits = new Map<string, number>();
  let jargonScenes = 0;
  let humanScenes = 0;
  const lineWords: number[] = [];
  const per: Record<string, { n: number; j: number }> = {};

  for (let i = 0; i < N; i++) {
    const channel = (Object.keys(REFS) as ChannelId[])[i % 4];
    const speakers = REFS[channel];
    const dossier = buildDossier({
      system: snap.system,
      intel: snap.intel,
      docked: true,
      stationName: snap.station,
      rotate: i,
      recentAir: texts.slice(-6),
      pilots: seenPilots.slice(0, 12),
      extra: spineLines(view, 'comms', i),
    });
    const req: SceneRequest = {
      channel,
      func: FUNCS[i % FUNCS.length],
      act: 'BUILDING',
      brief: textureBrief(`jargon:${i}`),
      speakers: [...speakers],
      speakerNames: Object.fromEntries(speakers.map((r) => [r, NAMES[r] ?? r])),
      situation: SITUATIONS[channel][(i * 7) % SITUATIONS[channel].length],
      dossier,
      rotate: i,
      lines: i % 3 === 2 ? 3 : 2,
    };

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        messages: applyVariant(buildSceneChat(req, history)),
        temperature: TEMP,
        max_tokens: 700,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content ?? '';
    const accepted = acceptSceneReply(raw, req, `jargon:${i}`, 60_000, undefined, texts.slice(-8));
    const lines = accepted.ok ? accepted.scene.turns.map((t) => t.text) : [];
    if (!lines.length) {
      console.log(
        `${String(i).padStart(2)} ${channel.padEnd(10)} DROPPED (${accepted.ok ? 'empty' : accepted.why})`,
      );
      continue;
    }
    const text = lines.join(' ');
    texts.push(text);
    if (accepted.ok) history.push({ role: 'assistant', content: sceneTranscript(accepted.scene) });

    for (const l of lines) lineWords.push(words(l));
    const found = text.match(JARGON_RE) ?? [];
    for (const w of found) hits.set(w.toLowerCase(), (hits.get(w.toLowerCase()) ?? 0) + 1);
    const isJargon = found.length > 0;
    if (isJargon) jargonScenes++;
    if (HUMAN_RE.test(text)) humanScenes++;
    per[channel] ??= { n: 0, j: 0 };
    per[channel].n++;
    if (isJargon) per[channel].j++;

    const tag = isJargon
      ? `JARGON[${[...new Set(found.map((f) => f.toLowerCase()))].join(',')}]`
      : 'clean';
    console.log(`${String(i).padStart(2)} ${channel.padEnd(10)} ${tag}  — ${req.situation ?? ''}`);
    for (const l of lines) console.log(`     · ${l}`);
    console.log();
  }

  const n = texts.length || 1;
  const pc = (x: number) => `${Math.round((x / n) * 100)}%`.padStart(4);
  console.log('='.repeat(72));
  console.log(`[${LABEL}] scenes kept ${texts.length}/${N}`);
  console.log(
    `  JARGON  (hardware/process vocabulary)  ${String(jargonScenes).padStart(2)}  ${pc(jargonScenes)}`,
  );
  console.log(
    `  human   (a person referred to at all)  ${String(humanScenes).padStart(2)}  ${pc(humanScenes)}`,
  );
  console.log('\n  WORDS DOING IT');
  for (const [w, c] of [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`    ${String(c).padStart(3)}×  ${w}`);
  }
  console.log('\n  per channel        scenes  jargon');
  for (const [ch, v] of Object.entries(per)) {
    console.log(
      `  ${ch.padEnd(18)}${String(v.n).padStart(6)}${`${Math.round((v.j / v.n) * 100)}%`.padStart(8)}`,
    );
  }
}

void main();
