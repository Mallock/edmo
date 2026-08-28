/**
 * Is anybody on this channel living a life, or is it all politics?
 *
 * The noun audit answers "does one name hog the air". This answers the other
 * live complaint: every scene was factions and stations, and a system of
 * thirty-eight million people never once mentioned a meal, a shift ending or
 * anyone's family.
 *
 * It generates a batch under true app conditions and scores each scene twice:
 *
 *   POLITICS  names a faction from the briefing, or talks influence/expansion
 *   PLACES    names a station, settlement or signal from the briefing
 *   LIFE      food, sleep, family, home, shift's end, weather, money at home
 *
 * A scene can be several at once — that is the point. What matters is the
 * SHARE of scenes with any life in them at all, because that is the thing the
 * live air had none of.
 *
 *   npx tsx scripts/comms-life-audit.ts --port 51999 --key probe [--scenes 16]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MissionStateManager } from '../src/engine/state.ts';
import { buildDossier, airedIn } from '../src/engine/chatter/dossier.ts';
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
const JOURNAL_DIR = arg(
  'journals',
  join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous'),
);

interface Pilot { name: string; rank?: string; ship?: string; faction?: string | null; legal?: string | null }
const seenPilots: Pilot[] = [];
let crewName: string | null = null;

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
      // The same two seams the app now reads: who was scanned, and who is crew.
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
      if (ev && /^(NpcCrewPaidWage|CrewHire|NpcCrewRank)$/.test(String(ev.event))) {
        const n = (ev.NpcCrewName as string) ?? (ev.Name as string) ?? (ev.CrewName as string);
        if (n) crewName = n;
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

/** Everyday life, in the words people actually use for it. */
const LIFE_RE =
  /\b(eat|eaten|eating|ate|meal|food|canteen|mess|galley|coffee|tea|drink|breakfast|dinner|lunch|supper|sleep|slept|sleeping|tired|exhausted|bed|bunk|rest|shift|rota|leave|off duty|home|family|kid|kids|son|daughter|wife|husband|mother|father|brother|sister|birthday|anniversary|message|letter|wedding|funeral|sick|unwell|doctor|laundry|shower|weekend|holiday|pay|rent|savings)\b/i;

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

async function main() {
  const snap = harvest();
  const view = campaignView(snap.intel);
  const factions = (snap.intel.factions ?? []).map((f) => f.name);
  const places = [
    ...(snap.intel.stations ?? []).map((x) => (typeof x === 'string' ? x : x.name)),
    ...(snap.intel.signals ?? []).map((x) => x.name),
  ].filter(Boolean) as string[];

  console.log(`[${LABEL}] ${snap.system} · ${N} scenes · ${factions.length} factions known\n`);

  const history: ChatMessage[] = [];
  const texts: string[] = [];
  let politics = 0;
  let placey = 0;
  let life = 0;
  // Per channel too. The whole point of giving each channel its own system
  // prompt is that they should NOT all look the same — a crew intercom full of
  // influence percentages is the failure this measures.
  const per: Record<string, { n: number; p: number; s: number; l: number }> = {};

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
      brief: textureBrief(`life:${i}`),
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
        messages: buildSceneChat(req, history),
        temperature: 0.95,
        max_tokens: 700,
        // The app suppresses Gemma's hidden reasoning on the comms path
        // (modelprofile: thinkingFor.comms === false). Without this the model
        // spends the whole budget planning and returns an empty answer — which
        // is what an unconfigured probe measures instead of the product.
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content ?? '';
    const accepted = acceptSceneReply(raw, req, `life:${i}`, 60_000, undefined, texts.slice(-8));
    const lines = accepted.ok ? accepted.scene.turns.map((t) => t.text) : [];
    if (!lines.length) {
      const why = accepted.ok ? 'empty' : accepted.why;
      console.log(
        `${String(i).padStart(2)} ${channel.padEnd(9)} (dropped: ${why}) raw="${raw
          .slice(0, 70)
          .split('\n')
          .join(' | ')}"`,
      );
      continue;
    }
    const text = lines.join(' ');
    texts.push(text);
    if (accepted.ok) history.push({ role: 'assistant', content: sceneTranscript(accepted.scene) });

    const hasFaction = factions.some((f) => airedIn(text, f)) || /influence|expansion|election|faction/i.test(text);
    const hasPlace = places.some((p) => airedIn(text, p));
    const hasLife = LIFE_RE.test(text);
    if (hasFaction) politics++;
    if (hasPlace) placey++;
    if (hasLife) life++;
    per[channel] ??= { n: 0, p: 0, s: 0, l: 0 };
    per[channel].n++;
    if (hasFaction) per[channel].p++;
    if (hasPlace) per[channel].s++;
    if (hasLife) per[channel].l++;

    const tag = `${hasFaction ? 'P' : '·'}${hasPlace ? 'S' : '·'}${hasLife ? 'L' : '·'}`;
    console.log(`${String(i).padStart(2)} ${channel.padEnd(9)} ${tag}  ${lines[0].slice(0, 92)}`);
  }

  const n = texts.length || 1;
  const pc = (x: number) => `${Math.round((x / n) * 100)}%`.padStart(4);
  console.log(`\n[${LABEL}] scenes kept ${texts.length}/${N}`);
  console.log(`  politics (a faction, influence, expansion)  ${String(politics).padStart(2)}  ${pc(politics)}`);
  console.log(`  places   (a station, settlement or signal)  ${String(placey).padStart(2)}  ${pc(placey)}`);
  console.log(`  LIFE     (food, sleep, family, shift, home) ${String(life).padStart(2)}  ${pc(life)}`);
  // ---- REPETITION. The question a 60-scene run exists to answer.
  const nouns = [...factions, ...places, ...seenPilots.map((p) => p.name)];
  const rides = nouns
    .map((nm) => ({ nm, n: texts.filter((t) => airedIn(t, nm)).length }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
  console.log(`
  NOUN DOMINATION — how many of ${texts.length} scenes each name rode`);
  for (const r of rides.slice(0, 10)) {
    const share = Math.round((r.n / texts.length) * 100);
    console.log(`  ${r.nm.slice(0, 34).padEnd(36)}${String(r.n).padStart(3)}  ${String(share).padStart(3)}%  ${'█'.repeat(Math.round(share / 4))}`);
  }
  const worst = rides[0];
  console.log(
    `  distinct names on air: ${rides.length} · worst rider: ${worst ? `${worst.nm} at ${Math.round((worst.n / texts.length) * 100)}%` : 'none'} (bar: under 50%)`,
  );

  // Repeated OPENINGS are the other tell — the model reaching for one shape.
  const opens = new Map<string, number>();
  for (const t of texts) {
    const key = t.split(/\s+/).slice(0, 4).join(' ').toLowerCase();
    opens.set(key, (opens.get(key) ?? 0) + 1);
  }
  const dupOpens = [...opens.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  console.log(`
  repeated first-four-words: ${dupOpens.length}`);
  for (const [k, n] of dupOpens.slice(0, 5)) console.log(`    ${n}×  "${k}"`);

  // And whole lines repeating verbatim, which is the worst case.
  const seenLine = new Map<string, number>();
  for (const t of texts) for (const l of t.split(' | ')) seenLine.set(l, (seenLine.get(l) ?? 0) + 1);
  const dupLines = [...seenLine.entries()].filter(([, n]) => n > 1);
  console.log(`  verbatim repeated lines: ${dupLines.length}`);
  for (const [l, n] of dupLines.slice(0, 3)) console.log(`    ${n}×  "${l.slice(0, 70)}"`);

  console.log(`
  per channel        scenes  politics  places  life`);
  for (const [ch, v] of Object.entries(per)) {
    const q = (x: number) => `${Math.round((x / v.n) * 100)}%`.padStart(6);
    console.log(`  ${ch.padEnd(18)}${String(v.n).padStart(6)}${q(v.p)}${q(v.s)}${q(v.l)}`);
  }
}

void main();
