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
    intel: intel({ signals: [site('Nav Beacon'), site('Nav Beacon'), site('Combat Zone')] }),
    docked: false,
  });
  const line = out.split('\n').find((l) => l.startsWith('Signals detected:'))!;
  assert.equal(line.match(/Nav Beacon/g)?.length, 1);
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
