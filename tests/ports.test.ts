/**
 * The visit history behind the welcome.
 *
 * The reference implementation greets every arrival with the same fixed
 * "Welcome back, Commander" — identical for a first-timer and for somebody on
 * their two-hundredth docking. These tests pin the thing that makes ours
 * different: the greeting is a statement of fact drawn from the journal, so a
 * first arrival cannot be greeted as a homecoming.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PortMemory,
  portGreeting,
  justHere,
  carrierTravels,
  portLedger,
  type PortRecord,
} from '../src/engine/ports.ts';

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse('2026-08-01T12:00:00Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;

test('a port counts visits and remembers when it last saw the ship', () => {
  const m = new PortMemory();
  m.dock({ name: 'Benyovszky Gateway', system: 'HIP 71120', type: 'Coriolis', atIso: iso(T0) });
  m.dock({ name: 'Benyovszky Gateway', system: 'HIP 71120', type: 'Coriolis', atIso: iso(T0 + DAY) });
  const rec = m.get('benyovszky gateway');
  assert.equal(rec?.visits, 2);
  assert.equal(rec?.firstAtIso, iso(T0));
  assert.equal(rec?.lastAtIso, iso(T0 + DAY));
  // Lookup is case-insensitive; the journal is not consistent about it.
  assert.equal(m.get('BENYOVSZKY GATEWAY')?.visits, 2);
});

test('a first arrival is never greeted as a homecoming', () => {
  // The whole point. EDCoPilot says "Welcome back, Commander" to a stranger.
  const greet = portGreeting(null, T0, 'Heisenberg Depot');
  assert.match(greet, /never docked here before/);
  assert.doesNotMatch(greet, /back|again|regular/i);
});

test('the greeting states the count and the gap, and leaves the tone open', () => {
  const m = new PortMemory();
  for (let i = 0; i < 14; i++) {
    m.dock({ name: 'Mikels Town', system: 'HIP 71120', type: 'Outpost', atIso: iso(T0 + i * DAY) });
  }
  const rec = m.get('Mikels Town')!;
  const greet = portGreeting(rec, T0 + 13 * DAY + 2 * HOUR, 'Mikels Town');
  assert.match(greet, /regular/);
  assert.match(greet, /14 visits/);
  assert.match(greet, /hours ago/);

  // A single prior visit reads as exactly that, not as a habit.
  const once = new PortMemory();
  once.dock({ name: 'Joy Vista', system: 'HIP 71120', type: 'Outpost', atIso: iso(T0) });
  const line = portGreeting(once.get('Joy Vista'), T0 + 3 * DAY, 'Joy Vista');
  assert.match(line, /once before/);
  assert.match(line, /3 days ago/);
});

test('justHere is true only inside a day and a half', () => {
  const rec = { lastAtIso: iso(T0) } as PortRecord;
  assert.equal(justHere(rec, T0 + 2 * HOUR), true);
  assert.equal(justHere(rec, T0 + 5 * DAY), false);
  assert.equal(justHere(null, T0), false);
});

test('a carrier is a place that moves, and its record follows it', () => {
  const m = new PortMemory();
  m.dock({ name: 'V6W-TTJ', system: 'HIP 71120', type: 'FleetCarrier', atIso: iso(T0) });
  m.dock({ name: 'V6W-TTJ', system: 'Colonia', type: 'FleetCarrier', atIso: iso(T0 + DAY) });
  m.dock({ name: 'V6W-TTJ', system: 'Sol', type: 'FleetCarrier', atIso: iso(T0 + 2 * DAY) });
  const rec = m.get('V6W-TTJ')!;
  assert.equal(rec.carrier, true);
  assert.equal(rec.systems.length, 3, 'a carrier accumulates addresses');
  assert.equal(rec.system, 'Sol', 'and its current one is where it was last docked at');
  assert.match(carrierTravels(rec)!, /3 different systems/);

  // An ordinary station never travels, so it never claims to.
  const still = new PortMemory();
  still.dock({ name: 'Benyovszky Gateway', system: 'HIP 71120', type: 'Coriolis', atIso: iso(T0) });
  assert.equal(carrierTravels(still.get('Benyovszky Gateway')), null);
});

test('eviction drops the long-forgotten, never the recently visited', () => {
  const m = new PortMemory(3);
  m.dock({ name: 'Old Place', system: 'A', atIso: iso(T0) });
  m.dock({ name: 'Middle', system: 'B', atIso: iso(T0 + DAY) });
  m.dock({ name: 'Newer', system: 'C', atIso: iso(T0 + 2 * DAY) });
  m.dock({ name: 'Newest', system: 'D', atIso: iso(T0 + 3 * DAY) });
  assert.equal(m.size(), 3);
  assert.equal(m.get('Old Place'), null, 'the least recently seen goes first');
  assert.ok(m.get('Newest'));
});

test('the history survives a round trip through storage', () => {
  const m = new PortMemory();
  m.dock({ name: 'Mikels Town', system: 'HIP 71120', type: 'Outpost', faction: 'Explorer on Tour', atIso: iso(T0) });
  m.dock({ name: 'Mikels Town', system: 'HIP 71120', type: 'Outpost', atIso: iso(T0 + DAY) });
  const back = PortMemory.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
  const rec = back.get('Mikels Town')!;
  assert.equal(rec.visits, 2);
  assert.equal(rec.faction, 'Explorer on Tour');
  // Rubbish on disk must not throw — a corrupt file is a fresh memory.
  assert.equal(PortMemory.fromJSON('nonsense').size(), 0);
  assert.equal(PortMemory.fromJSON([{ nope: true }]).size(), 0);
});

test('a lapsed regular is not greeted as a current one', () => {
  // Straight from the real history: 149 visits to a port nobody has seen for
  // thirteen months. "This port knows the ship", present tense, is wrong there
  // in a way a player notices — and "you used to be a regular" is the better
  // scene regardless.
  const m = new PortMemory();
  for (let i = 0; i < 149; i++) {
    m.dock({ name: 'The Forge Of Vulcan', system: 'Shinrarta', atIso: iso(T0 + i * 3600_000) });
  }
  const rec = m.get('The Forge Of Vulcan')!;
  const long = portGreeting(rec, T0 + 400 * DAY, 'The Forge Of Vulcan');
  assert.match(long, /used to be a regular/);
  assert.match(long, /faces will have changed/);
  assert.doesNotMatch(long, /knows the ship/);

  // Still current if they were there last week.
  const fresh = portGreeting(rec, T0 + 7 * DAY, 'The Forge Of Vulcan');
  assert.match(fresh, /knows the ship/);
});

test('the ledger gives a port something to talk about, and states it honestly', () => {
  const m = new PortMemory();
  m.dock({ name: 'Niinimäki', system: 'HIP 71120', type: 'Coriolis', atIso: iso(T0) });
  m.note('Niinimäki', { missionTaken: true });
  m.note('Niinimäki', { bought: 400, commodity: 'Food Cartridges' });
  m.note('Niinimäki', { sold: 400, credits: 9_000_000_000, commodity: 'CMM Composite' });
  const led = portLedger(m.get('Niinimäki'))!;
  assert.match(led, /800 t moved/);
  assert.match(led, /CMM Composite/);
  // Billions must not be printed as thousands of millions — "8711.5m" was on
  // a real record before this was fixed.
  assert.match(led, /9\.0bn credits/);
  assert.doesNotMatch(led, /\d{4,}m credits/);

  // Taken-here and handed-in-here are separate facts, never a fraction: a
  // courier job is accepted at one station and completed at another.
  assert.match(led, /1 job taken here/);
  assert.doesNotMatch(led, /finished/);

  // A port merely passed through has nothing on file, and says nothing.
  const quiet = new PortMemory();
  quiet.dock({ name: 'Joy Vista', system: 'HIP 71120', atIso: iso(T0) });
  assert.equal(portLedger(quiet.get('Joy Vista')), null);
  assert.equal(portLedger(null), null);
});
