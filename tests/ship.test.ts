/** ShipTracker / Loadout parsing — jump range, cabins, fittings, fit checks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLoadout,
  fitNote,
  describeShip,
  ShipTracker,
  shipRequiresLargePad,
} from '../src/engine/ship.ts';
import type { JournalEvent, Mission } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

function mission(partial: Partial<Mission>): Mission {
  return {
    id: 1,
    internalName: 'Mission_X',
    title: 'X',
    category: 'Courier',
    reward: 1000,
    wing: false,
    expiry: null,
    acceptedAt: '2026-07-20T12:00:00Z',
    steps: [],
    state: 'ACTIVE',
    redirected: false,
    killProgress: 0,
    raw: { timestamp: '', event: 'MissionAccepted' },
    ...partial,
  } as Mission;
}

const LOADOUT = ev({
  event: 'Loadout',
  Ship: 'dolphin',
  ShipName: 'Sea Breeze',
  MaxJumpRange: 32.4,
  CargoCapacity: 16,
  FuelCapacity: { Main: 16, Reserve: 0.5 },
  Rebuy: 250000,
  Modules: [
    { Slot: 'Slot1_Size6', Item: 'Int_PassengerCabin_Size6_Class1' }, // Economy 32
    { Slot: 'Slot2_Size4', Item: 'Int_PassengerCabin_Size4_Class3' }, // First 3
    { Slot: 'Slot3_Size3', Item: 'Int_CargoRack_Size3_Class1' },
    { Slot: 'Slot4_Size4', Item: 'int_fuelscoop_size4_class5' },
    { Slot: 'Slot5_Size1', Item: 'int_refinery_size1_class1' },
    { Slot: 'Slot6_Size3', Item: 'int_dronecontrol_collection_size3_class5' },
    { Slot: 'ShipCockpit', Item: 'dolphin_cockpit' },
  ],
});

test('parseLoadout sums cabin seats by class and reads fittings', () => {
  const s = parseLoadout(LOADOUT);
  assert.equal(s.maxJumpRange, 32.4);
  assert.equal(s.cargoCapacity, 16);
  assert.equal(s.fuelCapacity, 16);
  assert.equal(s.cabins.economy, 32);
  assert.equal(s.cabins.first, 3);
  assert.equal(s.cabins.total, 35);
  assert.equal(s.hasFuelScoop, true);
  assert.equal(s.hasRefinery, true);
  assert.equal(s.hasCollectorLimpet, true);
  assert.equal(s.hasProspectorLimpet, false); // no prospector controller fitted
});

test('fitNote flags cargo that will not fit in one run', () => {
  const s = parseLoadout(LOADOUT);
  const m = mission({
    category: 'Delivery',
    commodity: { name: 'gold', localised: 'Gold', count: 40 },
  });
  const note = fitNote(m, s)!;
  assert.match(note, /needs 40 t but the hold is only 16 t/);
});

test('fitNote flags too few passenger seats at the required class', () => {
  const s = parseLoadout(LOADOUT);
  // 100 economy passengers > 35 seats.
  const bulk = mission({ category: 'PassengerBulk', passengers: { count: 100, type: 'Tourists', vip: false, wanted: false } });
  assert.match(fitNote(bulk, s)!, /needs 100 seats but only 35 are fitted/);

  // VIPs need First-or-better: only 3 First + luxury(0) = 3 qualifying seats.
  const vip = mission({ category: 'PassengerVIP', passengers: { count: 8, type: 'CEO', vip: true, wanted: false } });
  assert.match(fitNote(vip, s)!, /needs 8 First-class or better seats but only 3 are fitted/);
});

test('fitNote warns when not rigged to mine', () => {
  const noProspector = parseLoadout(LOADOUT); // has refinery, no prospector
  const m = mission({ category: 'Mining', commodity: { name: 'painite', localised: 'Painite', count: 20 } });
  assert.match(fitNote(m, noProspector)!, /missing a prospector limpet controller/);
});

test('fitNote is quiet when everything fits', () => {
  const s = parseLoadout(LOADOUT);
  const m = mission({ category: 'Delivery', commodity: { name: 'gold', localised: 'Gold', count: 10 } });
  assert.equal(fitNote(m, s), null);
});

test('describeShip reads like an operator line', () => {
  const line = describeShip(parseLoadout(LOADOUT));
  assert.match(line, /Sea Breeze/);
  assert.match(line, /max jump 32.4 ly/);
  assert.match(line, /35 passenger seats/);
});

test('ShipTracker folds Loadout and uses live cargo for free space', () => {
  const t = new ShipTracker();
  t.apply(LOADOUT);
  t.setCargo(12); // 12/16 t used → 4 t free
  const m = mission({ category: 'Delivery', commodity: { name: 'gold', localised: 'Gold', count: 10 } });
  assert.match(t.fitNote(m)!, /only 4 t is free/);
});

test('shipRequiresLargePad flags large hulls, clears medium/small and unknowns', () => {
  // Large-pad roster — must require a large pad so routes skip medium stops.
  for (const s of ['Cutter', 'anaconda', 'federation_corvette', 'type9', 'type9_military', 'empire_trader', 'belugaliner', 'orca', 'panther_clipper']) {
    assert.equal(shipRequiresLargePad(s), true, `${s} should need a large pad`);
  }
  // Panther Clipper matched loosely in case the id carries a suffix.
  assert.equal(shipRequiresLargePad('Panther_Clipper_MkII'), true);
  // Medium/small hulls and unknown/missing must NOT over-constrain the planner.
  for (const s of ['python', 'krait_mkii', 'asp', 'federation_gunship', 'cobramkiii', undefined, '']) {
    assert.equal(shipRequiresLargePad(s), false, `${s} should not need a large pad`);
  }
});
