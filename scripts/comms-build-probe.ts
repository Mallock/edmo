/**
 * Does a construction site on the books still flood the air with tonnage?
 *
 * The lore harness never carried a construction brief, which is exactly how
 * the "2,483-ton" loop shipped: scenes were only ever tested against systems
 * with no build running. This probe is that missing case — a dossier whose
 * ONE extra is the construction summary (so the drop-one rotation cannot
 * remove it: worst case, every scene sees it), a rolling history that each
 * accepted scene feeds (echo conditions), and a tally of every figure that
 * reaches the air. The bar: no figure appears in more than one scene, and no
 * tonnage is quoted at all unless the model invents a fresh one.
 *
 *   npx tsx scripts/comms-build-probe.ts --port 51999 --key probe [--scenes 6]
 */
import { buildDossier } from '../src/engine/chatter/dossier.ts';
import { constructionBrief } from '../src/engine/chatter/briefs.ts';
import { buildSceneChat, acceptSceneReply, SITUATIONS, type SceneRequest } from '../src/engine/chatter/llm.ts';
import { textureBrief } from '../src/engine/chatter/brief.ts';
import { sceneTranscript } from '../src/engine/chatter/scenes.ts';
import type { ChannelId, DramaticFunction } from '../src/engine/chatter/types.ts';
import type { ChatMessage } from '../src/engine/lmstudio.ts';
import type { DepotState } from '../src/engine/architect.ts';

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const PORT = arg('port', '51999');
const KEY = arg('key', 'probe');
const N = Number(arg('scenes', '6'));
/** --thinking off (default) sends the suppress kwarg; 'plain' omits it —
 *  Llama-family templates do not know the switch and can 400 on it. */
const THINK = arg('thinking', 'off');

// The Blanco Vision build, as the live session had it.
const depot: DepotState = {
  marketId: 1,
  station: 'Blanco Vision',
  system: 'HIP 71120',
  progress: 0.282,
  complete: false,
  failed: false,
  at: new Date().toISOString(),
  resources: [
    { key: 'alu', name: 'Aluminium', required: 3000, provided: 517, remaining: 2483, payment: 0 },
    { key: 'steel', name: 'Steel', required: 3121, provided: 1090, remaining: 2031, payment: 0 },
    { key: 'stab', name: 'Surface Stabilisers', required: 1300, provided: 69, remaining: 1231, payment: 0 },
  ],
};

const CHANNELS: Array<[ChannelId, string[], Record<string, string>]> = [
  ['STATION', ['control', 'ship'], { control: 'Traffic Control', ship: 'Inbound Traffic' }],
  ['LOCAL', ['hauler', 'hauler2'], { hauler: 'Yusuf Fiore', hauler2: 'Dmitri Sarkis' }],
  ['CREW', ['crew:ops', 'crew:engineering'], { 'crew:ops': 'Ops', 'crew:engineering': 'Engineering' }],
];
const FUNCS: DramaticFunction[] = ['establish', 'complicate', 'texture'];

async function main() {
  const history: ChatMessage[] = [];
  const figures = new Map<string, number>(); // figure token -> scenes it appeared in
  let tonnage = 0;

  for (let i = 0; i < N; i++) {
    const [channel, speakers, names] = CHANNELS[i % CHANNELS.length];
    const build = constructionBrief(depot, i)!;
    const dossier = buildDossier({
      system: 'HIP 71120',
      docked: true,
      stationName: 'Blanco Vision',
      intel: {
        security: 'Low Security',
        economy: 'Colony',
        controllingFaction: 'HIP 71462 Council',
        factions: [
          { name: 'HIP 71462 Council', influence: 0.306 },
          { name: 'Explorer on Tour', influence: 0.427, state: 'Expansion' },
        ],
        signals: [{ name: 'Niinimäki', isStation: true }],
      },
      extra: [build.summary],
      rotate: i,
    });
    const req: SceneRequest = {
      channel,
      func: FUNCS[i % FUNCS.length],
      act: 'BUILDING',
      brief: textureBrief(`probe:${i}`),
      speakers: [...speakers],
      speakerNames: names,
      situation: SITUATIONS[channel][i % SITUATIONS[channel].length],
      dossier,
      rotate: i,
    };
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'gemma-4-e4b',
        messages: buildSceneChat(req, history),
        max_tokens: 700,
        temperature: 0.8,
        stream: false,
        ...(THINK === 'plain' ? {} : { chat_template_kwargs: { enable_thinking: false } }),
      }),
    });
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = j.choices?.[0]?.message?.content ?? '';
    const out = acceptSceneReply(raw, req, `p:${i}`, 60_000);
    console.log(`\n[${channel}/${req.func}] ${req.situation}`);
    if (!out.ok) {
      console.log(`  DROPPED (${out.why})`);
      continue;
    }
    for (const t of out.scene.turns) console.log(`  ${(names[t.speakerRef] ?? t.speakerRef).padEnd(16)} ${t.text}`);
    // Feed the rolling history the way the store does — echo conditions.
    history.push({ role: 'assistant', content: sceneTranscript(out.scene) });
    const text = out.scene.turns.map((t) => t.text).join(' ');
    for (const m of new Set(text.match(/\d[\d,.]{2,}/g) ?? [])) figures.set(m, (figures.get(m) ?? 0) + 1);
    if (/\d[\d,.]*[\s-]?(t\b|ton)/i.test(text)) tonnage++;
  }

  console.log('\n---------------------------------------------');
  const repeated = [...figures].filter(([, n]) => n > 1);
  console.log(`scenes with tonnage figures: ${tonnage}/${N}`);
  console.log(
    repeated.length
      ? `FIGURES IN MORE THAN ONE SCENE: ${repeated.map(([f, n]) => `${f} (×${n})`).join(', ')}`
      : 'no figure appeared in more than one scene',
  );
}

void main();
