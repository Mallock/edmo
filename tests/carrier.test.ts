/** Fleet-carrier awareness — the difference between fuel and cargo. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CarrierTracker } from '../src/engine/carrier.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent =>
  ({ timestamp: '2026-07-26T14:11:50Z', ...o }) as unknown as JournalEvent;

// The commander's real carrier, from their journal.
const LOCATION = ev({
  event: 'CarrierLocation', CarrierType: 'FleetCarrier',
  CarrierID: 3712889600, StarSystem: 'Tir', SystemAddress: 48996147307082, BodyID: 6,
});
const TRANSFER = ev({
  event: 'CargoTransfer', Transfers: [{ Type: 'tritium', Count: 104, Direction: 'tocarrier' }],
});

test('no carrier means no carrier context', () => {
  const t = new CarrierTracker();
  assert.equal(t.owned(), false);
  assert.equal(t.contextLine(), null);
  // Someone else's carrier is just a station; only docking is not ownership.
  t.apply(ev({ event: 'Docked', StationName: 'XYZ-123', StationType: 'FleetCarrier', MarketID: 999 }));
  assert.equal(t.owned(), false);
});

test('CarrierLocation proves ownership — the game sends it only for yours', () => {
  const t = new CarrierTracker();
  t.apply(LOCATION);
  assert.equal(t.owned(), true);
  const line = t.contextLine()!;
  assert.match(line, /owns a fleet carrier/);
  assert.match(line, /parked in Tir/);
  assert.match(line, /tritium is its jump fuel/i);
});

test('the callsign is learned by docking at it, matched on MarketID', () => {
  const t = new CarrierTracker();
  t.apply(LOCATION);
  // A different carrier at the same pad must not be adopted as theirs.
  t.apply(ev({ event: 'Docked', StationName: 'AAA-111', StationType: 'FleetCarrier', MarketID: 42 }));
  assert.doesNotMatch(t.contextLine()!, /AAA-111/);
  t.apply(ev({ event: 'Docked', StationName: 'V6W-TTJ', StationType: 'FleetCarrier', MarketID: 3712889600 }));
  assert.match(t.contextLine()!, /fleet carrier V6W-TTJ/);
});

test('tritium moved to the carrier is counted as fuel, not a missed sale', () => {
  // The exact sequence that produced "I recommend selling your Tritium".
  const t = new CarrierTracker();
  t.apply(TRANSFER);
  t.apply(LOCATION);
  const line = t.contextLine()!;
  assert.match(line, /104 t of tritium/);
  assert.match(line, /FUEL for them, not cargo to sell/);
  // A transfer alone proves ownership, before any carrier event arrives.
  const u = new CarrierTracker();
  u.apply(TRANSFER);
  assert.equal(u.owned(), true);
});

test('only tritium counts as fuel, and only toward the carrier', () => {
  const t = new CarrierTracker();
  t.apply(LOCATION);
  t.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'bromellite', Count: 50, Direction: 'tocarrier' }] }));
  t.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'tritium', Count: 30, Direction: 'toship' }] }));
  assert.doesNotMatch(t.contextLine()!, /\d+ t of tritium/);
  t.apply(ev({ event: 'CargoTransfer', Transfers: [{ Type: 'tritium', Count: 30, Direction: 'tocarrier' }] }));
  assert.match(t.contextLine()!, /30 t of tritium/);
});

test('ownership survives a session; the fuel tally does not', () => {
  const t = new CarrierTracker();
  t.apply(LOCATION);
  t.apply(TRANSFER);
  t.resetSession();
  assert.equal(t.owned(), true);
  assert.doesNotMatch(t.contextLine()!, /104/);
  // And it round-trips through storage.
  const u = new CarrierTracker();
  u.load(t.toJSON());
  assert.equal(u.owned(), true);
  assert.match(u.contextLine()!, /parked in Tir/);
});
