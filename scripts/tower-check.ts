/**
 * What does the tower actually say to the commander?
 *
 * The live complaint was specific: the tower hailed a ship in open space,
 * talked about somebody else's business, signed itself with a person's name,
 * and named a pad the game had not assigned — "Pad Four" while the clearance
 * was pad 3. This drives the real prompt for each of the tower's moments and
 * checks the two things that actually matter:
 *
 *   * it addresses the commander, not a third party
 *   * the pad it says is the pad it was given, or no pad at all
 *
 *   npx tsx scripts/tower-check.ts --port 51999 --key probe
 */
import { buildSceneChat, acceptSceneReply, type SceneRequest } from '../src/engine/chatter/llm.ts';
import { towerBrief } from '../src/engine/chatter/briefs.ts';

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PORT = arg('port', '51999');
const KEY = arg('key', 'probe');

const SHIP = 'Stardust Runner';
const STATION = 'Orbital Construction Site: Corman Beacon';
const SYSTEM = 'HIP 71120';
const PAD = 3;

const DOSSIER = `System: ${SYSTEM} — Low security, Independent, Refinery economy, population 38,452,204
Stations: Benyovszky Gateway · Mikels Town · Dickens Point
The commander: on final approach to ${STATION}
${STATION}: 7 visits before this one, the last within the hour`;

interface Case {
  label: string;
  moment: 'granted' | 'denied' | 'departure';
  pad: number | null;
  reason: string | null;
  situation: string;
}

const CASES: Case[] = [
  {
    label: 'CLEARED TO DOCK',
    moment: 'granted',
    pad: PAD,
    reason: null,
    situation: `${STATION} tower clearing this ship to land on pad ${PAD}`,
  },
  {
    label: 'REFUSED',
    moment: 'denied',
    pad: null,
    reason: 'the owner has not invited you',
    situation: `${STATION} tower refusing this ship permission to dock — the owner has not invited you`,
  },
  {
    label: 'DEPARTURE',
    moment: 'departure',
    pad: null,
    reason: null,
    situation: `${STATION} tower signing this ship off as it leaves`,
  },
];

async function run(c: Case, i: number) {
  const req: SceneRequest = {
    channel: 'TOWER',
    func: 'establish',
    act: 'BUILDING',
    brief: towerBrief({
      station: STATION,
      system: SYSTEM,
      ship: SHIP,
      pad: c.pad,
      moment: c.moment,
      reason: c.reason,
    }),
    speakers: ['tower'],
    speakerNames: { tower: `${STATION} Tower` },
    situation: c.situation,
    dossier: DOSSIER,
    rotate: i * 5,
    lines: 1,
  };

  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      messages: buildSceneChat(req, []),
      temperature: 0.85,
      max_tokens: 400,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = j.choices?.[0]?.message?.content ?? '';
  const out = acceptSceneReply(raw, req, `tower:${i}`, 60_000);

  console.log('='.repeat(74));
  console.log(`${c.label} — pad given: ${c.pad ?? '(none)'}`);
  console.log('='.repeat(74));
  if (!out.ok) {
    console.log(`  (dropped: ${out.why})   raw: ${raw.slice(0, 90)}`);
    return;
  }
  const text = out.scene.turns.map((t) => t.text).join(' ');
  for (const t of out.scene.turns) console.log(`  » ${t.text}`);

  // Does it talk TO the commander?
  const addressed = new RegExp(`${SHIP}|commander`, 'i').test(text);
  // Any pad number that is not the one we gave it is invented.
  const pads = [...text.matchAll(/\bpad\s+(\w+)\b/gi)].map((m) => m[1].toLowerCase());
  const WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const said = pads.map((p) => (WORDS[p] ?? Number(p))).filter((n) => Number.isFinite(n));
  const wrongPad = said.some((n) => n !== c.pad);
  console.log(
    `    addresses the commander: ${addressed ? 'yes' : 'NO'}` +
      ` · pads mentioned: ${said.length ? said.join(', ') : 'none'}` +
      `${wrongPad ? '  ← INVENTED' : ''}`,
  );
}

for (const [i, c] of CASES.entries()) await run(c, i);
