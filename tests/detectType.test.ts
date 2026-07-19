import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBgsState, detectCategory } from '../src/engine/detectType.ts';

// Real internal Name strings observed in the developer's own journals (SPEC §10.A).
const CASES: Array<[string, string]> = [
  ['Mission_Courier_Expansion', 'Courier'],
  ['Mission_Courier', 'Courier'],
  ['Mission_Courier_Democracy', 'Courier'],
  ['Mission_Delivery_Agriculture', 'Delivery'],
  ['Mission_Delivery', 'Delivery'],
  ['Mission_DeliveryWing_Outbreak', 'DeliveryWing'],
  ['Mission_PassengerBulk_MEDICAL_ARRIVING', 'PassengerBulk'],
  ['Mission_PassengerVIP_CEO_EXPANSION', 'PassengerVIP'],
  ['Mission_PassengerVIP', 'PassengerVIP'],
  ['Mission_Sightseeing_Tourist_BOOM', 'Sightseeing'],
  ['Mission_LongDistanceExpedition_Explorer_Boom', 'LongDistanceExpedition'],
  ['Mission_Massacre_Conflict_CivilWar', 'Massacre'],
  ['Mission_Assassinate', 'Assassinate'],
  ['Mission_Assassinate_RankFed', 'Assassinate'],
  ['MISSION_Salvage_Illegal', 'Salvage'], // note the uppercase MISSION_ prefix
  ['MISSION_Salvage_Refinery', 'Salvage'],
  ['Mission_Collect_Bust', 'Collect'],
  ['Mission_Mining_Expansion', 'Mining'],
  ['Mission_Rescue_Planet', 'Rescue'],
  ['Mission_TotallyUnknownType', 'Other'],
];

test('detectCategory maps the real ED taxonomy', () => {
  for (const [name, expected] of CASES) {
    assert.equal(detectCategory(name), expected, `${name} -> ${expected}`);
  }
});

test('detectCategory is case-insensitive to the prefix', () => {
  assert.equal(detectCategory('mission_courier_expansion'), 'Courier');
  assert.equal(detectCategory('MISSION_SALVAGE_ILLEGAL'), 'Salvage');
});

test('detectBgsState parses the background-sim modifier', () => {
  assert.equal(detectBgsState('Mission_Courier_Expansion'), 'Expansion');
  assert.equal(detectBgsState('Mission_Massacre_Conflict_CivilWar'), 'CivilWar');
  assert.equal(detectBgsState('Mission_PassengerVIP_Tourist_ELECTION'), 'Election');
  assert.equal(detectBgsState('Mission_Assassinate'), undefined);
});
