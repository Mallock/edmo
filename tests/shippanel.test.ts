/** The no-mission ship readout: free hold, tank, and what is at risk. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShipPanel, hullName, type ShipPanelInput } from '../src/engine/shippanel.ts';
import type { ShipLoadout } from '../src/engine/ship.ts';

// The commander's real Type-8.
const RAHTARI: ShipLoadout = {
  ship: 'type8', shipName: 'rahtari', shipIdent: 'MA-26T', maxJumpRange: 30.1,
  cargoCapacity: 400, fuelCapacity: 16, rebuy: 12_400_000,
  cabins: { economy: 0, business: 0, first: 0, luxury: 0, total: 0 },
  hasFuelScoop: true, hasRefinery: true, hasCollectorLimpet: true, hasProspectorLimpet: true,
  hasShieldGenerator: true, hasFsdInterdictor: false, hasSurfaceScanner: true,
};
const base: ShipPanelInput = {
  ship: RAHTARI, liveCargo: 26, fuelPct: 0.86, hullHealth: 1,
  unsoldBio: 0, unsoldCartoValue: 0, carrier: null, session: null,
};

test('hull ids become names a commander would say', () => {
  assert.equal(hullName('type8'), 'Type-8 Transporter');
  assert.equal(hullName('federation_corvette'), 'Federal Corvette');
  assert.equal(hullName('panthermkii'), 'Panther Clipper Mk II');
  // An id we have never seen is tidied, never dropped or faked.
  assert.equal(hullName('brand_new_hull'), 'Brand New Hull');
  assert.equal(hullName(undefined), 'Unknown hull');
});

test('the cargo gauge leads with FREE space, which is the number being looked for', () => {
  const [cargo] = buildShipPanel(base).gauges;
  assert.equal(cargo.label, 'CARGO');
  assert.equal(cargo.text, '374 t free · 26/400 t');
  assert.equal(cargo.warn, false);
  // A full hold is worth flagging — it is why a run cannot be taken.
  const full = buildShipPanel({ ...base, liveCargo: 400 }).gauges[0];
  assert.equal(full.text, '0 t free · 400/400 t');
  assert.equal(full.warn, true);
});

test('an unknown hold reads as empty rather than as unknown tonnage', () => {
  // Cargo.json has not been seen yet; 400 free is the truthful default.
  assert.match(buildShipPanel({ ...base, liveCargo: null }).gauges[0].text, /400 t free/);
});

test('fuel is shown in tons when the tank size is known, and warns when low', () => {
  assert.equal(buildShipPanel(base).gauges[1].text, '13.8/16 t');
  assert.equal(buildShipPanel(base).gauges[1].warn, false);
  assert.equal(buildShipPanel({ ...base, fuelPct: 0.2 }).gauges[1].warn, true);
  // No loadout means no tank size, so fall back to the percentage.
  const noShip = buildShipPanel({ ...base, ship: { ...RAHTARI, fuelCapacity: undefined } });
  assert.equal(noShip.gauges[1].text, '86%');
});

test('an undamaged hull is not given a gauge; a damaged one is', () => {
  assert.equal(buildShipPanel(base).gauges.some((g) => g.label === 'HULL'), false);
  const hurt = buildShipPanel({ ...base, hullHealth: 0.55 }).gauges.find((g) => g.label === 'HULL')!;
  assert.equal(hurt.text, '55%');
  assert.equal(hurt.warn, true);
});

test('unbanked value aboard is called out — no rebuy brings it back', () => {
  const p = buildShipPanel({ ...base, unsoldBio: 3, unsoldCartoValue: 1_240_000 });
  assert.match(p.atRisk!, /3 bio samples/);
  assert.match(p.atRisk!, /~1\.2M cr of survey data/);
  // One sample reads as one sample.
  assert.match(buildShipPanel({ ...base, unsoldBio: 1 }).atRisk!, /1 bio sample /);
  // Loose change is not worth a warning line.
  assert.equal(buildShipPanel({ ...base, unsoldCartoValue: 40_000 }).atRisk, null);
  assert.equal(buildShipPanel(base).atRisk, null);
});

test('with no loadout yet the panel explains itself instead of rendering blank', () => {
  const p = buildShipPanel({ ...base, ship: null, fuelPct: null });
  assert.equal(p.title, 'Ship unknown');
  assert.deepEqual(p.gauges, []);
  assert.match(p.hint!, /Board your ship/);
});

test('facts appear only when they are known', () => {
  const p = buildShipPanel({
    ...base, carrier: 'V6W-TTJ · Tir',
    session: { jumps: 8, distanceLy: 149.7, earned: 75_128_500 },
  });
  const by = Object.fromEntries(p.facts.map((f) => [f.label, f.value]));
  assert.equal(by.JUMP, '30.1 ly');
  assert.equal(by.REBUY, '12.4M cr');
  assert.equal(by.CARRIER, 'V6W-TTJ · Tir');
  assert.match(by.SESSION, /8 jumps · 150 ly · \+75\.1M cr/);
  // No carrier, no line about one; a fresh session adds no noise either.
  const bare = buildShipPanel({ ...base, session: { jumps: 0, distanceLy: 0, earned: 0 } });
  assert.equal(bare.facts.some((f) => f.label === 'CARRIER'), false);
  assert.equal(bare.facts.some((f) => f.label === 'SESSION'), false);
  assert.equal(bare.facts.some((f) => f.label === 'SEATS'), false);
});
