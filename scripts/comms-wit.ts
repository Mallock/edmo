/**
 * Can this model actually be funny, or does it only know that it should be?
 *
 * The question behind it: the dial already asks for wit — SCENE_ENERGY carries
 * "dryly funny" and "slightly absurd", and CONCOURSE is described as
 * "bureaucratic, bloodless, accidentally funny" — but asking for funny and
 * getting funny are different things, and nothing has ever checked.
 *
 * TWO MECHANICS, NOT TWO AUTHORS. The prompts below describe how a joke is
 * BUILT, never whose jokes they resemble. Two reasons. A 4B model handed a
 * famous name produces an impression of that name — the tics without the
 * timing — and this codebase has been bitten repeatedly by vivid nouns in the
 * prompt coming back as vocabulary. Mechanics survive that; names do not.
 *
 *   DEFLATION   line one takes itself seriously; line two punctures it with
 *               something small, domestic and unimpressed. The comedy of
 *               someone being quietly not as important as they think.
 *   EUPHEMISM   institutional language describing something grim as routine.
 *               The joke is the GAP between the notice and the thing itself,
 *               and nobody in the scene finds it funny at all.
 *
 * HONEST LIMITS. Humour is a read, not a number. The counters below measure
 * only the SHAPE a joke usually arrives in — a puncturing second line, a
 * register that drops from grand to domestic, institutional passive voice —
 * and a scene can score well on all of them and still be dead on the page.
 * They are here to sort the batch, not to award marks. Read the scenes.
 *
 *   npx tsx scripts/comms-wit.ts --port 51999 --key probe --variant deflation
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
import type { SystemIntel } from '../src/engine/types.ts';
import type { ChannelId, DramaticFunction } from '../src/engine/chatter/types.ts';
import type { ChatMessage } from '../src/engine/lmstudio.ts';

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PORT = arg('port', '51999');
const KEY = arg('key', 'probe');
const N = Number(arg('scenes', '12'));
const TEMP = Number(arg('temp', '0.95'));
const VARIANT = arg('variant', 'baseline');
const JOURNAL_DIR = arg(
  'journals',
  join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
);

const DEFLATION =
  'BE FUNNY THE WAY WORKING PEOPLE ARE FUNNY, which is at each other and never on purpose. ' +
  'The first line should take itself a little too seriously — a small authority, a procedure ' +
  'quoted, a competence claimed, a grievance aired as though it mattered. The line answering it ' +
  'punctures that, flatly, with something smaller: what it actually cost, what it reminds them ' +
  'of, or a plain fact that makes the first speaker sound ridiculous. Never signpost the joke, ' +
  'never let anyone laugh, never use an exclamation mark. The speaker being deflated does not ' +
  'realise it has happened. Understatement does the work.';

const EUPHEMISM =
  'BE FUNNY THE WAY OFFICIAL LANGUAGE IS FUNNY, without anybody intending it. Describe something ' +
  'grim, dangerous or plainly unjust in the flat vocabulary an institution would use for it — a ' +
  'shortage is an adjustment, a body is an incident, a demand is a courtesy reminder. The joke ' +
  'is the distance between the words and the thing, and it only works if nobody in the scene ' +
  'notices any distance at all. Nobody jokes, nobody winks, nobody complains. Deadly sincere, ' +
  'entirely reasonable in tone, and quietly appalling if you think about what was just said.';

const VARIANTS: Record<string, string | null> = {
  baseline: null,
  deflation: DEFLATION,
  euphemism: EUPHEMISM,
};

function withWit(chat: ChatMessage[]): ChatMessage[] {
  const add = VARIANTS[VARIANT];
  if (add === undefined) throw new Error(`unknown variant ${VARIANT}`);
  if (!add) return chat;
  const out = chat.slice();
  const i = out.length - 1;
  out[i] = {
    ...out[i],
    content: out[i].content.replace(
      /\n\nWrite the \d+ lines? now\.$/,
      (tail) => `\n\n${add}${tail}`,
    ),
  };
  return out;
}

// ------------------------------------------------------------ shape counters

/** A second line that turns on the first rather than extending it. */
const PUNCTURE_RE =
  /\b(that'?s|thats|sure|right|course|apparently|allegedly|again|still|somehow|technically|obviously|wonderful|marvellous|marvelous|lovely|brilliant|fantastic|great|congratulations|well done|good luck|if you say so|since when|you said|you told|last time|as usual|every time|the same one|funny|odd)\b/i;

/** The small, domestic, unimpressed register a deflating line drops into. */
const DOMESTIC_RE =
  /\b(tea|coffee|kettle|sandwich|lunch|dinner|breakfast|biscuit|canteen|mess|socks|boots|laundry|paperwork|form|clipboard|queue|kids?|wife|husband|mum|mother|dad|father|rent|shift|holiday|weekend|bed|sleep|hangover|birthday|cousin|neighbour|dog|cat)\b/i;

/** Institutional passive — the voice of a notice nobody wrote. */
const INSTITUTIONAL_RE =
  /\b(advised|reminded|requested|required|regret|apologi[sz]e|inconvenience|temporar\w+|routine|standard|procedure|policy|scheduled|unscheduled|adjustment|incident|irregularit\w+|non-compliance|compliance|processed|reviewed|pending|further notice|due course|at this time|for your safety|thank you for)\b/i;

interface Pilot { name: string; ship?: string }
const seenPilots: Pilot[] = [];

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

const REFS: Record<string, [string, string]> = {
  CREW: ['crew:ops', 'crew:engineering'],
  CONCOURSE: ['pa', 'traveller'],
  LOCAL: ['hauler', 'hauler2'],
  STATION: ['control', 'ship'],
};
const NAMES: Record<string, string> = {
  'crew:ops': 'Ops', 'crew:engineering': 'Engineering',
  pa: 'Concourse PA', traveller: 'Station Traveller',
  hauler: 'Yusuf Fiore', hauler2: 'Dmitri Sarkis',
  control: 'Traffic Control', ship: 'Inbound Traffic',
};
const FUNCS: DramaticFunction[] = ['texture', 'complicate', 'establish', 'reverse'];

async function main(): Promise<void> {
  const snap = harvest();
  console.log(`WIT PROBE · ${snap.system} · ${N} scenes · variant ${VARIANT} · temp ${TEMP}\n`);

  const history: ChatMessage[] = [];
  const texts: string[] = [];
  let punctured = 0;
  let domestic = 0;
  let institutional = 0;
  let kept = 0;

  for (let i = 0; i < N; i++) {
    const channel = (Object.keys(REFS) as ChannelId[])[i % 4];
    const speakers = REFS[channel];
    const dossier = buildDossier({
      system: snap.system, intel: snap.intel, docked: true, stationName: snap.station,
      rotate: i, recentAir: texts.slice(-6), extra: [],
    });
    const req: SceneRequest = {
      channel, func: FUNCS[i % FUNCS.length], act: 'QUIET',
      brief: textureBrief(`wit:${i}`),
      speakers: [...speakers],
      speakerNames: Object.fromEntries(speakers.map((r) => [r, NAMES[r] ?? r])),
      situation: SITUATIONS[channel][(i * 5) % SITUATIONS[channel].length],
      dossier, rotate: i, lines: 2,
    };
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        messages: withWit(buildSceneChat(req, history)),
        temperature: TEMP, max_tokens: 700,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content ?? '';
    const accepted = acceptSceneReply(raw, req, `wit:${i}`, 60_000, undefined, texts.slice(-8));
    const lines = accepted.ok ? accepted.scene.turns.map((t) => t.text) : [];
    if (lines.length < 2) {
      console.log(`${String(i).padStart(2)} ${channel.padEnd(10)} DROPPED`);
      continue;
    }
    kept++;
    texts.push(lines.join(' '));
    if (accepted.ok) history.push({ role: 'assistant', content: sceneTranscript(accepted.scene) });

    const p = PUNCTURE_RE.test(lines[1]);
    const d = DOMESTIC_RE.test(lines.join(' '));
    const ins = INSTITUTIONAL_RE.test(lines.join(' '));
    if (p) punctured++;
    if (d) domestic++;
    if (ins) institutional++;

    const tag = `${p ? 'P' : '·'}${d ? 'D' : '·'}${ins ? 'I' : '·'}`;
    console.log(`${String(i).padStart(2)} ${channel.padEnd(10)} ${tag}  — ${req.situation ?? ''}`);
    for (const l of lines) console.log(`     · ${l}`);
    console.log();
  }

  const pc = (x: number) => `${Math.round((x / (kept || 1)) * 100)}%`.padStart(4);
  console.log('='.repeat(70));
  console.log(`variant ${VARIANT} — ${kept}/${N} scenes kept`);
  console.log(`  P  second line turns on the first   ${pc(punctured)}`);
  console.log(`  D  drops into a domestic register   ${pc(domestic)}`);
  console.log(`  I  institutional / notice voice     ${pc(institutional)}`);
  console.log('\n  These are shapes, not laughs. The verdict is in reading them.');
}

void main();
