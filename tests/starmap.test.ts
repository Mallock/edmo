/** Where places are, and how many jumps that is in the ship you actually fly. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JumpRange,
  StarMap,
  describeReach,
  jumpsFor,
  reachOf,
} from '../src/engine/starmap.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent =>
  ({ timestamp: '2026-09-20T18:00:00Z', ...o }) as unknown as JournalEvent;

// Real coordinates, checked against the live Ardent system endpoint.
const FLOANTH = ev({ event: 'FSDJump', StarSystem: 'Floanth PW-G b16-3', StarPos: [4475.15625, -161.84375, 14649.125] });
const SOL = ev({ event: 'Location', StarSystem: 'Sol', StarPos: [0, 0, 0] });

test('a jump puts a system on the map, and Sol is not a falsy miss', () => {
  const m = new StarMap();
  assert.equal(m.apply(SOL), true);
  assert.equal(m.size, 1);
  assert.deepEqual(m.coordsOf('Sol'), { x: 0, y: 0, z: 0 });
  // Re-reading the same position changes nothing and says so.
  assert.equal(m.apply(SOL), false);
  assert.equal(m.size, 1);
});

test('the name is matched however it is cased', () => {
  const m = new StarMap();
  m.apply(FLOANTH);
  assert.ok(m.coordsOf('floanth pw-g b16-3'));
  assert.ok(m.coordsOf('FLOANTH PW-G B16-3'));
  assert.equal(m.coordsOf('Nowhere At All'), null);
  assert.equal(m.coordsOf(null), null);
});

test('events without a position or a name are ignored', () => {
  const m = new StarMap();
  assert.equal(m.apply(ev({ event: 'Docked', StationName: 'Somewhere' })), false);
  assert.equal(m.apply(ev({ event: 'FSDJump', StarPos: [1, 2, 3] })), false); // no system
  assert.equal(m.apply(ev({ event: 'FSDJump', StarSystem: 'X', StarPos: [1, 2] })), false);
  assert.equal(m.apply(ev({ event: 'FSDJump', StarSystem: 'X', StarPos: [1, 'two', 3] })), false);
  assert.equal(m.size, 0);
});

test('the distance between two known systems is the real one', () => {
  const m = new StarMap();
  m.apply(FLOANTH);
  m.apply(SOL);
  // 15,318 ly from Sol — the figure the live API agrees with.
  assert.equal(Math.round(m.between('Floanth PW-G b16-3', 'Sol')!), 15318);
  // One unknown end means no distance, never a zero.
  assert.equal(m.between('Floanth PW-G b16-3', 'Nowhere'), null);
  assert.equal(m.between(null, 'Sol'), null);
});

test('the map survives storage', () => {
  const m = new StarMap();
  m.apply(FLOANTH);
  m.apply(SOL);
  const back = new StarMap();
  back.load(JSON.parse(JSON.stringify(m.toJSON())));
  assert.equal(Math.round(back.between('Floanth PW-G b16-3', 'Sol')!), 15318);
  back.load(null);
  back.load([{ s: '', x: 1, y: 2, z: 3 }, { bad: true }]);
  assert.equal(back.size, 2);
});

// ------------------------------------------------------------- the jump range

test('no jumps means no range, and no jump count invented from one', () => {
  const j = new JumpRange();
  assert.equal(j.ladenLy(784), null);
  assert.equal(reachOf(j, 784, null), null);
  assert.equal(jumpsFor(464, null), null);
  assert.equal(describeReach(null), null);
});

test('the laden range is the longest jump made with a loaded hold', () => {
  const j = new JumpRange();
  // Loaded runs: a short economical hop and a long one. The long one is the range.
  j.note(18.2, 700, 1);
  j.note(33.2, 784, 2);
  // An empty repositioning jump is not evidence about the laden ship.
  j.note(52.6, 0, 3);
  assert.equal(j.ladenLy(784), 33.2);
  assert.equal(j.emptyLy(784), 52.6);
  const reach = reachOf(j, 784, 60)!;
  assert.equal(reach.rangeLy, 33.2);
  assert.equal(reach.basis, 'laden');
  assert.match(describeReach(reach)!, /33.2 ly laden/);
});

test('with no loaded jump yet it falls back, and says which figure it used', () => {
  const j = new JumpRange();
  j.note(52.6, 0, 1);
  const empty = reachOf(j, 784, 60)!;
  assert.equal(empty.basis, 'empty');
  assert.match(describeReach(empty)!, /a full hold will do worse/);
  // Nothing observed at all falls back to the outfitting figure, labelled.
  const rated = reachOf(new JumpRange(), 784, 60)!;
  assert.equal(rated.rangeLy, 60);
  assert.equal(rated.basis, 'rated');
  assert.match(describeReach(rated)!, /EMPTY range/);
});

test('an unknown hold size cannot decide what laden means', () => {
  const j = new JumpRange();
  j.note(33.2, 784, 1);
  assert.equal(j.ladenLy(null), null);
  assert.equal(j.ladenLy(0), null);
});

test('FSDJump is folded with the cargo that was aboard at the time', () => {
  const j = new JumpRange();
  assert.equal(j.apply(ev({ event: 'FSDJump', JumpDist: 33.2 }), 784), true);
  assert.equal(j.apply(ev({ event: 'Docked' }), 784), false);
  assert.equal(j.apply(ev({ event: 'FSDJump' }), 784), false); // no distance
  assert.equal(j.ladenLy(784), 33.2);
});

test('jumps are ceilinged, and zero distance is zero jumps', () => {
  const reach = { rangeLy: 33.2, basis: 'laden' as const };
  assert.equal(jumpsFor(0, reach), 0);
  assert.equal(jumpsFor(464, reach), 14);
  assert.equal(jumpsFor(33.2, reach), 1);
  assert.equal(jumpsFor(33.3, reach), 2);
  // A distance shorter than one jump is still one jump.
  assert.equal(jumpsFor(0.5, reach), 1);
  assert.equal(jumpsFor(null, reach), null);
});

test('the log survives storage and stays bounded', () => {
  const j = new JumpRange();
  for (let i = 0; i < 80; i++) j.note(10 + i * 0.1, 784, i);
  const back = new JumpRange();
  back.load(JSON.parse(JSON.stringify(j.toJSON())));
  // The oldest were let go; the best of what remains is the range.
  assert.equal(back.ladenLy(784), j.ladenLy(784));
  back.load(null);
  back.load([{ ly: 0 }, { ly: -4, cargo: 1, at: 1 }]);
  assert.equal(back.ladenLy(784), j.ladenLy(784));
});

test('a system can be placed from a lookup, but a visit is never overwritten', () => {
  const m = new StarMap();
  // HIP 71120's real coordinates — the bubble, which is the whole point.
  assert.equal(m.place('HIP 71120', 74.59375, 197.25, 194.8125), true);
  m.apply(FLOANTH);
  assert.equal(Math.round(m.between('Floanth PW-G b16-3', 'HIP 71120')!), 15114);
  // Placing it again changes nothing: the first answer stands.
  assert.equal(m.place('HIP 71120', 0, 0, 0), false);
  // And a system the commander actually flew to keeps its journal position.
  assert.equal(m.place('Floanth PW-G b16-3', 0, 0, 0), false);
  assert.deepEqual(m.coordsOf('Floanth PW-G b16-3'), { x: 4475.15625, y: -161.84375, z: 14649.125 });
  // Nonsense is refused rather than stored.
  assert.equal(m.place('', 1, 2, 3), false);
  assert.equal(m.place('Bad', Number.NaN, 2, 3), false);
});
