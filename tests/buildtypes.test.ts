/** The catalogue, and the fingerprint that names a depot from its tonnage. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_BUILD_TYPES,
  BUILD_TYPES,
  BuildLibrary,
  describeBuild,
  describePoints,
  identifyBuild,
  primaryTons,
} from '../src/engine/buildtypes.ts';

test('every catalogue entry carries a cost and a readable name', () => {
  assert.ok(ALL_BUILD_TYPES.length >= 50);
  for (const t of ALL_BUILD_TYPES) {
    assert.ok(t.tons > 0, `${t.key} has no cost`);
    assert.ok(!t.name.includes('_'), `${t.key} was never given a display name`);
    assert.ok(t.slot === 'space' || t.slot === 'ground');
  }
});

test("dependencies only ever name facilities the catalogue holds", () => {
  for (const t of ALL_BUILD_TYPES) {
    for (const d of t.dependencies) {
      assert.ok(BUILD_TYPES[d], `${t.key} depends on unknown ${d}`);
    }
  }
});

test('the commander’s own HIP 71120 site fingerprints as a primary outpost', () => {
  // 21,835 t, straight off the contribution panel in the screenshot: an
  // 18,988 t outpost plus the 14.99% surcharge on a system's first station.
  const g = identifyBuild(21835)!;
  assert.ok(g, 'a real depot tonnage must identify');
  assert.equal(g.primary, true);
  assert.ok(g.types.some((t) => t.key === 'Commercial_Outpost'));
  // Six outposts share that cost, so the honest answer names the family.
  assert.equal(g.types.length, 6);
  assert.match(describeBuild(g)!, /first station/);
});

test('a Coriolis is identified by cost, primary or not', () => {
  const plain = identifyBuild(53723)!;
  assert.equal(plain.primary, false);
  assert.ok(plain.types.some((t) => t.key === 'Coriolis'));
  assert.ok(plain.types.some((t) => t.key === 'Asteroid_Base'));

  const first = identifyBuild(70533)!;
  assert.equal(first.primary, true);
  assert.ok(first.types.some((t) => t.key === 'Coriolis'));
});

test('a cost that is nobody’s returns null rather than the nearest guess', () => {
  assert.equal(identifyBuild(12345), null);
  assert.equal(identifyBuild(0), null);
  assert.equal(identifyBuild(-5), null);
  assert.equal(identifyBuild(Number.NaN), null);
});

test('the tolerance does not blur the settlements into one another', () => {
  // 2,839 / 2,841 / 2,842 / 2,845 / 2,846 are five different builds within
  // seven tons of each other — a wide tolerance would merge them all.
  const agri = identifyBuild(2839)!;
  assert.deepEqual(
    agri.types.map((t) => t.key),
    ['Small_Agricultural_Settlement'],
  );
  const mil = identifyBuild(2842)!;
  assert.deepEqual(
    mil.types.map((t) => t.key),
    ['Small_Military_Settlement'],
  );
});

test('the surface hubs stay five distinct builds inside six tons', () => {
  // 9,919 / 9,921 / 9,922 / 9,923 / 9,924. Any tolerance at all chains these
  // into one another and the answer stops being an answer.
  for (const [cost, key] of [
    [9919, 'Refinery_Hub'],
    [9921, 'High_Tech_Hub'],
    [9922, 'Military_Hub'],
    [9923, 'Exploration_Hub'],
    [9924, 'Scientific_Hub'],
  ] as const) {
    const g = identifyBuild(cost)!;
    assert.deepEqual(
      g.types.map((t) => t.key),
      [key],
      `${cost} t must be exactly ${key}`,
    );
  }
});

test('only facilities that can be a first station have a primary cost', () => {
  assert.equal(primaryTons(BUILD_TYPES.Satellite), null);
  assert.equal(primaryTons(BUILD_TYPES.Coriolis), 70533);
  assert.equal(primaryTons(BUILD_TYPES.Commercial_Outpost), 21835);
});

test('tier points read the way a commander says them', () => {
  assert.equal(describePoints(BUILD_TYPES.Satellite), '+1 T2');
  assert.match(describePoints(BUILD_TYPES.Military), /−1 T2/);
  assert.match(describePoints(BUILD_TYPES.Military), /\+1 T3/);
  assert.match(describePoints(BUILD_TYPES.Orbis_or_Ocellus), /port points at tier 3/);
});

test('the library predicts the next build of a cost it has already read', () => {
  const lib = new BuildLibrary();
  lib.learn({
    tons: 53723,
    lines: [
      { key: 'steel', name: 'Steel', required: 4398 },
      { key: 'titanium', name: 'Titanium', required: 2100 },
    ],
    station: 'Perga’s Progress',
    system: 'HIP 71120',
    at: '2026-09-01T00:00:00Z',
  });
  const p = lib.predict(53723)!;
  assert.equal(p.lines.length, 2);
  assert.equal(p.station, 'Perga’s Progress');
  // Nothing was ever read at an Orbis's cost, so nothing is claimed about one.
  assert.equal(lib.predict(209122), null);
});

test('a later reading of the same build replaces the older one', () => {
  const lib = new BuildLibrary();
  const base = { tons: 6721, station: null, system: null };
  lib.learn({ ...base, lines: [{ key: 'steel', name: 'Steel', required: 100 }], at: '2026-01-01T00:00:00Z' });
  lib.learn({ ...base, lines: [{ key: 'steel', name: 'Steel', required: 250 }], at: '2026-06-01T00:00:00Z' });
  assert.equal(lib.predict(6721)!.lines[0].required, 250);
  // An older reading arriving late (a journal replay) must not win.
  lib.learn({ ...base, lines: [{ key: 'steel', name: 'Steel', required: 1 }], at: '2025-01-01T00:00:00Z' });
  assert.equal(lib.predict(6721)!.lines[0].required, 250);
});

test('the library survives a round trip through storage', () => {
  const lib = new BuildLibrary();
  lib.learn({
    tons: 18988,
    lines: [{ key: 'water', name: 'Water', required: 741 }],
    station: 'Corman Beacon',
    system: 'HIP 71120',
    at: '2026-09-01T00:00:00Z',
  });
  const back = new BuildLibrary();
  back.load(JSON.parse(JSON.stringify(lib.toJSON())));
  assert.equal(back.predict(18988)!.lines[0].required, 741);
  back.load(null);
  back.load({ builds: [{ tons: 0 } as never] });
  assert.equal(back.all.length, 1);
});
