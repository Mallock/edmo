/**
 * The dry-satire voice, crossed with the commander's own journals.
 *
 * The ungrounded run of this system prompt was good and narrow: 32/32 answers
 * obeyed its own banned-phrase list, produced ten genuinely sharp passages, and
 * wrote the same room every time — synergy in 75% of them, coffee in 44%,
 * humming fluorescent lights in 34%, "a suit the colour of expensive
 * disappointment" verbatim in two unrelated pieces. A strong voice with a
 * stock cupboard.
 *
 * Two things are being tested here at once, which is why the variants are
 * crossed rather than run separately:
 *
 *   GROUNDING   the same dossier the comms writer gets — real factions, real
 *               stations, real signals, real population, off the commander's
 *               journals — instead of a generic corporate brief. A model with
 *               concrete material to hand should need its stock cupboard less.
 *   VARIANTS    baseline, plus the two fixes the ungrounded run argued for:
 *               a banned-props list (it is the PROPS that repeat, not the
 *               phrases the prompt already bans) and an instruction to move
 *               the vantage point out of the meeting room.
 *
 * WHAT IS MEASURED. Three things, all of them checkable; whether it is funny
 * is not one of them and is left to a human reading the file this writes.
 *
 *   RULES     the prompt's own banned filler and openers
 *   PROPS     the stock cupboard, counted per answer
 *   GROUNDED  does the piece actually name this system, its port, or one of
 *             its factions — a satire that ignores its material is just the
 *             generic run with a dossier stapled to it
 *
 *   npx tsx scripts/wit-grounded.ts --port 51999 [--system "Beta-3 Tucani"]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MissionStateManager } from '../src/engine/state.ts';
import { buildDossier } from '../src/engine/chatter/dossier.ts';
import type { SystemIntel } from '../src/engine/types.ts';

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PORT = arg('port', '51999');
const KEY = arg('key', 'probe');
const WANT_SYSTEM = arg('system', '');
const OUT = arg('out', 'wit-grounded-results.txt');
const JOURNAL_DIR = arg(
  'journals',
  join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
);
const SYSTEM_PROMPT_FILE = arg(
  'prompt',
  join(
    homedir(),
    'AppData', 'Local', 'Temp', 'claude',
    'c--product-work-hobby-projects-ed-mission-operator',
    '48e2cbff-2cb9-4bd7-ac69-dcb14d2f2097', 'scratchpad', 'wit-system.txt',
  ),
);

const BASE = readFileSync(SYSTEM_PROMPT_FILE, 'utf8');

/**
 * The stock cupboard, named so it can be shut.
 *
 * The prompt already bans a list of PHRASES and obeyed that perfectly. What it
 * repeats is furniture, which no rule covered — so this names the specific
 * props the ungrounded run leaned on, and points the model at its material
 * instead. Naming them is a calculated risk: this codebase has been bitten
 * before by vivid nouns in a prompt coming back as vocabulary. Measured either
 * way below.
 */
const PROPS_RULE = `

BANNED PROPS

You reach for the same furniture in every piece. None of the following may appear anywhere in your answer:

* the smell of coffee, stale, lukewarm, expensive or otherwise
* the construction "smelled faintly of"
* humming or buzzing fluorescent lights
* polished mahogany, veneer, or a gleaming table
* Venn diagrams
* a smile that does not reach the eyes
* a character named Brenda
* somebody clearing their throat
* the words synergy or synergistic

If a scene needs a concrete detail, take it from the material you have been given. Real specifics beat stock ones, and you have been handed a great many.`;

/**
 * Get out of the meeting room.
 *
 * Every ungrounded answer was observed from the back of a presentation. The
 * absurdity is usually clearer from where the decision lands than from where
 * it is announced.
 */
const SETTING_RULE = `

VANTAGE POINT

Not everything happens in a meeting room, and you default to one.

Choose instead the place where the decision lands: a loading bay, a canteen queue, a corridor at the end of a shift, the wrong side of a counter, somebody's kitchen, a vehicle, a doorway, a night watch. Put the reader next to the person paying for the decision rather than the person announcing it. The announcement can reach them second-hand — overheard, posted on a wall, read off a screen by somebody who does not care.`;

const VARIANTS: Record<string, string> = {
  base: BASE,
  props: BASE + PROPS_RULE,
  setting: BASE + SETTING_RULE,
  both: BASE + PROPS_RULE + SETTING_RULE,
};

// --------------------------------------------------------------- the journal

function harvest(): { system: string; intel: SystemIntel; station: string | null } {
  const files = readdirSync(JOURNAL_DIR).filter((f) => /^Journal\..*\.log$/.test(f)).sort();
  const sm = new MissionStateManager();
  let best: { system: string; intel: SystemIntel; station: string | null; score: number } | null = null;
  const keep = () => {
    const st = sm.getState();
    const sys = st.system;
    if (!sys || !st.location.system || st.location.system === 'unknown') return;
    if (WANT_SYSTEM && st.location.system.toLowerCase() !== WANT_SYSTEM.toLowerCase()) return;
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
      try { sm.apply(JSON.parse(line)); } catch { /* torn last line */ }
      keep();
    }
  }
  if (!best) throw new Error('no system with intel in the journals');
  return best;
}

/**
 * Briefs chosen where this voice and this data actually overlap.
 *
 * The prompt's declared wheelhouse is bureaucracy, politics, management
 * language and grand plans undone by something ordinary. A system dossier is
 * full of exactly that: factions at measured percentages, states with names
 * like InfrastructureFailure, station management, docking procedure, a war
 * being fought over an asset. It maps almost too neatly.
 */
const BRIEFS: Array<[string, string]> = [
  ['faction-board', 'Write about the political situation in this system.'],
  ['docking', 'Write about the docking procedure at the station the commander is at.'],
  ['economy', 'Write about what this system does for a living, and who does it.'],
  ['notice', 'Write a public notice posted somewhere in the station, and what happens around it.'],
  ['war', 'Write about the conflict being fought in this system.'],
  ['ordinary', 'Write about an ordinary working day for somebody who lives here.'],
  ['carriers', 'Write about the fleet carriers parked in this system.'],
  ['infrastructure', 'Write about the state of local services here.'],
];

// ------------------------------------------------------------------- scoring

const BANNED = [
  'well, that happened', 'plot twist', 'because apparently', "you can't make this stuff up",
  'let that sink in', 'and somehow it gets worse', "in today's rapidly evolving world",
  "it's important to note", 'at its core', "here's the thing", "let's dive in",
];
const NOT_JUST = /\bis(?:n't| not) just\b[^.!?]{1,60}\bit'?s\b/i;

const PROPS: Array<[RegExp, string]> = [
  [/\bcoffee\b/i, 'coffee'],
  [/smell(?:ed|s|ing)? faintly of/i, 'smelled faintly of'],
  [/fluorescent|strip lights?\b/i, 'fluorescent'],
  [/mahogany|veneer/i, 'mahogany/veneer'],
  [/venn diagram/i, 'Venn diagram'],
  [/(?:did|does) not reach (?:his|her|their) eyes/i, 'smile not reaching eyes'],
  [/\bBrenda\b/i, 'Brenda'],
  [/clear(?:ed|s|ing)? (?:his|her|their) throat/i, 'clears throat'],
  [/synerg/i, 'synergy'],
];

async function ask(system: string, user: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.9,
      max_tokens: 650,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (j.choices?.[0]?.message?.content ?? '').trim();
}

async function main(): Promise<void> {
  const snap = harvest();
  const dossier = buildDossier({
    system: snap.system,
    intel: snap.intel,
    docked: true,
    stationName: snap.station,
    rotate: 0,
  });
  const factions = (snap.intel.factions ?? []).map((f) => f.name);
  const ports = [
    ...(snap.intel.stations ?? []).map((x) => (typeof x === 'string' ? x : x.name)),
  ].filter(Boolean) as string[];

  console.log(`GROUNDED WIT · ${snap.system} · docked at ${snap.station ?? '(none)'}`);
  console.log(`${Object.keys(VARIANTS).length} variants × ${BRIEFS.length} briefs\n`);
  console.log('--- THE DOSSIER EVERY ANSWER IS GIVEN ---');
  console.log(dossier);
  console.log();

  const out: string[] = [`GROUNDED WIT · ${snap.system}\n\nDOSSIER\n${dossier}\n`];
  const tally: Record<string, { n: number; rules: number; props: number; grounded: number }> = {};

  for (const [vname, sys] of Object.entries(VARIANTS)) {
    tally[vname] = { n: 0, rules: 0, props: 0, grounded: 0 };
    for (const [bid, brief] of BRIEFS) {
      const user =
        `Here is everything known about the place. Use it — the names, the numbers, the states, ` +
        `the people. This is the material, not decoration.\n\n${dossier}\n\n${brief}`;
      const text = await ask(sys, user);
      const low = text.toLowerCase();

      const ruleHits = BANNED.filter((b) => low.includes(b));
      if (NOT_JUST.test(text)) ruleHits.push("isn't just X, it's Y");
      const propHits = PROPS.filter(([re]) => re.test(text)).map(([, n]) => n);
      const grounded =
        low.includes(snap.system.toLowerCase()) ||
        (!!snap.station && low.includes(snap.station.toLowerCase())) ||
        factions.some((f) => low.includes(f.toLowerCase())) ||
        ports.some((p) => low.includes(p.toLowerCase()));

      const t = tally[vname];
      t.n += 1;
      if (!ruleHits.length) t.rules += 1;
      t.props += propHits.length;
      if (grounded) t.grounded += 1;

      const words = text.split(/\s+/).filter(Boolean).length;
      out.push(
        `\n${'='.repeat(78)}\n[${vname}/${bid}] ${words} words · ${grounded ? 'GROUNDED' : 'ungrounded'}` +
          `${propHits.length ? ` · props: ${propHits.join(', ')}` : ' · props: none'}` +
          `${ruleHits.length ? ` · RULE BREAK: ${ruleHits.join(', ')}` : ''}\n${'='.repeat(78)}\n${text}\n`,
      );
      console.log(
        `${vname.padEnd(8)} ${bid.padEnd(15)} ${String(words).padStart(3)}w  ` +
          `${grounded ? 'grounded' : 'UNGROUND'}  props=${propHits.length}${propHits.length ? ` (${propHits.join(',')})` : ''}`,
      );
    }
  }

  console.log(`\n${'='.repeat(66)}`);
  console.log(`${'variant'.padEnd(10)}${'rules ok'.padStart(10)}${'props/answer'.padStart(14)}${'grounded'.padStart(12)}`);
  for (const [v, t] of Object.entries(tally)) {
    console.log(
      `${v.padEnd(10)}${`${t.rules}/${t.n}`.padStart(10)}${(t.props / t.n).toFixed(2).padStart(14)}${`${Math.round((t.grounded / t.n) * 100)}%`.padStart(12)}`,
    );
  }
  out.push(`\n${'='.repeat(78)}\nSUMMARY\n`);
  for (const [v, t] of Object.entries(tally)) {
    out.push(`${v}: rules ${t.rules}/${t.n} · props/answer ${(t.props / t.n).toFixed(2)} · grounded ${Math.round((t.grounded / t.n) * 100)}%\n`);
  }
  writeFileSync(OUT, out.join(''), 'utf8');
  console.log(`\nwritten to ${OUT}`);
}

void main();
