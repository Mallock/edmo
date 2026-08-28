/**
 * Does the second line answer the first, or is it just the next line along?
 *
 * The live complaint that made this: "the convos seem irrelevant to each
 * other". Not the jargon problem — the lines are plain enough now — but the
 * two halves of an exchange no longer meet. One speaker asks whether they are
 * cleared; the other remarks that the Kumo crew are sniffing around a supply
 * run. Both are decent radio lines. Together they are not a conversation.
 *
 * WHAT IS MEASURED, and why these two things. A reply is bound to the line
 * before it by exactly two visible means:
 *
 *   HOOK      it opens by responding — yes, no, right, well, but, then, so,
 *             copy, understood, a question back. The grammar of taking a turn.
 *   CARRY     it re-uses something from the line before — a content word, or a
 *             pronoun standing in for one. The subject survives the handover.
 *
 * A line with neither is a non-sequitur however well written it is, and the
 * SHARE of replies with neither is the number that matters. The reference
 * corpus (EDCoPilot's hand-written static chatter) is the calibration: it is
 * what a coupled exchange looks like when a person wrote both halves.
 *
 *   npx tsx scripts/comms-coherence.ts --reference
 *   npx tsx scripts/comms-coherence.ts --port 51999 --key probe --scenes 16
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
const has = (f: string) => process.argv.includes(`--${f}`);
const PORT = arg('port', '51999');
const KEY = arg('key', 'probe');
const N = Number(arg('scenes', '16'));
const LABEL = arg('label', 'run');
const TEMP = Number(arg('temp', '0.95'));
const VARIANT = arg('variant', 'baseline');
const JOURNAL_DIR = arg(
  'journals',
  join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
);
const REF_DIR = arg('reference-dir', 'C:/EDCoPilot/User custom files');

// ------------------------------------------------------------- the two bonds

/** Words too common to prove anything by being repeated. */
const STOP = new Set(
  ('a an the and or but if of to in on at by for with from is are was were be been being do does ' +
    'did done have has had will would can could should may might must not no yes it its this that ' +
    'these those there here we you they he she i me him her them us my your our their as so then ' +
    'than just about out up down over under all any some more most very still get got go going ' +
    'one two three now well okay ok right').split(/\s+/),
);

/** Opening moves that only exist to take a turn from somebody. */
const HOOK_RE =
  /^(yes|yeah|yep|no|nope|nah|not\b|right|okay|ok|well|but|and|so|then|copy|roger|understood|acknowledged|affirmative|negative|agreed|sure|fine|maybe|course|of course|true|exactly|please|sorry|thanks|tell me|don'?t|do not|stop|wait|hold|listen|look|forget|never mind|that'?s|thats|it'?s|its|they'?re|you'?re|he'?s|she'?s|i'?ll|i'?ve|i'?d|we'?ll|we'?ve|if|because|since|anyway|still|either|neither|same|says who|says you|since when|how|what|why|who|when|where|which|is|are|was|were|did|does|do|can|could|should|would|will|have|has|had|am)\b/i;

const contentWords = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) ?? []).filter((w) => !STOP.has(w.replace(/['’].*$/, '')));

/** Pronouns and demonstratives that only mean anything by pointing backwards. */
const ANAPHOR_RE = /\b(it|its|that|those|these|they|them|their|he|him|his|she|her|this|one|there|same|both|either)\b/i;

interface Bond {
  hook: boolean;
  carry: boolean;
}

function bond(prev: string, reply: string): Bond {
  const hook = HOOK_RE.test(reply.trim()) || reply.trim().endsWith('?');
  const before = new Set(contentWords(prev));
  const shared = contentWords(reply).some((w) => before.has(w));
  return { hook, carry: shared || ANAPHOR_RE.test(reply) };
}

/** Score a list of exchanges, each already split into its lines. */
function score(exchanges: string[][], label: string): void {
  let replies = 0;
  let hooked = 0;
  let carried = 0;
  let loose = 0;
  const examples: string[] = [];
  for (const lines of exchanges) {
    for (let i = 1; i < lines.length; i++) {
      replies++;
      const b = bond(lines[i - 1], lines[i]);
      if (b.hook) hooked++;
      if (b.carry) carried++;
      if (!b.hook && !b.carry) {
        loose++;
        if (examples.length < 6) examples.push(`      "${lines[i - 1]}"\n   -> "${lines[i]}"`);
      }
    }
  }
  const pc = (x: number) => `${Math.round((x / (replies || 1)) * 100)}%`.padStart(4);
  console.log(`\n${'='.repeat(70)}\n${label} — ${replies} replies`);
  console.log(`  HOOK   opens by responding                 ${pc(hooked)}`);
  console.log(`  CARRY  re-uses a word or points back       ${pc(carried)}`);
  console.log(`  LOOSE  neither — a non-sequitur            ${pc(loose)}   <-- the number`);
  if (examples.length) {
    console.log('\n  loose pairs:');
    for (const e of examples) console.log(e);
  }
}

// ------------------------------------------------------- the reference corpus

function reference(): void {
  const exchanges: string[][] = [];
  for (const f of readdirSync(REF_DIR).filter((f) => /Chatter\.Custom\.txt$/.test(f))) {
    const text = readFileSync(join(REF_DIR, f), 'utf8');
    for (const block of text.split(/\[example\]/i).slice(1)) {
      const body = block.split(/\[\\example\]/i)[0];
      const lines = [...body.matchAll(/^\[<[^>]+>\]:?\s*"?(.+?)"?\s*$/gm)].map((m) => m[1].trim());
      if (lines.length >= 2) exchanges.push(lines);
    }
  }
  score(exchanges, `REFERENCE (EDCoPilot static chatter, ${exchanges.length} exchanges)`);
}

// ------------------------------------------------------------- the live probe

interface Pilot { name: string; rank?: string; ship?: string; faction?: string | null; legal?: string | null }
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
      let ev: Record<string, unknown> | null = null;
      try { ev = JSON.parse(line) as Record<string, unknown>; sm.apply(ev); } catch { /* torn line */ }
      if (ev && ev.event === 'ShipTargeted' && typeof ev.PilotName_Localised === 'string') {
        const name = ev.PilotName_Localised;
        if (!seenPilots.some((p) => p.name === name)) {
          seenPilots.unshift({
            name, rank: ev.PilotRank as string,
            ship: (ev.Ship_Localised as string) ?? (ev.Ship as string),
            faction: (ev.Faction as string) ?? null, legal: (ev.LegalStatus as string) ?? null,
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

/**
 * The sentence in the shipped prompt most likely to be causing this, and the
 * candidate replacements. `answer` is the hypothesis: the jargon fix told the
 * model what a reply must NOT be without ever saying what it must be.
 */
const NEVER =
  'Never answer a line with further detail about the same object.';
const ANSWER =
  'A reply must be ABOUT what was just said — take up the same subject, and answer, refuse, ' +
  'confirm, doubt or complain about THAT. Changing the subject is the one thing it may never do.';

/**
 * The other suspect, and the stronger one: the LAST paragraph of the system
 * prompt, which is pure novelty and grants no continuity at all.
 */
const NOVELTY =
  'Everything you have already written this session is above. Treat earlier material as used ' +
  'territory. Give each new batch fresh situations, imagery, complaints, rhythms and sentence ' +
  'shapes. Surprise the listener with something that has not appeared earlier.';
const THREAD =
  'Everything you have already written this session is above: the same night, the same radio, ' +
  'the same handful of people. Never repeat a LINE, a phrasing or a sentence shape you have ' +
  'already used — that is what goes stale. But the PEOPLE and the SITUATIONS are meant to carry: ' +
  'somebody named two scenes ago can turn up again, a delay can still be unresolved, a favour ' +
  'asked for earlier can be repaid or refused now, a rumour can reach somebody new. When ' +
  'anything above can plausibly be picked up, pick it up and move it on. A channel where every ' +
  'exchange is about a brand new subject sounds like twenty different stations rather than one ' +
  'place where things are happening.';

const VARIANTS: Record<string, (c: ChatMessage[]) => ChatMessage[]> = {
  baseline: (c) => c,
  /** Let the air have a memory. */
  thread: (c) => patchSystem(c, (s) => s.replace(NOVELTY, THREAD)),
  /** Drop the prohibition that may be reading as "change the subject". */
  'no-never': (c) => patchUser(c, (s) => s.replace(` ${NEVER}`, '')),
  /** Replace it with a positive instruction to stay on the subject. */
  answer: (c) => patchUser(c, (s) => s.replace(NEVER, ANSWER)),
};

function patchSystem(c: ChatMessage[], f: (s: string) => string): ChatMessage[] {
  const out = c.slice();
  const next = f(out[0].content);
  if (next === out[0].content) throw new Error(`variant ${VARIANT}: nothing to patch in the system prompt`);
  out[0] = { ...out[0], content: next };
  return out;
}

function patchUser(c: ChatMessage[], f: (s: string) => string): ChatMessage[] {
  const out = c.slice();
  const i = out.length - 1;
  const next = f(out[i].content);
  if (next === out[i].content) throw new Error(`variant ${VARIANT}: nothing to patch`);
  out[i] = { ...out[i], content: next };
  return out;
}

async function live(): Promise<void> {
  const snap = harvest();
  const view = campaignView(snap.intel);
  console.log(`[${LABEL}] ${snap.system} · ${N} scenes · temp ${TEMP} · variant ${VARIANT}`);

  const history: ChatMessage[] = [];
  const texts: string[] = [];
  const exchanges: string[][] = [];

  for (let i = 0; i < N; i++) {
    const channel = (Object.keys(REFS) as ChannelId[])[i % 4];
    const speakers = REFS[channel];
    const dossier = buildDossier({
      system: snap.system, intel: snap.intel, docked: true, stationName: snap.station,
      rotate: i, recentAir: texts.slice(-6), pilots: seenPilots.slice(0, 12),
      extra: spineLines(view, 'comms', i),
    });
    const req: SceneRequest = {
      channel, func: FUNCS[i % FUNCS.length], act: 'BUILDING',
      brief: textureBrief(`coh:${i}`),
      speakers: [...speakers],
      speakerNames: Object.fromEntries(speakers.map((r) => [r, NAMES[r] ?? r])),
      situation: SITUATIONS[channel][(i * 7) % SITUATIONS[channel].length],
      dossier, rotate: i, lines: i % 3 === 2 ? 3 : 2,
    };
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        messages: VARIANTS[VARIANT](buildSceneChat(req, history)),
        temperature: TEMP, max_tokens: 700,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content ?? '';
    const accepted = acceptSceneReply(raw, req, `coh:${i}`, 60_000, undefined, texts.slice(-8));
    const lines = accepted.ok ? accepted.scene.turns.map((t) => t.text) : [];
    if (lines.length < 2) {
      console.log(`${String(i).padStart(2)} ${channel.padEnd(10)} DROPPED`);
      continue;
    }
    texts.push(lines.join(' '));
    if (accepted.ok) history.push({ role: 'assistant', content: sceneTranscript(accepted.scene) });
    exchanges.push(lines);

    const b = bond(lines[0], lines[1]);
    console.log(
      `${String(i).padStart(2)} ${channel.padEnd(10)} ${b.hook || b.carry ? 'bound ' : 'LOOSE '} — ${req.situation ?? ''}`,
    );
    for (const l of lines) console.log(`     · ${l}`);
  }
  score(exchanges, `[${LABEL}] variant ${VARIANT}`);

  // ---- SCENE TO SCENE. The complaint was not about the pair of lines inside
  // an exchange, which measured fine; it was that consecutive exchanges have
  // nothing to do with one another. Background scenery does not count — the
  // faction and station names are in every briefing, so they recur whether or
  // not anything is being carried forward. What counts is a word this channel
  // INVENTED and then used again.
  const briefingNouns = new Set(
    contentWords(
      [snap.system, snap.station ?? '', ...(snap.intel.factions ?? []).map((f) => f.name)].join(' '),
    ),
  );
  const bagOf = (t: string) => new Set(contentWords(t).filter((w) => !briefingNouns.has(w)));
  const bags = texts.map(bagOf);
  let callbacks = 0;
  const carried = new Map<string, number>();
  for (let i = 1; i < bags.length; i++) {
    const recent = new Set<string>();
    for (let j = Math.max(0, i - 3); j < i; j++) for (const w of bags[j]) recent.add(w);
    const shared = [...bags[i]].filter((w) => recent.has(w));
    if (shared.length) callbacks++;
    for (const w of shared) carried.set(w, (carried.get(w) ?? 0) + 1);
  }
  const denom = Math.max(1, bags.length - 1);
  console.log(`
  SCENE-TO-SCENE (ignoring briefing scenery)`);
  console.log(
    `  callback rate  ${String(callbacks).padStart(2)}/${denom}  ${Math.round((callbacks / denom) * 100)}%  — scenes picking anything up from the last three`,
  );
  const top = [...carried.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`  most carried: ${top.map(([w, n]) => `${w}×${n}`).join(', ') || '(nothing)'}`);
}

if (has('reference')) reference();
else void live();
