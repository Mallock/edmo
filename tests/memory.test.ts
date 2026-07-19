/** CommanderMemory — ledgers, records, replay safety, recall, reflections. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommanderMemory, buildReflectionChat } from '../src/engine/memory.ts';
import { buildGlanceMessages, parseGlanceReply } from '../src/engine/glance.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

const T = (h: number, m = 0): string =>
  `2026-07-19T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

function sessionEvents(): JournalEvent[] {
  return [
    ev({ timestamp: T(8), event: 'LoadGame', Commander: "M'allock", ShipName: 'Iron Maru', Credits: 1_000_000 }),
    ev({ timestamp: T(8, 5), event: 'FSDJump', StarSystem: 'Ratraii', JumpDist: 22.5 }),
    ev({ timestamp: T(8, 10), event: 'MissionCompleted', Faction: 'Colonia Co-operative', Reward: 100_000, LocalisedName: 'Haul A' }),
    ev({ timestamp: T(8, 20), event: 'MissionCompleted', Faction: 'Colonia Co-operative', Reward: 250_000, LocalisedName: 'Haul B' }),
    ev({ timestamp: T(8, 30), event: 'Bounty', TotalReward: 80_000 }),
  ];
}

test('ledgers fold from the journal and a replay never double-counts', () => {
  const m = new CommanderMemory();
  for (const e of sessionEvents()) m.apply(e);
  assert.equal(m.cmdr, "M'allock");
  assert.equal(m.totals.missions, 2);
  assert.equal(m.totals.bounties, 1);
  assert.equal(m.factions['Colonia Co-operative'].done, 2);
  assert.equal(m.systems['Ratraii'].visits, 1);
  // Bootstrap replay of the exact same lines — the watermark makes it a no-op.
  for (const e of sessionEvents()) m.apply(e);
  assert.equal(m.totals.missions, 2);
  assert.equal(m.factions['Colonia Co-operative'].done, 2);
  assert.equal(m.systems['Ratraii'].visits, 1);
});

test('same-second bursts fold fully, yet an exact replay still no-ops', () => {
  // Real journals stamp seconds only — an FSDJump lands in the SAME second as
  // arrival comms. The watermark must not eat the second event of the pair.
  const burst = [
    ev({ timestamp: T(9), event: 'ReceiveText', Channel: 'npc', Message: '$X;', Message_Localised: 'hi' }),
    ev({ timestamp: T(9), event: 'FSDJump', StarSystem: 'Tir', JumpDist: 8.1 }),
    ev({ timestamp: T(9), event: 'Bounty', TotalReward: 5_000 }),
  ];
  const m = new CommanderMemory();
  for (const e of burst) m.apply(e);
  assert.equal(m.totals.jumps, 1);
  assert.equal(m.totals.bounties, 1);
  for (const e of burst) m.apply(e); // replay of the same batch
  assert.equal(m.totals.jumps, 1);
  assert.equal(m.totals.bounties, 1);
  // …and a replay after a persistence round-trip (app restart) too.
  const b = new CommanderMemory();
  b.load(JSON.parse(JSON.stringify(m.toJSON())));
  for (const e of burst) b.apply(e);
  assert.equal(b.totals.jumps, 1);
});

test('work is credited to the ship in use at the time, not the current one', () => {
  const m = new CommanderMemory();
  m.apply(ev({ timestamp: T(8), event: 'LoadGame', Commander: 'X', ShipName: 'rahtari', Ship: 'Type8', Credits: 0 }));
  m.apply(ev({ timestamp: T(9), event: 'MissionCompleted', Faction: 'F', Reward: 100_000 }));
  m.apply(ev({ timestamp: T(9, 30), event: 'MissionCompleted', Faction: 'F', Reward: 100_001 }));
  // Shipyard swap to the mining ship — new Loadout names it.
  m.apply(ev({ timestamp: T(10), event: 'Loadout', ShipName: 'kaivuri', Ship: 'lakonminer' }));
  m.apply(ev({ timestamp: T(11), event: 'Bounty', TotalReward: 50_000 }));
  assert.equal(m.shipName, 'kaivuri');
  assert.equal(m.ships['rahtari'].missions, 2);
  assert.equal(m.ships['rahtari'].bounties, 0);
  assert.equal(m.ships['rahtari'].type, 'Type8');
  assert.equal(m.ships['kaivuri'].bounties, 1);
  assert.equal(m.ships['kaivuri'].missions ?? 0, 0);
  const profile = m.profileLines().join('\n');
  assert.match(profile, /current ship is kaivuri \[lakonminer\]/);
  assert.match(profile, /rahtari \[Type8\] \(2 missions\)/);
});

test('records: first observation seeds silently, beating it announces', () => {
  const m = new CommanderMemory();
  const first = m.apply(ev({ timestamp: T(9), event: 'MissionCompleted', Faction: 'F', Reward: 500_000, LocalisedName: 'Big' }));
  assert.equal(first.filter((e) => e.kind === 'record').length, 0);
  const second = m.apply(ev({ timestamp: T(10), event: 'MissionCompleted', Faction: 'F', Reward: 900_000, LocalisedName: 'Bigger' }));
  const rec = second.find((e) => e.kind === 'record');
  assert.ok(rec, 'beating a known record produces an event');
  assert.match(rec!.text, /900,000 cr/);
});

test('faction milestone fires at the 5th completed contract', () => {
  const m = new CommanderMemory();
  let milestone;
  for (let i = 0; i < 5; i++) {
    const out = m.apply(ev({ timestamp: T(9, i), event: 'MissionCompleted', Faction: 'The Nameless', Reward: 10_000 + i }));
    milestone = out.find((e) => e.kind === 'milestone') ?? milestone;
  }
  assert.ok(milestone, 'milestone at 5 completions');
  assert.match(milestone!.text, /fifth.*The Nameless/);
});

test('session record: beaten only after a full prior session baseline', () => {
  const m = new CommanderMemory();
  m.apply(ev({ timestamp: T(8), event: 'LoadGame', Commander: 'X', Credits: 0 }));
  m.apply(ev({ timestamp: T(9), event: 'MissionCompleted', Faction: 'F', Reward: 300_000 }));
  // New session earns more than the 300k baseline → one announcement, once.
  m.apply(ev({ timestamp: T(12), event: 'LoadGame', Commander: 'X', Credits: 0 }));
  m.apply(ev({ timestamp: T(13), event: 'MissionCompleted', Faction: 'F', Reward: 200_000 }));
  const out = m.apply(ev({ timestamp: T(14), event: 'Bounty', TotalReward: 150_000 }));
  const rec = out.find((e) => e.key.startsWith('record:session'));
  assert.ok(rec, 'session record event fired');
  const again = m.apply(ev({ timestamp: T(15), event: 'Bounty', TotalReward: 10_000 }));
  assert.equal(again.filter((e) => e.key.startsWith('record:session')).length, 0, 'flagged once per session');
});

test('death is remembered and returning after an absence warns — once per day', () => {
  const m = new CommanderMemory();
  m.apply(ev({ timestamp: T(8), event: 'FSDJump', StarSystem: 'Tir', JumpDist: 10 }));
  m.apply(ev({ timestamp: T(9), event: 'Died', KillerName: 'Cmdr Void' }));
  assert.equal(m.systems['Tir'].deaths, 1);
  assert.ok(m.notes.some((n) => n.kind === 'loss' && n.system === 'Tir'));
  m.apply(ev({ timestamp: T(10), event: 'FSDJump', StarSystem: 'Elsewhere', JumpDist: 12 }));
  // Quick hop back (same day) stays silent…
  const quick = m.apply(ev({ timestamp: T(11), event: 'FSDJump', StarSystem: 'Tir', JumpDist: 12 }));
  assert.equal(quick.filter((e) => e.kind === 'returnTo').length, 0);
  m.apply(ev({ timestamp: T(12), event: 'FSDJump', StarSystem: 'Elsewhere', JumpDist: 12 }));
  // …but coming back two days later triggers the warning.
  const later = m.apply(ev({ timestamp: '2026-07-21T10:00:00Z', event: 'FSDJump', StarSystem: 'Tir', JumpDist: 12 }));
  const ret = later.find((e) => e.kind === 'returnTo');
  assert.ok(ret, 'return warning after absence');
  assert.match(ret!.text, /Tir/);
  // Announce gate: first speak passes, an immediate retry is silenced.
  const now = Date.parse('2026-07-21T10:00:30Z');
  assert.equal(m.gateAnnounce(ret!.key, now), true);
  assert.equal(m.gateAnnounce(ret!.key, now + 60_000), false);
});

test('promotion becomes a note and a spoken-candidate event', () => {
  const m = new CommanderMemory();
  const out = m.apply(ev({ timestamp: T(9), event: 'Promotion', Combat: 7 }));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /Deadly \(Combat\)/);
  assert.ok(m.notes.some((n) => /Deadly/.test(n.text)));
});

test('recallForContext surfaces only genuinely notable history', () => {
  const m = new CommanderMemory();
  const now = Date.parse('2026-07-20T00:00:00Z');
  // Two visits, no deaths, unknown faction → nothing worth recalling.
  m.apply(ev({ timestamp: T(8), event: 'FSDJump', StarSystem: 'Quiet', JumpDist: 5 }));
  assert.deepEqual(m.recallForContext({ system: 'Quiet', faction: 'Nobody' }, now), []);
  // A death makes the system memorable; 3 contracts make the faction known.
  m.apply(ev({ timestamp: T(9), event: 'Died' }));
  for (let i = 0; i < 3; i++) {
    m.apply(ev({ timestamp: T(10, i), event: 'MissionCompleted', Faction: 'Colonia Co-operative', Reward: 1000 + i }));
  }
  const lines = m.recallForContext({ system: 'Quiet', faction: 'Colonia Co-operative' }, now);
  assert.ok(lines.some((l) => /lost a ship/.test(l)));
  assert.ok(lines.some((l) => /3 contracts completed for Colonia Co-operative/.test(l)));
  // The commander profile carries lifetime tallies + records into prompts.
  const profile = m.profileLines().join('\n');
  assert.match(profile, /3 contracts completed lifetime/);
  assert.match(profile, /1 ships lost/);
  assert.match(profile, /most work done for Colonia Co-operative \(3\)/);
});

test('reflections: lenient parse, anchoring, and near-duplicate rejection', () => {
  const m = new CommanderMemory();
  m.apply(ev({ timestamp: T(8), event: 'FSDJump', StarSystem: 'Ratraii', JumpDist: 8 }));
  m.apply(ev({ timestamp: T(9), event: 'MissionCompleted', Faction: 'Colonia Co-operative', Reward: 5000 }));
  const raw = `\`\`\`json
{"memories":[
  {"text":"Hull dropped to 12% fighting a Fer-de-Lance at the Ratraii nav beacon.","kind":"close_call","importance":3},
  {"text":"Completed the first contract for Colonia Co-operative.","kind":"relationship","importance":2},
  {"text":"", "kind":"habit", "importance":1}
]}
\`\`\``;
  const kept = m.addReflections(raw, Date.parse('2026-07-19T23:00:00Z'));
  assert.equal(kept, 2, 'empty texts are dropped');
  const anchored = m.notes.find((n) => /Fer-de-Lance/.test(n.text));
  assert.equal(anchored?.system, 'Ratraii');
  assert.equal(m.notes.find((n) => /first contract/.test(n.text))?.faction, 'Colonia Co-operative');
  // Feeding near-identical text again keeps the bank clean.
  const dup = m.addReflections(
    '{"memories":[{"text":"Hull dropped to 12% fighting the Fer-de-Lance at Ratraii nav beacon.","kind":"close_call","importance":3}]}',
    Date.parse('2026-07-20T23:00:00Z'),
  );
  assert.equal(dup, 0);
  assert.equal(m.addReflections('total garbage, no json here', Date.now() * 0 + 1), 0);
});

test('persistence round-trip preserves ledgers, notes and the watermark', () => {
  const a = new CommanderMemory();
  for (const e of sessionEvents()) a.apply(e);
  a.addReflections('{"memories":[{"text":"Set a personal record hauling for Colonia Co-operative.","kind":"record","importance":2}]}', 1000);
  const b = new CommanderMemory();
  b.load(JSON.parse(JSON.stringify(a.toJSON())));
  assert.equal(b.totals.missions, 2);
  assert.equal(b.notes.length, a.notes.length);
  // Watermark survives → replaying the same session into the LOADED bank is a no-op.
  for (const e of sessionEvents()) b.apply(e);
  assert.equal(b.totals.missions, 2);
});

test('reflection prompt carries the digest and prior notes', () => {
  const chat = buildReflectionChat('Session digest: things happened.', "M'allock", ['old note']);
  assert.equal(chat.length, 2);
  assert.match(chat[0].content, /memory-keeper.*M'allock/s);
  assert.match(chat[1].content, /Session digest/);
  assert.match(chat[1].content, /old note/);
});

test('glance: message structure and reply parsing', () => {
  const msgs = buildGlanceMessages('data:image/jpeg;base64,AAA', 'In Ratraii.', "M'allock");
  assert.equal(msgs.length, 2);
  const parts = msgs[1].content as Array<{ type: string }>;
  assert.deepEqual(parts.map((p) => p.type), ['text', 'image_url']);
  const ok = parseGlanceReply('{"activity":"supercruising","notable":false,"remark":""}');
  assert.equal(ok?.activity, 'supercruising');
  assert.equal(ok?.notable, false);
  const fenced = parseGlanceReply('```json\n{"activity":"in combat","notable":true,"remark":"Shields!"}\n```');
  assert.equal(fenced?.notable, true);
  assert.equal(parseGlanceReply('nonsense'), null);
});
