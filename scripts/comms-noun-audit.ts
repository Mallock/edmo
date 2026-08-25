/**
 * Which nouns hog the air? A repetition audit over the commander's REAL system.
 *
 * The lore harness reads scenes for quality; this one counts them. Live
 * sessions showed the writer repeating the same two tokens — the docked
 * station and the campaign's patron faction — because both were PINNED in
 * every prompt: the dossier names the docked port on every call, and the
 * spine rides most dossiers. The model is a salience mirror; a noun in every
 * prompt is an instruction to use it.
 *
 * So: replay the real journals, take the richest system, generate a batch of
 * scenes under TRUE app conditions (rolling history, campaign spine lines,
 * rotating situations/registers/moments), and count — per dossier noun — how
 * many SCENES mention it. The bar: no noun rides more than half the scenes.
 *
 *   npx tsx scripts/comms-noun-audit.ts --port 51999 --key probe [--scenes 14]
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
import { airedIn, hotNouns } from '../src/engine/chatter/dossier.ts';
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
const N = Number(arg('scenes', '14'));
/** Pin the audited system ('' = richest found). The live complaint names a
 *  specific place; an audit of somewhere else answers nothing. */
const SYSTEM = arg('system', '');
const JOURNAL_DIR = arg(
  'journals',
  join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
);

// ------------------------------------------------- richest system, from disk
function harvest(): { system: string; intel: SystemIntel; station: string | null } {
  const files = readdirSync(JOURNAL_DIR).filter((f) => /^Journal\..*\.log$/.test(f)).sort();
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
  if (!best) throw new Error('no system with intel found');
  return best;
}

// --------------------------------------- the campaign, as live sessions had it
function campaignView(sys: SystemIntel): CampaignView {
  // Patron = --patron when given (to reproduce a specific live complaint),
  // else the top-influence non-controlling faction, which is what the real
  // election tends to produce for a commander working local contracts.
  const patronName =
    arg('patron', '') ||
    ((sys.factions ?? [])
      .filter((f) => f.name !== sys.controllingFaction)
      .sort((a, b) => b.influence - a.influence)[0]?.name ??
      'Local Co-op');
  return {
    pursuer: null,
    patron: {
      role: 'patron',
      faction: patronName,
      clock: 2,
      clockMovedAt: new Date().toISOString(),
      cooldownUntil: '',
      beats: [{ at: new Date().toISOString(), text: 'completed a contract for them' }],
      onAir: [{ at: new Date().toISOString(), text: `Word is ${patronName} pays their haulers on time` }],
      electedAt: new Date().toISOString(),
    },
    vow: null,
    payoffs: {},
  };
}

// ------------------------------------------------------------------ the batch
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
  const snap = harvest();
  const view = campaignView(snap.intel);
  console.log(`System: ${snap.system} · docked at ${snap.station ?? '(none)'} · patron: ${view.patron?.faction}\n`);

  const history: ChatMessage[] = [];
  const channels = Object.keys(REFS) as ChannelId[];
  const sceneTexts: string[] = [];
  const times: number[] = [];
  let hotStreak = 0;

  for (let i = 0; i < N; i++) {
    const channel = channels[i % channels.length];
    const situation = SITUATIONS[channel][(i * 7) % SITUATIONS[channel].length];
    const speakers = REFS[channel];
    const dossier = buildDossier({
      system: snap.system,
      intel: snap.intel,
      docked: true,
      stationName: snap.station,
      rotate: i,
      // TRUE app conditions: the spine rides in as extras and the last six
      // accepted scenes drive the noun cooling, exactly as the store wires it.
      recentAir: sceneTexts.slice(-6),
      extra: spineLines(view, 'comms', i),
    });
    const req: SceneRequest = {
      channel,
      func: FUNCS[i % FUNCS.length],
      act: 'BUILDING',
      brief: textureBrief(`audit:${i}`),
      speakers: [...speakers],
      speakerNames: Object.fromEntries(speakers.map((r) => [r, NAMES[r] ?? r])),
      situation,
      dossier,
      rotate: i,
      // Mirror the store's multi-turn rotation: every 3rd scene three lines,
      // every 7th four.
      lines: i % 7 === 0 ? 4 : i % 3 === 0 ? 3 : 2,
    };
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: 'audit',
        messages: buildSceneChat(req, history),
        max_tokens: 700,
        temperature: 0.8,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const out = acceptSceneReply(j.choices?.[0]?.message?.content ?? '', req, `a:${i}`, 60_000);
    times.push(Date.now() - t0);
    if (!out.ok) {
      console.log(`  [${channel}] DROPPED (${out.why})`);
      continue;
    }
    const text = out.scene.turns.map((t) => t.text).join(' ');
    // The store's accept-time snowball brake, mirrored: a scene naming a
    // hot place is dropped (max twice in a row) and never reaches the air.
    const hot = hotNouns(sceneTexts.slice(-6), (snap.intel.signals ?? []).map((x) => x.name));
    const hotHit = [...hot].find((n) => airedIn(text, n));
    if (hotHit && hotStreak < 2) {
      hotStreak++;
      console.log(`  [${channel}] GATED — the air is full of ${hotHit}`);
      continue;
    }
    hotStreak = 0;
    sceneTexts.push(text);
    history.push({ role: 'assistant', content: sceneTranscript(out.scene) });
    // Mirror the app's trimmed transcript: ~6 scenes of used territory.
    if (history.length > 6) history.splice(0, history.length - 6);
    console.log(`  [${channel}/${req.func}] ${situation}`);
    for (const t of out.scene.turns) console.log(`      ${(NAMES[t.speakerRef] ?? '').padEnd(16)} ${t.text}`);
  }

  // ------------------------------------------------------------- the counting
  const nouns = new Set<string>();
  for (const s of snap.intel.signals ?? []) if (s.name.length > 3) nouns.add(s.name);
  for (const f of snap.intel.factions ?? []) nouns.add(f.name);
  if (snap.intel.controllingFaction) nouns.add(snap.intel.controllingFaction);
  if (snap.station) nouns.add(snap.station);
  if (view.patron) nouns.add(view.patron.faction);

  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rows: Array<[string, number]> = [];
  for (const noun of nouns) {
    // Count every form a LISTENER would recognise: the full name, the first
    // word ("Benyovszky", "Kumo") and the last word ("the Gateway", "the
    // Depot") — the name-shrinking clip is precisely what gets repeated on
    // air, and the first version of this audit was blind to it. Generic
    // words are excluded in both positions so "The Dark Wheel" does not
    // match "the" and "Dickens Point" does not match every "point".
    const words = noun.split(/\s+/);
    const generic = /^(the|new|old|los|las|san|port|nav|deep|point|site|zone|city|base|camp|ring|star|world|beacon)$/i;
    const alts = [esc(noun)];
    const first = words[0];
    if (words.length > 1 && first.length >= 4 && !generic.test(first)) alts.push(esc(first));
    const last = words[words.length - 1];
    if (words.length > 1 && last.length >= 4 && !generic.test(last) && last !== first) alts.push(esc(last));
    const pattern = new RegExp(`\\b(?:${alts.join('|')})\\b`, 'i');
    const hits = sceneTexts.filter((t) => pattern.test(t)).length;
    if (hits > 0) rows.push([noun, hits]);
  }
  rows.sort((a, b) => b[1] - a[1]);

  const avg = Math.round(times.reduce((a, b) => a + b, 0) / Math.max(1, times.length));
  console.log(`\n${sceneTexts.length}/${N} scenes · avg ${avg}ms`);
  console.log('\nNOUN                                    SCENES  SHARE');
  for (const [noun, hits] of rows) {
    const share = hits / sceneTexts.length;
    const flag = share > 0.5 ? '  << HOGGING THE AIR' : share > 0.35 ? '  < warm' : '';
    console.log(`${noun.padEnd(40).slice(0, 40)}${String(hits).padStart(4)}  ${(share * 100).toFixed(0).padStart(4)}%${flag}`);
  }
  const worst = rows[0];
  const bar = sceneTexts.length / 2;
  console.log(
    worst && worst[1] > bar
      ? `\nFAIL — "${worst[0]}" rides ${worst[1]}/${sceneTexts.length} scenes (bar: ${Math.floor(bar)})`
      : '\nPASS — no noun rides more than half the scenes',
  );
}

void main();
