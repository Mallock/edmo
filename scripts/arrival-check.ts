/**
 * What does traffic control actually SAY when the ship comes back?
 *
 * The port memory is only worth having if the writer does something with it,
 * and that cannot be settled by reading the briefing. This builds real arrival
 * scenes at four real ports from the commander's own history — a first-timer,
 * somewhere they were an hour ago, a place they have docked at three hundred
 * times, and a haunt they have not seen in a year — and prints what comes back.
 *
 *   npx tsx scripts/arrival-check.ts --port 51999 --key probe
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MissionStateManager } from '../src/engine/state.ts';
import { buildDossier } from '../src/engine/chatter/dossier.ts';
import { buildSceneChat, acceptSceneReply, type SceneRequest } from '../src/engine/chatter/llm.ts';
import { textureBrief } from '../src/engine/chatter/brief.ts';
import { PortMemory, portGreeting, portLedger, carrierTravels } from '../src/engine/ports.ts';
import type { SystemIntel } from '../src/engine/types.ts';

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PORT = arg('port', '51999');
const KEY = arg('key', 'probe');
const DIR = join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous');

// ---- replay the real history, exactly as the store now folds it
const mem = new PortMemory();
const sm = new MissionStateManager();
let where: string | null = null;
let intel: SystemIntel | null = null;
for (const f of readdirSync(DIR).filter((x) => /^Journal\..*\.log$/.test(x)).sort()) {
  let text: string;
  try {
    text = readFileSync(join(DIR, f), 'utf8');
  } catch {
    continue;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
      sm.apply(e);
    } catch {
      continue;
    }
    const st = sm.getState();
    if (st.location.system === 'HIP 71120' && st.system?.signals?.length) {
      intel = JSON.parse(JSON.stringify(st.system)) as SystemIntel;
    }
    if (e.event === 'MarketBuy')
      mem.note(where, { bought: (e.Count as number) ?? 0, commodity: (e.Type_Localised as string) ?? null });
    else if (e.event === 'MarketSell')
      mem.note(where, {
        sold: (e.Count as number) ?? 0,
        credits: (e.TotalSale as number) ?? 0,
        commodity: (e.Type_Localised as string) ?? null,
      });
    else if (e.event === 'MissionAccepted') mem.note(where, { missionTaken: true });
    else if (e.event === 'MissionCompleted')
      mem.note(where, { missionDone: true, credits: (e.Reward as number) ?? 0 });
    else if (e.event === 'Undocked') where = null;
    else if (e.event === 'Docked' && e.StationName) {
      mem.dock({
        name: e.StationName as string,
        system: (e.StarSystem as string) ?? 'unknown',
        type: (e.StationType as string) ?? null,
        faction: (e.StationFaction as { Name?: string } | undefined)?.Name ?? null,
        economy: (e.StationEconomy_Localised as string) ?? null,
        atIso: (e.timestamp as string) ?? '',
      });
      where = e.StationName as string;
    }
  }
}

const now = Date.now();
const pick = (name: string) => mem.get(name);
const CASES: Array<{ label: string; name: string; rec: ReturnType<typeof pick> }> = [
  { label: 'NEVER BEEN', name: 'Kaufman Terminal', rec: null },
  { label: 'THE HOME PORT', name: 'Niinimäki', rec: pick('Niinimäki') },
  { label: 'THE CARRIER', name: 'V6W-TTJ', rec: pick('V6W-TTJ') },
  { label: 'LAPSED HAUNT', name: 'The Forge Of Vulcan', rec: pick('The Forge Of Vulcan') },
];

async function scene(label: string, name: string, rec: ReturnType<typeof pick>, i: number) {
  const extra = [
    portGreeting(rec, now, name),
    carrierTravels(rec),
    portLedger(rec),
  ].filter((x): x is string => !!x);

  const dossier = buildDossier({
    system: 'HIP 71120',
    intel: intel ?? undefined,
    docked: true,
    stationName: name,
    rotate: i,
    extra,
  });
  const req: SceneRequest = {
    channel: 'STATION',
    func: 'establish',
    act: 'BUILDING',
    brief: textureBrief(`arrive:${i}`),
    speakers: ['control', 'ship'],
    speakerNames: { control: `${name} Control`, ship: 'Inbound Traffic' },
    situation: 'a ship docking that the port has a long history with',
    dossier,
    rotate: i,
    lines: 3,
  };

  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      messages: buildSceneChat(req, []),
      temperature: 0.9,
      max_tokens: 700,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const out = acceptSceneReply(j.choices?.[0]?.message?.content ?? '', req, `a:${i}`, 60_000);

  console.log('='.repeat(74));
  console.log(`${label} — ${name}`);
  console.log('='.repeat(74));
  for (const line of extra) console.log(`  [on file] ${line}`);
  console.log();
  if (!out.ok) {
    console.log(`  (dropped: ${out.why})`);
    return;
  }
  for (const t of out.scene.turns) {
    console.log(`  ${(req.speakerNames[t.speakerRef] ?? t.speakerRef).padEnd(24)} ${t.text}`);
  }
  console.log();
}

for (const [i, c] of CASES.entries()) await scene(c.label, c.name, c.rec, i);
