/** CommanderMemory — ledgers, records, replay safety, recall, reflections. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommanderMemory, buildReflectionChat } from '../src/engine/memory.ts';
import {
  buildCommentaryMessages,
  buildGlanceMessages,
  buildSceneDescriptionMessages,
  parseGlanceReply,
  parseSceneDescription,
  renderSceneForOperator,
  suppressRoutineCoaching,
  suppressUngroundedFuelConcern,
} from '../src/engine/glance.ts';
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
  const msgs = buildGlanceMessages(
    'data:image/jpeg;base64,AAA',
    'In Tir. Selected navigation target: Dohler Depot. The commander is travelling toward it in supercruise, not docked there.',
    "M'allock",
  );
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content as string, /distance and arrival timer/);
  assert.match(msgs[0].content as string, /approaching \[name\]/);
  const parts = msgs[1].content as Array<{ type: string }>;
  assert.deepEqual(parts.map((p) => p.type), ['text', 'image_url']);
  assert.match((msgs[1].content as Array<{ text?: string }>)[0].text!, /Dohler Depot/);
  const ok = parseGlanceReply('{"activity":"supercruising","notable":false,"remark":""}');
  assert.equal(ok?.activity, 'supercruising');
  assert.equal(ok?.notable, false);
  const fenced = parseGlanceReply('```json\n{"activity":"in combat","notable":true,"remark":"Shields!"}\n```');
  assert.equal(fenced?.notable, true);
  assert.equal(parseGlanceReply('nonsense'), null);
});

test('commentary: copilot prompt carries session facts, image, and the NOT_IN_GAME escape', () => {
  const msgs = buildCommentaryMessages(
    'data:image/jpeg;base64,AAA',
    'Commander is at Berman Market, Alberta (docked).\n- Delivery "Semis" → Colonia Orbital, Colonia',
    "M'allock",
  );
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content as string, /Commander M'allock/);
  assert.match(msgs[0].content as string, /NOT_IN_GAME/);
  assert.match(msgs[0].content as string, /STRICT grounding/);
  assert.match(msgs[0].content as string, /Only warn about fuel.*below 25%/);
  assert.match(msgs[0].content as string, /travelling.*named station/);
  assert.match(msgs[0].content as string, /35 words maximum/);
  assert.match(msgs[0].content as string, /NO_BEAT/);
  assert.match(msgs[0].content as string, /ASTEROID FIELD/);
  assert.match(msgs[0].content as string, /no rhetorical questions/);
  const parts = msgs[1].content as Array<{ type: string; text?: string }>;
  assert.deepEqual(parts.map((p) => p.type), ['text', 'image_url']);
  assert.match(parts[0].text!, /Berman Market/);
  // Default angle is the view; other angles swap the register instruction.
  assert.match(parts[0].text!, /THE VIEW/);
  const travel = buildCommentaryMessages(
    'data:image/jpeg;base64,AAA',
    'facts',
    undefined,
    'travel',
    ['Looks like we are making good speed. Keep an eye on the fuel.'],
  );
  const travelText = (travel[1].content as Array<{ text?: string }>)[0].text!;
  assert.match(travelText, /THE JOURNEY/);
  assert.doesNotMatch(travelText, /THE VIEW/);
  assert.match(travelText, /Do not turn.*fuel advice/);
  assert.match(travelText, /Match this cadence/);
  assert.match(travelText, /crew call, never an instruction/);
  assert.match(travelText, /RECENT COMMS/);
  assert.match(travelText, /making good speed/);
  const mission = buildCommentaryMessages('data:image/jpeg;base64,AAA', 'facts', undefined, 'mission');
  assert.match((mission[1].content as Array<{ text?: string }>)[0].text!, /THE JOB/);
});

test('scene reading: describe prompt carries the image and the ignore-overlay rule', () => {
  const msgs = buildSceneDescriptionMessages('data:image/jpeg;base64,AAA', "M'allock");
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content as string, /vision sensor/);
  assert.match(msgs[0].content as string, /IGNORE the dark "MISSION OPERATOR" overlay/);
  assert.match(msgs[0].content as string, /not-game/);
  const parts = msgs[1].content as Array<{ type: string; text?: string }>;
  assert.deepEqual(parts.map((p) => p.type), ['text', 'image_url']);
  assert.match(parts[0].text!, /Commander M'allock's screen/);
});

test('scene reading: parses structured JSON and drops empty husks', () => {
  const scene = parseSceneDescription(
    '{"screen":"cockpit-flight","view":"a ringed gas giant below","target":"Dohler Depot",' +
      '"hud_text":["Dohler Depot","0:47","142 Ls"],"hazards":[],"summary":"Supercruising toward Dohler Depot."}',
  );
  assert.equal(scene?.screen, 'cockpit-flight');
  assert.equal(scene?.target, 'Dohler Depot');
  assert.deepEqual(scene?.hudText, ['Dohler Depot', '0:47', '142 Ls']);
  assert.deepEqual(scene?.hazards, []);
  const fenced = parseSceneDescription(
    '```json\n{"screen":"station-menu","view":"","target":"","hud_text":[],"hazards":[],"summary":"Station services."}\n```',
  );
  assert.equal(fenced?.screen, 'station-menu');
  // A parsed-but-empty husk is worse than the image itself → null (fall back).
  assert.equal(
    parseSceneDescription('{"screen":"other","view":"","target":"","hud_text":[],"hazards":[],"summary":""}'),
    null,
  );
  assert.equal(parseSceneDescription('not json'), null);
});

test('scene reading: renders a compact operator-facing block', () => {
  const text = renderSceneForOperator({
    screen: 'cockpit-flight',
    view: 'a ringed gas giant below',
    target: 'Dohler Depot',
    hudText: ['Dohler Depot', '0:47'],
    hazards: [],
    summary: 'Supercruising toward Dohler Depot.',
  });
  assert.match(text, /SCREEN READING/);
  assert.match(text, /In view: a ringed gas giant below/);
  assert.match(text, /Selected target on screen: Dohler Depot/);
  assert.match(text, /"Dohler Depot", "0:47"/);
  assert.match(text, /Visible hazards: none apparent/);
});

test('scene-grounded stage 2 is text-only and carries the reading', () => {
  const reading = renderSceneForOperator({
    screen: 'cockpit-flight',
    view: 'a ringed gas giant below',
    target: 'Dohler Depot',
    hudText: ['0:47'],
    hazards: [],
    summary: 'Supercruising toward Dohler Depot.',
  });
  // Commentary: with a reading, the user turn is a plain string (no image part).
  const comm = buildCommentaryMessages('data:image/jpeg;base64,AAA', 'facts', "M'allock", 'view', [], reading);
  assert.equal(typeof comm[1].content, 'string');
  assert.match(comm[1].content as string, /SCREEN READING/);
  assert.match(comm[1].content as string, /Work from the screen reading above/);
  assert.match(comm[1].content as string, /THE VIEW/);
  // Verdict glance: same — text-only, reading embedded, JSON verdict still asked.
  const verdict = buildGlanceMessages('data:image/jpeg;base64,AAA', 'context line', "M'allock", reading);
  assert.equal(typeof verdict[1].content, 'string');
  assert.match(verdict[1].content as string, /Dohler Depot/);
  assert.match(verdict[1].content as string, /context line/);
  // Without a reading, both keep the original image content-part shape.
  const noScene = buildCommentaryMessages('data:image/jpeg;base64,AAA', 'facts');
  assert.ok(Array.isArray(noScene[1].content));
});

test('vision commentary suppresses fuel concern contradicted by healthy telemetry', () => {
  const nag =
    "Look at that ring filling the view; it's a hell of a sight. Keep an eye on the jump capacity — we don't want to run dry. The fuel gauge needs watching out here.";
  const grounded = suppressUngroundedFuelConcern(nag, 0.81);
  assert.equal(grounded, "Look at that ring filling the view; it's a hell of a sight.");
  assert.equal(suppressUngroundedFuelConcern(nag, 0.2), nag);
  assert.equal(suppressUngroundedFuelConcern(nag, 0.81, true), nag);
  assert.equal(suppressUngroundedFuelConcern('Fuel is at 81%; plenty for this leg.', 0.81), 'Fuel is at 81%; plenty for this leg.');
});

test('vision commentary keeps observations but drops routine coaching and speculation', () => {
  assert.equal(
    suppressRoutineCoaching(
      'Fort Mug, 0:13. Thirty-six passengers behind us; keep an eye on that moonscape as we approach.',
    ),
    'Fort Mug, 0:13. Thirty-six passengers behind us.',
  );
  assert.equal(
    suppressRoutineCoaching('Prospector depleted. We are going to get enough raw materials for the refit.'),
    'Prospector depleted.',
  );
  assert.equal(
    suppressRoutineCoaching('Impact warning—pull up now.', true),
    'Impact warning—pull up now.',
  );
  assert.equal(
    suppressRoutineCoaching("Fort Mug, 0:13. Thirty-six passengers behind us? Let's make this arrival boring."),
    "Fort Mug, 0:13. Thirty-six passengers behind us—let's make this arrival boring.",
  );
});
