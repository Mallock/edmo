/**
 * The comms writer's briefing.
 *
 * What this file is really guarding is a negative: the dossier must never again
 * become a fence. It is background — things these people live with and have
 * opinions about — and the model is free to invent on top of it. So the tests
 * pin the SHAPE (bounded, carriers counted, never empty) rather than any rule
 * about what may be named, because there is no such rule any more.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDossier } from '../src/engine/chatter/dossier.ts';
import type { SystemIntel } from '../src/engine/types.ts';

const station = (name: string) => ({ name, isStation: true });
const site = (name: string) => ({ name, isStation: false });

const intel = (over: Partial<SystemIntel> = {}): SystemIntel => ({
  security: 'Low Security',
  allegiance: 'Independent',
  government: 'Democracy',
  economy: 'High Tech',
  population: 1_240_000,
  controllingFaction: 'HIP 71462 Council',
  factions: [
    { name: 'HIP 71462 Council', influence: 0.306 },
    { name: 'Explorer on Tour', influence: 0.427, state: 'Expansion' },
    { name: 'Husband Sanctuary', influence: 0.112 },
  ],
  signals: [station('Wood’s Pride'), site('Resource Extraction Site [Hazardous]')],
  ...over,
});

test('the dossier states what kind of place this is', () => {
  const out = buildDossier({ system: 'HIP 71120', intel: intel(), docked: false });
  assert.match(out, /System: HIP 71120/);
  assert.match(out, /Low security/);
  assert.match(out, /Independent/);
  assert.match(out, /Democracy/);
  assert.match(out, /High Tech economy/);
  assert.match(out, /population 1,240,000/);
});

test('plain nav beacons are left out of the comms briefing entirely', () => {
  // Explaining the beacon was not enough: two model families independently
  // elected it as the thing that must malfunction, however boring the note.
  // Same law as carriers being counted, not named — a beacon is scenery in
  // every system and worth nothing to a scene. Compromised beacons ARE a
  // situation and stay; other signals stay annotated.
  const out = buildDossier({
    system: 'HIP 71120',
    intel: intel({
      signals: [
        site('Henry Beacon'),
        { name: 'Unmarked Signal', isStation: false, type: 'NavBeacon' },
        site('Compromised Nav Beacon'),
        site('Resource Extraction Site [Hazardous]'),
      ],
    }),
    docked: false,
  });
  assert.doesNotMatch(out, /Henry Beacon/);
  assert.doesNotMatch(out, /Unmarked Signal/);
  assert.match(out, /Compromised Nav Beacon \(the navigation stop, currently overrun/);
  assert.match(out, /Resource Extraction Site \[Hazardous\] \(ring mining/);
});

test('happiness, pending states and faction government reach the briefing', () => {
  // All three were captured by state.ts from day one and dropped on the
  // floor — and a despondent populace or a war that has not landed yet is
  // better scene material than any influence figure.
  const out = buildDossier({
    system: 'X',
    intel: intel({
      factions: [
        { name: 'HIP 71462 Council', influence: 0.306, government: 'Democracy', happiness: 'Despondent' },
        { name: 'Explorer on Tour', influence: 0.427, state: 'Expansion', government: 'Corporate', pending: ['War'] },
        { name: 'Husband Sanctuary', influence: 0.112, recovering: ['Outbreak'] },
      ],
    }),
    docked: false,
  });
  assert.match(out, /Mood on the ground: .*despondent/);
  assert.match(out, /Coming and going: /);
  assert.match(out, /Explorer on Tour is heading into War|Husband Sanctuary is just out of Outbreak/);
  assert.match(out, /Explorer on Tour \(42\.7%, Expansion, Corporate\)/);
});

test('the dossier explains the state words on its own board', () => {
  const out = buildDossier({ system: 'HIP 71120', intel: intel(), docked: false });
  // Explorer on Tour is in Expansion — the board's states get their meanings.
  assert.match(out, /\(state meanings: Expansion = pushing into a neighbouring system\)/);
  // And a stateless board earns no glossary line.
  const calm = buildDossier({
    system: 'X',
    intel: intel({
      factions: [{ name: 'Quiet Party', influence: 0.5 }],
      factionStates: [],
    }),
    docked: false,
  });
  assert.doesNotMatch(calm, /state meanings/);
});

test('the controlling faction carries its influence share', () => {
  const out = buildDossier({ system: 'HIP 71120', intel: intel(), docked: false });
  assert.match(out, /Runs this system: HIP 71462 Council \(30\.6%\)/);
});

test('the rest of the board is listed strongest first, with states', () => {
  const out = buildDossier({ system: 'HIP 71120', intel: intel(), docked: false });
  const line = out.split('\n').find((l) => l.startsWith('Also here:'))!;
  assert.match(line, /Explorer on Tour \(42\.7%, Expansion\)/);
  assert.ok(
    line.indexOf('Explorer on Tour') < line.indexOf('Husband Sanctuary'),
    'strongest first',
  );
  assert.doesNotMatch(line, /HIP 71462 Council/, 'the controller is not repeated');
});

test('fleet carriers are counted, never named', () => {
  const out = buildDossier({
    system: 'Colonia',
    intel: intel({
      signals: [
        station('Jaques Station'),
        station('THE PILGRIM K7Q-B2L'),
        station('NOMAD X9F-4TZ'),
        station('WANDERER Q2H-11B'),
      ],
    }),
    docked: false,
  });
  assert.match(out, /Stations: Jaques Station/);
  assert.match(out, /Fleet carriers parked here: 3/);
  assert.doesNotMatch(out, /K7Q-B2L/, 'a registration must never reach the model');
  assert.doesNotMatch(out, /NOMAD/);
});

test('long lists are truncated and say how many were dropped', () => {
  const many = Array.from({ length: 9 }, (_, i) => station(`Port ${i}`));
  const out = buildDossier({
    system: 'Busy',
    intel: intel({ signals: many }),
    docked: false,
  });
  const line = out.split('\n').find((l) => l.startsWith('Stations:'))!;
  assert.match(line, /\(\+4 more\)/, '9 stations, cap of 5');
  assert.doesNotMatch(line, /Port 6/);
});

test('signals are listed under their own heading', () => {
  const out = buildDossier({ system: 'HIP 71120', intel: intel(), docked: false });
  assert.match(out, /Signals detected: Resource Extraction Site \[Hazardous\]/);
});

test('duplicate signals are collapsed', () => {
  const out = buildDossier({
    system: 'X',
    intel: intel({ signals: [site('Distress Call'), site('Distress Call'), site('Combat Zone')] }),
    docked: false,
  });
  const line = out.split('\n').find((l) => l.startsWith('Signals detected:'))!;
  assert.equal(line.match(/Distress Call/g)?.length, 1);
});

test('port separation is stated when the commander is out in the system', () => {
  const out = buildDossier({
    system: 'X',
    intel: intel(),
    docked: false,
    portSeparationLs: 957,
  });
  assert.match(out, /Nearest port: 957 ls out/);
});

test('port separation is omitted when docked', () => {
  const out = buildDossier({
    system: 'X',
    intel: intel(),
    docked: true,
    stationName: 'Wood’s Pride',
    portSeparationLs: 957,
  });
  assert.doesNotMatch(out, /Nearest port/);
  assert.match(out, /The commander: docked at Wood’s Pride/);
});

test('where the commander is gives the crew channel something to react to', () => {
  const at = (over: Omit<Parameters<typeof buildDossier>[0], 'system'>) =>
    buildDossier({ system: 'X', intel: intel(), ...over });
  assert.match(at({ docked: false, supercruise: true }), /in supercruise/);
  assert.match(at({ docked: false, onFoot: true }), /on foot/);
  assert.match(at({ docked: false }), /in normal space/);
});

test('an unsurveyed system still says something', () => {
  // Silence here reads to a model as an instruction to name nothing — which is
  // exactly the behaviour this whole approach replaced.
  const out = buildDossier({ system: 'Praea Euq ZW-P d5-1183', docked: false });
  assert.ok(out.trim().length > 0, 'never empty');
  assert.match(out, /unsurveyed/i);
  assert.match(out, /Praea Euq ZW-P d5-1183/);
});

test('brief summaries ride along as extra background', () => {
  const out = buildDossier({
    system: 'X',
    intel: intel(),
    docked: false,
    extra: ['Bertrandite at Hurston Ring down 380', 'atmosphere', ''],
  });
  assert.match(out, /Bertrandite at Hurston Ring down 380/);
  assert.doesNotMatch(out, /^atmosphere$/m, 'the texture placeholder is not a fact');
});

test('scanned worlds reach the briefing as scenery, rotated and factual', () => {
  const worlds = [
    { label: '5 a', planetClass: 'Icy body', moon: true, landable: true, gravityG: 0.08, virgin: true },
    { label: '2', planetClass: 'Sudarsky class III gas giant', ringed: true },
    { label: '3', planetClass: 'High metal content body', volcanism: 'minor silicate vapour geysers volcanism', tempK: 90 },
  ];
  const out = buildDossier({ system: 'X', intel: intel(), docked: false, worlds });
  assert.match(out, /Out the window: /);
  assert.match(out, /5 a — an icy moon, 0\.08 G, nobody has ever set foot there/);
  assert.match(out, /2 — a ringed gas giant/);
  // Rotation brings the third world in on a later scene.
  const later = buildDossier({ system: 'X', intel: intel(), docked: false, worlds, rotate: 2 });
  assert.match(later, /3 — a high-metal world, silicate vapour geysers, 90 K/);
  // No scans, no line.
  const bare = buildDossier({ system: 'X', intel: intel(), docked: false, worlds: [] });
  assert.doesNotMatch(bare, /Out the window/);
});

test('factions ride some scenes, not all — the board is phased by rotation', () => {
  // Live: with every station brake working, one faction still rode nearly
  // every scene, because the board sat in every prompt. Phase 2 carries no
  // faction lines at all; the anchors fall back to places and moods.
  const at = (rotate: number) =>
    buildDossier({ system: 'X', intel: intel(), docked: false, rotate });
  assert.match(at(0), /Runs this system/);
  assert.match(at(0), /Also here/);
  assert.doesNotMatch(at(1), /Runs this system/);
  assert.match(at(1), /Also here/);
  assert.doesNotMatch(at(2), /Runs this system|Also here|Explorer on Tour|Husband Sanctuary/);
});

test('a hot faction cools out of the board like a hot station', () => {
  const aired = Array.from({ length: 6 }, () => 'Explorer on Tour is pushing the expansion again.');
  const out = buildDossier({ system: 'X', intel: intel(), docked: false, rotate: 0, recentAir: aired });
  assert.doesNotMatch(out, /Explorer on Tour/);
  assert.match(out, /Husband Sanctuary/); // the rest of the board survives
});

test('a hot noun also cools matching extras — the spine cannot re-seed it', () => {
  const aired = Array.from({ length: 6 }, () => 'Explorer on Tour again tonight.');
  const out = buildDossier({
    system: 'X', intel: intel(), docked: false, rotate: 0, recentAir: aired,
    extra: ['ONGOING (patron): Explorer on Tour counts the commander a friend', 'Steel is moving'],
  });
  assert.doesNotMatch(out, /counts the commander a friend/);
  assert.match(out, /Steel is moving/);
});

test('the place override tells the scene where the commander really is', () => {
  const out = buildDossier({
    system: 'X', intel: intel(), docked: false,
    place: "on approach to Gcobani's Medicines, the construction site — closer to the build than to any port",
  });
  assert.match(out, /The commander: on approach to Gcobani's Medicines, the construction site/);
});

test('a place that has ridden the air sits the next briefing out', () => {
  // The 40-scene audit measured one station in HALF the air: scenes echo the
  // rolling transcript, so a name the prompt keeps seconding snowballs. Hot
  // names (3 of the last 6 scenes, counting clip forms like "the Gateway")
  // drop out of the briefing until the air clears.
  const sigs = [station('Benyovszky Gateway'), station('Crick Terminal'), site('Distress Call')];
  const aired = (n: number) =>
    Array.from({ length: 6 }, (_, i) =>
      i < n ? 'Traffic is stacking up near the Gateway again tonight.' : 'A quiet stretch of lane.',
    );
  const hotOut = buildDossier({
    system: 'X', intel: intel({ signals: sigs }), docked: false, recentAir: aired(3),
  });
  assert.doesNotMatch(hotOut, /Benyovszky/);
  assert.match(hotOut, /Crick Terminal/);
  // Two mentions is conversation, not a snowball — it stays.
  const warmOut = buildDossier({
    system: 'X', intel: intel({ signals: sigs }), docked: false, recentAir: aired(2),
  });
  assert.match(warmOut, /Benyovszky Gateway/);
  // Cooling never empties a list: if EVERY station is hot, they all stay.
  const allHot = buildDossier({
    system: 'X',
    intel: intel({ signals: [station('Benyovszky Gateway')] }),
    docked: false,
    recentAir: aired(6),
  });
  assert.match(allHot, /Benyovszky Gateway/);
});

test('one extra sits each call out, so no brief rides every prompt', () => {
  const extra = ['Fact alpha', 'Fact beta', 'Fact gamma'];
  const at = (rotate: number) =>
    buildDossier({ system: 'X', intel: intel(), docked: false, extra, rotate });
  for (const fact of extra) {
    const present = [0, 1, 2].filter((r) => at(r).includes(fact)).length;
    assert.ok(present >= 1, `${fact} never shown`);
    assert.ok(present < 3, `${fact} rode every prompt — absence is the rotation that matters`);
  }
});

test('the dossier is bounded however much is known', () => {
  const out = buildDossier({
    system: 'X',
    intel: intel({
      signals: Array.from({ length: 40 }, (_, i) => site(`Signal ${i}`)),
      factions: Array.from({ length: 20 }, (_, i) => ({ name: `Faction ${i}`, influence: i / 100 })),
    }),
    docked: false,
    extra: Array.from({ length: 30 }, (_, i) => `Extra fact ${i}`),
  });
  assert.ok(out.split('\n').length <= 14, `too long: ${out.split('\n').length} lines`);
});

test('the dossier never instructs, only describes', () => {
  const out = buildDossier({ system: 'X', intel: intel(), docked: false });
  assert.doesNotMatch(out, /may not|must not|do not name|only ever/i);
});
