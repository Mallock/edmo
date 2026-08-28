/**
 * What furniture does the comms writer keep reaching for?
 *
 * The satire-prompt experiment found a stock cupboard — coffee, fluorescent
 * lights, mahogany, Venn diagrams — and a banned-props list emptied it. The
 * open question was whether that transfers to the radio. It cannot transfer
 * directly: those are corporate-prose props, and this channel has never
 * mentioned a Venn diagram in its life. So this finds the RADIO's own.
 *
 * THE METHOD, and why it is reference-relative. Counting our commonest words
 * would just rediscover the setting: pad, dock, cargo, station and hauler are
 * supposed to be frequent, and banning them would be vandalism. What marks a
 * tic is using a word far more than a human writing the same scenes would.
 * EDCoPilot's hand-written chatter is that human baseline — 872 lines of the
 * same fiction, the same channels, the same job — so every word is scored as
 *
 *     our share of scenes  ÷  the corpus's share of exchanges
 *
 * A ratio near 1 is the setting talking. A ratio of 10 is a tic. Words the
 * corpus never uses at all are reported separately, since a division by zero
 * is not evidence of anything on its own.
 *
 *   npx tsx scripts/comms-props-audit.ts --port 51999 --key probe --scenes 40
 *   npx tsx scripts/comms-props-audit.ts --port 51999 --scenes 40 --variant ban
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

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PORT = arg('port', '51999');
const KEY = arg('key', 'probe');
const N = Number(arg('scenes', '40'));
const TEMP = Number(arg('temp', '0.95'));
const VARIANT = arg('variant', 'baseline');
const LABEL = arg('label', VARIANT);
const REF_DIR = arg('reference-dir', 'C:/EDCoPilot/User custom files');
const JOURNAL_DIR = arg(
  'journals',
  join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
);

/**
 * The instruction, retargeted after the mining run contradicted the guess.
 *
 * The first attempt banned a list of nouns carried over from the satire test —
 * approach, vector, sector, lane, buoy. Measured, that set appeared in 7 of 40
 * scenes at 0.28 per scene: nothing to fix, and most of those words are
 * legitimate radio vocabulary anyway.
 *
 * What this channel actually over-uses against the human corpus is VAGUENESS.
 * 'near' in 23% of scenes against the corpus's 3%; 'again' in 30% against 3%.
 * The model reaches for them exactly when it will not commit to a place or a
 * history — "near the main gate", "backed up again". So the instruction is not
 * a ban, because you cannot forbid 'near' without making the prose stilted.
 * It names the two things being dodged and asks for them.
 */
const BAN =
  'SAY WHERE, AND SAY WHAT HAPPENED. You blur two things whenever you are not sure of them: ' +
  'place and history. "Near" something is not a place — name the place, or say what is there. ' +
  '"Again" is not a history — say what happened the last time, or leave it out. If you cannot be ' +
  'specific about one detail, pick a different detail you CAN be specific about.';

function withVariant(chat: ChatMessage[]): ChatMessage[] {
  if (VARIANT === 'baseline') return chat;
  if (VARIANT !== 'ban') throw new Error(`unknown variant ${VARIANT}`);
  const out = chat.slice();
  const i = out.length - 1;
  out[i] = {
    ...out[i],
    content: out[i].content.replace(/\n\nWrite the \d+ lines? now\.$/, (t) => `\n\n${BAN}${t}`),
  };
  return out;
}

// ---------------------------------------------------------------- vocabulary

const STOP = new Set(
  ('a an the and or but if of to in on at by for with from is are was were be been being do does ' +
    'did done have has had will would can could should may might must not no yes it its this that ' +
    'these those there here we you they he she i me him her them us my your our their as so then ' +
    'than just about out up down over under all any some more most very still get got go going one ' +
    'two three now well okay ok right like what who how why when where which am been im dont its ' +
    'youre thats theyre ive ill were wed lets got gonna gotta yeah yep nah nope oh hey look tell ' +
    'know think see said say need want keep let make take give come back down off around').split(/\s+/),
);
const words = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) ?? [])
    .map((w) => w.replace(/['’].*$/, ''))
    .filter((w) => w.length > 2 && !STOP.has(w));

/** Share of units (scenes, or reference exchanges) containing each word. */
function shares(units: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const u of units) for (const w of new Set(words(u))) out.set(w, (out.get(w) ?? 0) + 1);
  for (const [w, c] of out) out.set(w, c / units.length);
  return out;
}

function referenceExchanges(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(REF_DIR).filter((x) => /Chatter\.Custom\.txt$/.test(x))) {
    const text = readFileSync(join(REF_DIR, f), 'utf8');
    for (const block of text.split(/\[example\]/i).slice(1)) {
      const body = block.split(/\[\\example\]/i)[0];
      const lines = [...body.matchAll(/^\[<[^>]+>\]:?\s*"?(.+?)"?\s*$/gm)].map((m) => m[1].trim());
      if (lines.length) out.push(lines.join(' '));
    }
  }
  return out;
}

// ------------------------------------------------------------------- harness

function harvest(): { system: string; intel: SystemIntel; station: string | null } {
  const files = readdirSync(JOURNAL_DIR).filter((f) => /^Journal\..*\.log$/.test(f)).sort();
  const sm = new MissionStateManager();
  let best: { system: string; intel: SystemIntel; station: string | null; score: number } | null = null;
  const keep = () => {
    const st = sm.getState();
    const sys = st.system;
    if (!sys || !st.location.system || st.location.system === 'unknown') return;
    const s = (sys.factions?.length ?? 0) * 3 + (sys.signals?.length ?? 0) * 2;
    if (!best || s >= best.score) {
      best = {
        system: st.location.system,
        intel: JSON.parse(JSON.stringify(sys)) as SystemIntel,
        station: st.location.station ?? null,
        score: s,
      };
    }
  };
  for (const f of files) {
    let text: string;
    try { text = readFileSync(join(JOURNAL_DIR, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { sm.apply(JSON.parse(line)); } catch { /* torn line */ }
      keep();
    }
  }
  if (!best) throw new Error('no system in the journals');
  return best;
}

function campaignView(sys: SystemIntel): CampaignView {
  const patron =
    (sys.factions ?? []).filter((f) => f.name !== sys.controllingFaction)
      .sort((a, b) => b.influence - a.influence)[0]?.name ?? 'Local Co-op';
  const now = new Date().toISOString();
  return {
    pursuer: null,
    patron: {
      role: 'patron', faction: patron, clock: 2, clockMovedAt: now, cooldownUntil: '',
      beats: [{ at: now, text: 'completed a contract for them' }],
      onAir: [{ at: now, text: `Word is ${patron} pays their haulers on time` }],
      electedAt: now,
    },
    vow: null, payoffs: {},
  };
}

const REFS: Record<string, [string, string]> = {
  STATION: ['control', 'ship'],
  LOCAL: ['hauler', 'hauler2'],
  CREW: ['crew:ops', 'crew:engineering'],
  CONCOURSE: ['pa', 'traveller'],
};
const NAMES: Record<string, string> = {
  control: 'Traffic Control', ship: 'Inbound Traffic',
  hauler: 'Yusuf Fiore', hauler2: 'Dmitri Sarkis',
  'crew:ops': 'Ops', 'crew:engineering': 'Engineering',
  pa: 'Concourse PA', traveller: 'Station Traveller',
};
const FUNCS: DramaticFunction[] = ['establish', 'complicate', 'texture', 'reverse'];

async function main(): Promise<void> {
  const snap = harvest();
  const view = campaignView(snap.intel);
  console.log(`[${LABEL}] ${snap.system} · ${N} scenes · variant ${VARIANT}\n`);

  const history: ChatMessage[] = [];
  const scenes: string[] = [];
  const lineWords: number[] = [];

  for (let i = 0; i < N; i++) {
    const channel = (Object.keys(REFS) as ChannelId[])[i % 4];
    const speakers = REFS[channel];
    const dossier = buildDossier({
      system: snap.system, intel: snap.intel, docked: true, stationName: snap.station,
      rotate: i, recentAir: scenes.slice(-6), extra: spineLines(view, 'comms', i),
    });
    const req: SceneRequest = {
      channel, func: FUNCS[i % FUNCS.length], act: 'BUILDING',
      brief: textureBrief(`props:${i}`),
      speakers: [...speakers],
      speakerNames: Object.fromEntries(speakers.map((r) => [r, NAMES[r] ?? r])),
      situation: SITUATIONS[channel][(i * 7) % SITUATIONS[channel].length],
      dossier, rotate: i, lines: i % 3 === 2 ? 3 : 2,
    };
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        messages: withVariant(buildSceneChat(req, history)),
        temperature: TEMP, max_tokens: 700,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content ?? '';
    const accepted = acceptSceneReply(raw, req, `props:${i}`, 60_000, undefined, scenes.slice(-8));
    const lines = accepted.ok ? accepted.scene.turns.map((t) => t.text) : [];
    if (!lines.length) {
      console.log(`${String(i).padStart(2)} ${channel.padEnd(10)} DROPPED`);
      continue;
    }
    for (const l of lines) lineWords.push(l.trim().split(/\s+/).filter(Boolean).length);
    scenes.push(lines.join(' '));
    if (accepted.ok) history.push({ role: 'assistant', content: sceneTranscript(accepted.scene) });
    console.log(`${String(i).padStart(2)} ${channel.padEnd(10)} ${lines[0].slice(0, 84)}`);
  }

  const ours = shares(scenes);
  const ref = shares(referenceExchanges());
  const avg = lineWords.reduce((a, b) => a + b, 0) / (lineWords.length || 1);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`[${LABEL}] ${scenes.length}/${N} scenes kept · ${avg.toFixed(1)} words per line`);

  // A tic: used in at least a fifth of scenes, and far more than a human does.
  const rows = [...ours.entries()]
    .filter(([, s]) => s >= 0.2)
    .map(([w, s]) => ({ w, s, r: ref.get(w) ?? 0, ratio: (s + 0.001) / ((ref.get(w) ?? 0) + 0.001) }))
    .sort((a, b) => b.ratio - a.ratio);

  console.log(`\n  OVER-USED AGAINST THE HUMAN CORPUS (in >=20% of scenes)`);
  console.log(`  ${'word'.padEnd(16)}${'ours'.padStart(7)}${'corpus'.padStart(9)}${'ratio'.padStart(8)}`);
  for (const r of rows.slice(0, 22)) {
    console.log(
      `  ${r.w.padEnd(16)}${`${Math.round(r.s * 100)}%`.padStart(7)}${`${Math.round(r.r * 100)}%`.padStart(9)}${r.ratio.toFixed(1).padStart(8)}`,
    );
  }

  // The banned set, tracked explicitly so the A/B has one number.
  // The measured tic, not the transplanted one. The corporate props list was
  // tested first and found irrelevant here: 7/40 scenes, 0.28 per scene, and
  // most of those words are legitimate radio vocabulary. What this channel
  // actually over-uses against the human corpus is vagueness — 'near' at 23%
  // against 3%, 'again' at 30% against 3%.
  const BANNED_WORDS = ['near', 'again', 'through'];
  const hit = scenes.filter((s) => BANNED_WORDS.some((b) => words(s).includes(b))).length;
  const density =
    scenes.reduce((acc, s) => acc + words(s).filter((w) => BANNED_WORDS.includes(w)).length, 0) /
    (scenes.length || 1);
  console.log(
    `\n  THE VAGUE SET: in ${hit}/${scenes.length} scenes (${Math.round((hit / (scenes.length || 1)) * 100)}%) · ${density.toFixed(2)} per scene`,
  );
}

void main();
