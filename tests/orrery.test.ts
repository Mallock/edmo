/**
 * Orrery — element reading, parent-chain recovery, Kepler propagation, scale.
 *
 * The scan events here are copied verbatim out of
 * fixtures/journal/session-couriers-assassinate.log, including the parent
 * shapes that make this awkward: a bare `BodyID:0` star with no `Parents`, a
 * star whose parent is a `Null` barycentre, belt clusters hanging off a
 * `Ring`, and a three-deep `Null` chain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCALE,
  M_PER_LS,
  OrreryTracker,
  bodyRadiusPx,
  compressLs,
  legProgress,
  lightSource,
  materialGrade,
  orbitAt,
  orbitPath,
  parentChain,
  placeBelts,
  placeLabels,
  placeBody,
  placeSystem,
  readElements,
  readMaterials,
  resolveBodyId,
  resolvePorts,
  separateDiscs,
  surfaceOf,
  shortLabel,
  solveKepler,
  type OrbitElements,
} from '../src/engine/orrery.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

/** Real: the primary of a single-star system. BodyID 0, and no Parents at all. */
const LONE_STAR = ev({
  timestamp: '2025-07-05T17:21:26Z',
  event: 'Scan',
  ScanType: 'AutoScan',
  BodyName: 'Col 285 Sector VM-M b23-0',
  BodyID: 0,
  StarSystem: 'Col 285 Sector VM-M b23-0',
  SystemAddress: 671492023777,
  DistanceFromArrivalLS: 0,
  StarType: 'M',
  Radius: 395124128,
  RotationPeriod: 161320.04178,
});

/** Real: star A of a binary, orbiting the system barycentre (Null 0). */
const BINARY_A = ev({
  timestamp: '2025-07-05T17:34:30Z',
  event: 'Scan',
  ScanType: 'AutoScan',
  BodyName: 'Col 285 Sector MJ-F c12-10 A',
  BodyID: 1,
  Parents: [{ Null: 0 }],
  StarSystem: 'Col 285 Sector MJ-F c12-10',
  SystemAddress: 2832698872562,
  DistanceFromArrivalLS: 0,
  StarType: 'K',
  Radius: 657401152,
  SemiMajorAxis: 1795729637145.996094,
  Eccentricity: 0.081341,
  OrbitalInclination: 9.528577,
  Periapsis: 215.739721,
  OrbitalPeriod: 5391337096.691132,
  AscendingNode: -34.674121,
  MeanAnomaly: 168.213545,
});

/** Real: a belt cluster. Ring parent, and not one orbital element. */
const BELT = ev({
  timestamp: '2025-07-05T17:36:54Z',
  event: 'Scan',
  ScanType: 'AutoScan',
  BodyName: 'Col 285 Sector DE-K b24-0 A Belt Cluster 2',
  BodyID: 3,
  Parents: [{ Ring: 1 }, { Star: 0 }],
  StarSystem: 'Col 285 Sector DE-K b24-0',
  SystemAddress: 670954956265,
  DistanceFromArrivalLS: 4.808025,
});

const BELT_STAR = ev({
  timestamp: '2025-07-05T17:36:50Z',
  event: 'Scan',
  BodyName: 'Col 285 Sector DE-K b24-0 A',
  BodyID: 0,
  StarSystem: 'Col 285 Sector DE-K b24-0',
  SystemAddress: 670954956265,
  DistanceFromArrivalLS: 0,
  StarType: 'M',
  Radius: 300000000,
});

/** A moon three levels down, proving 12 orbits 5 and 5 orbits 0 on the way. */
const DEEP_MOON = ev({
  timestamp: '2025-07-05T18:00:00Z',
  event: 'Scan',
  BodyName: 'Testsys 5 a',
  BodyID: 13,
  Parents: [{ Null: 12 }, { Planet: 5 }, { Star: 0 }],
  StarSystem: 'Testsys',
  SystemAddress: 999,
  PlanetClass: 'Rocky body',
  Radius: 1_500_000,
  SemiMajorAxis: 300_000_000,
  Eccentricity: 0.01,
  OrbitalInclination: 0,
  Periapsis: 0,
  OrbitalPeriod: 86_400,
  AscendingNode: 0,
  MeanAnomaly: 0,
});

const circular = (o: Partial<OrbitElements> = {}): OrbitElements => ({
  semiMajorAxis: M_PER_LS, // 1 ls
  eccentricity: 0,
  inclination: 0,
  periapsis: 0,
  ascendingNode: 0,
  meanAnomaly: 0,
  period: 3600,
  epochMs: 0,
  ...o,
});

// ------------------------------------------------------------------ elements

test('a full element set is read; a star with no orbit yields none', () => {
  const el = readElements(BINARY_A);
  assert.ok(el);
  assert.equal(el.eccentricity, 0.081341);
  assert.equal(el.meanAnomaly, 168.213545);
  assert.equal(el.epochMs, Date.parse('2025-07-05T17:34:30Z'));
  // The lone primary orbits nothing and must not be given a default orbit.
  assert.equal(readElements(LONE_STAR), undefined);
  assert.equal(readElements(BELT), undefined);
});

test('parent chains are read in order, nearest first', () => {
  assert.deepEqual(parentChain(DEEP_MOON), [
    { kind: 'Null', id: 12 },
    { kind: 'Planet', id: 5 },
    { kind: 'Star', id: 0 },
  ]);
  assert.deepEqual(parentChain(LONE_STAR), []);
});

test('the system name is stripped off body labels', () => {
  assert.equal(shortLabel('Col 285 Sector MJ-F c12-10 A', 'Col 285 Sector MJ-F c12-10'), 'A');
  // The primary of a single-star system is named after the system itself.
  assert.equal(shortLabel('Col 285 Sector VM-M b23-0', 'Col 285 Sector VM-M b23-0'), 'Col 285 Sector VM-M b23-0');
});

// -------------------------------------------------------------------- Kepler

test('Kepler solves to a closed residual, including at high eccentricity', () => {
  for (const e of [0, 0.08, 0.5, 0.95]) {
    for (const M of [0, 0.7, Math.PI, 5.9]) {
      const E = solveKepler(M, e);
      assert.ok(Math.abs(E - e * Math.sin(E) - M) < 1e-9, `e=${e} M=${M}`);
    }
  }
});

test('a circular orbit comes back to the same place after one period', () => {
  const el = circular();
  const a = orbitAt(el, 0);
  const b = orbitAt(el, el.period * 1000);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1, 'one period is a round trip');
  // Mean anomaly 0 is periapsis, which with ω=Ω=0 sits on +x at radius a.
  assert.ok(Math.abs(a.x - M_PER_LS) < 1, 'periapsis on the +x axis');
  assert.ok(Math.abs(a.y) < 1e-6);
});

test('a quarter period of a circular orbit is a quarter turn', () => {
  const el = circular();
  const q = orbitAt(el, (el.period * 1000) / 4);
  assert.ok(Math.abs(q.y - M_PER_LS) < 1, 'a quarter turn puts it on +y');
  assert.ok(Math.abs(q.x) < 1);
});

test('inclination tilts the orbit out of the plane, and zero keeps it in', () => {
  const flat = orbitAt(circular({ meanAnomaly: 90 }), 0);
  assert.ok(Math.abs(flat.z) < 1e-6);
  const tilted = orbitAt(circular({ inclination: 90, meanAnomaly: 90 }), 0);
  assert.ok(Math.abs(tilted.z) > 0.9 * M_PER_LS, 'a polar orbit is all z at 90°');
});

test('eccentricity puts periapsis and apoapsis where they belong', () => {
  const el = circular({ eccentricity: 0.5 });
  const peri = orbitAt(el, 0);
  const apo = orbitAt(el, (el.period * 1000) / 2);
  assert.ok(Math.abs(Math.hypot(peri.x, peri.y) - 0.5 * M_PER_LS) < 1e3, 'a(1-e)');
  assert.ok(Math.abs(Math.hypot(apo.x, apo.y) - 1.5 * M_PER_LS) < 1e3, 'a(1+e)');
});

// ------------------------------------------------------------- parent chains

test('a lone BodyID 0 with no Parents is the root, not an orphan', () => {
  const t = new OrreryTracker();
  t.apply(LONE_STAR);
  const sys = t.get('671492023777');
  assert.ok(sys);
  const star = sys.bodies.get(0);
  assert.equal(star?.parentId, null);
  assert.equal(star?.kind, 'star');
  // A root with no elements still places, at the origin.
  const placed = placeBody(sys, 0, Date.now());
  assert.ok(placed);
  assert.equal(placed.x, 0);
  assert.equal(placed.y, 0);
});

test('a barycentre nobody scanned is created from the chain that names it', () => {
  const t = new OrreryTracker();
  t.apply(BINARY_A);
  const sys = t.get('2832698872562')!;
  const bary = sys.bodies.get(0);
  assert.ok(bary, 'Null 0 exists although no event ever scanned it');
  assert.equal(bary.kind, 'barycentre');
  assert.equal(bary.scanned, false, 'and it is flagged as never scanned');
  assert.equal(sys.bodies.get(1)?.parentId, 0);
});

test('a deep chain proves parentage for bodies the event is not about', () => {
  const t = new OrreryTracker();
  t.apply(DEEP_MOON);
  const sys = t.get('999')!;
  // Learned entirely from one moon's Parents array.
  assert.equal(sys.bodies.get(12)?.parentId, 5, 'barycentre 12 orbits planet 5');
  assert.equal(sys.bodies.get(5)?.parentId, 0, 'planet 5 orbits star 0');
  assert.equal(sys.bodies.get(0)?.parentId, null, 'star 0 is the root');
  assert.equal(sys.bodies.get(13)?.parentId, 12);
});

test('a ring parent is collapsed onto the body the ring belongs to', () => {
  const t = new OrreryTracker();
  t.apply(BELT);
  const sys = t.get('670954956265')!;
  const belt = sys.bodies.get(3)!;
  assert.equal(belt.kind, 'belt');
  assert.equal(belt.parentId, 0, 'Ring 1 is skipped; the star underneath it is the parent');
  assert.equal(sys.bodies.has(1), false, 'and the ring itself is never a body');
});

/**
 * Real, from HIP 71120 on 2026-08-10. A ring is scanned as a body in its own
 * right — its own BodyID, its own full element set — and its parent is the
 * PLANET, not a Ring link. It has no PlanetClass, which is what gives it away.
 */
const RING = ev({
  timestamp: '2026-08-10T20:07:41Z',
  event: 'Scan',
  ScanType: 'AutoScan',
  BodyName: 'HIP 71120 3 A Ring',
  BodyID: 33,
  Parents: [{ Planet: 32 }, { Star: 0 }],
  StarSystem: 'HIP 71120',
  SystemAddress: 83986911994,
  DistanceFromArrivalLS: 1276.034172,
  SemiMajorAxis: 277786642.313004,
  Eccentricity: 0,
  OrbitalInclination: 0,
  Periapsis: 0,
  OrbitalPeriod: 36321.091056,
  AscendingNode: 0,
  MeanAnomaly: 260.374779,
});

test('a ring is a band, not a barycentre sitting on top of its planet', () => {
  const t = new OrreryTracker();
  t.apply(RING);
  const sys = t.get('83986911994')!;
  const ring = sys.bodies.get(33)!;
  assert.equal(ring.kind, 'belt', 'no PlanetClass and no StarType means it is not a body');
  assert.notEqual(ring.kind, 'barycentre');
  // It must never reach the point layer — that drew a dot over the planet.
  assert.equal(placeSystem(sys, Date.now()).some((p) => p.body.id === 33), false);
});

test('bodies known only from a parent chain are anchors, never dots', () => {
  const t = new OrreryTracker();
  t.apply(RING); // proves planet 32 orbits star 0, without scanning either
  const sys = t.get('83986911994')!;
  assert.equal(sys.bodies.get(32)?.scanned, false);
  assert.equal(sys.bodies.get(0)?.scanned, false);
  const drawn = placeSystem(sys, Date.now());
  assert.deepEqual(drawn, [], 'nothing here was actually scanned, so nothing is drawn');
  // But they still anchor: scan planet 32 and it appears, in the right place.
  t.apply(ev({
    timestamp: '2026-08-10T20:08:00Z',
    event: 'Scan',
    BodyName: 'HIP 71120 3',
    BodyID: 32,
    Parents: [{ Star: 0 }],
    StarSystem: 'HIP 71120',
    SystemAddress: 83986911994,
    PlanetClass: 'Icy body',
    Radius: 2e7,
    SemiMajorAxis: 3.8e11,
    Eccentricity: 0.01,
    OrbitalPeriod: 8e7,
    MeanAnomaly: 12,
  }));
  const after = placeSystem(t.get('83986911994')!, Date.now());
  assert.deepEqual(after.map((p) => p.body.id), [32]);
});

test('a body scanned before its parent is held, not drawn in the wrong place', () => {
  const t = new OrreryTracker();
  // A moon of planet 5, but nothing has established what planet 5 orbits.
  t.apply(ev({
    timestamp: '2025-07-05T18:00:00Z',
    event: 'Scan',
    BodyName: 'Orphan 5 a',
    BodyID: 9,
    Parents: [{ Planet: 5 }],
    StarSystem: 'Orphanage',
    SystemAddress: 1234,
    PlanetClass: 'Icy body',
    SemiMajorAxis: 1e9,
    Eccentricity: 0,
    OrbitalPeriod: 86400,
    MeanAnomaly: 0,
  }));
  const sys = t.get('1234')!;
  // Planet 5 exists as a placeholder root, so the moon resolves to it.
  assert.equal(sys.bodies.get(5)?.scanned, false);
  assert.ok(placeBody(sys, 9, Date.now()), 'placeholder parent is enough to place against');

  // But a chain that goes nowhere is refused rather than guessed at.
  const broken = t.get('1234')!;
  broken.bodies.set(9, { ...broken.bodies.get(9)!, parentId: 404 });
  assert.equal(placeBody(broken, 9, Date.now()), null);
});

test('a cyclic parent chain is refused instead of hanging', () => {
  const t = new OrreryTracker();
  t.apply(DEEP_MOON);
  const sys = t.get('999')!;
  sys.bodies.set(0, { ...sys.bodies.get(0)!, parentId: 13 });
  assert.equal(placeBody(sys, 13, Date.now()), null);
});

// --------------------------------------------------------------------- scale

test('compression preserves ordering and lifts the very small off zero', () => {
  const near = compressLs(0.001, DEFAULT_SCALE);
  const mid = compressLs(4, DEFAULT_SCALE);
  const far = compressLs(2000, DEFAULT_SCALE);
  assert.ok(near > 0, 'a hugging moon still clears its planet');
  assert.ok(near < mid && mid < far, 'order survives the log');
  // The point of the whole exercise: 2000 ls against 0.001 ls is 2,000,000:1
  // in reality and nothing can draw that. On screen it is about 33:1.
  assert.ok(far / near < 50, `2,000,000:1 becomes ${(far / near).toFixed(0)}:1`);
});

test('true-distance mode does not touch the number', () => {
  const opts = { ...DEFAULT_SCALE, mode: 'true' as const };
  assert.equal(compressLs(4, opts), 4);
  assert.equal(compressLs(2000, opts), 2000);
});

test('compression is per level, so a moon never collapses onto its planet', () => {
  const t = new OrreryTracker();
  t.apply(DEEP_MOON);
  const sys = t.get('999')!;
  // Give planet 5 a far orbit; the moon's own is four orders of magnitude smaller.
  sys.bodies.set(5, {
    ...sys.bodies.get(5)!,
    scanned: true,
    kind: 'planet',
    elements: circular({ semiMajorAxis: 400 * M_PER_LS, period: 3e7 }),
  });
  const planet = placeBody(sys, 5, 0)!;
  const moon = placeBody(sys, 13, 0)!;
  const gap = Math.hypot(moon.x - planet.x, moon.y - planet.y);
  assert.ok(gap > 0.4, `a moon 1 light-second out is still visibly off its planet (${gap})`);
  // 400 ls and 1 ls end up within one order of magnitude of each other on
  // screen, which is the only reason both are visible at once...
  assert.ok(Math.hypot(planet.x, planet.y) / gap < 10, 'planet and moon share a screen');
  // ...while the number the detail line quotes is the real separation.
  assert.ok(Math.abs(moon.trueLs - 1) < 0.01, `true separation stays honest (${moon.trueLs})`);
});

// ---------------------------------------------------------------- separation

test('overlapping bodies are pushed apart until they can be told apart', () => {
  const out = separateDiscs([
    { x: 100, y: 100, r: 4 },
    { x: 102, y: 100, r: 4 },
    { x: 101, y: 102, r: 4 },
  ], 2);
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const d = Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y);
      assert.ok(d >= out[i].r + out[j].r - 0.01, `pair ${i},${j} still overlapping at ${d}`);
    }
  }
});

test('nothing is dragged further than the shift budget allows', () => {
  // Twelve bodies stacked on one pixel: unresolvable, and it must stay bounded
  // rather than flinging them across the panel.
  const home = Array.from({ length: 12 }, () => ({ x: 200, y: 120, r: 5 }));
  const out = separateDiscs(home, 2, 15);
  for (const d of out) {
    assert.ok(Math.hypot(d.x - 200, d.y - 120) <= 15.001, 'inside the budget');
  }
});

test('bodies already clear of each other are left exactly where they are', () => {
  const input = [
    { x: 10, y: 10, r: 3 },
    { x: 90, y: 90, r: 3 },
  ];
  assert.deepEqual(separateDiscs(input, 2), input);
});

test('separation is deterministic, so nothing jitters between frames', () => {
  const input = [
    { x: 50, y: 50, r: 6 },
    { x: 50, y: 50, r: 6 },
    { x: 51, y: 50, r: 6 },
  ];
  assert.deepEqual(separateDiscs(input, 2), separateDiscs(input, 2));
});

test('separation carries the payload through, so bodies keep their identity', () => {
  const out = separateDiscs([
    { x: 5, y: 5, r: 4, id: 'a' },
    { x: 6, y: 5, r: 4, id: 'b' },
  ], 2);
  assert.deepEqual(out.map((d) => d.id).sort(), ['a', 'b']);
});

// --------------------------------------------------------------------- ports

/** Two real worlds from HIP 71120, with the distances their stations quote. */
const portSystem = (): OrreryTracker => {
  const t = new OrreryTracker();
  t.apply(ev({ timestamp: '2026-08-16T00:00:00Z', event: 'Location', StarSystem: 'HIP 71120', SystemAddress: 83986911994 }));
  for (const [id, name, ls] of [[21, 'HIP 71120 2 b', 970.0], [43, 'HIP 71120 4 c', 2403.6]] as const) {
    t.apply(ev({
      timestamp: '2026-08-16T00:00:01Z', event: 'Scan', BodyName: name, BodyID: id,
      Parents: [{ Star: 0 }], StarSystem: 'HIP 71120', SystemAddress: 83986911994,
      PlanetClass: 'Icy body', Radius: 2e6, DistanceFromArrivalLS: ls,
      SemiMajorAxis: 1e12, Eccentricity: 0, OrbitalPeriod: 1e7, MeanAnomaly: id,
    }));
  }
  return t;
};

test('an orbital station is matched to its body by distance from the star', () => {
  const t = portSystem();
  // Real: Anders City, BodyID 85, an Outpost at 970.04 ls.
  t.apply(ev({
    timestamp: '2026-08-16T00:01:00Z', event: 'Location', StarSystem: 'HIP 71120',
    SystemAddress: 83986911994, Docked: true, BodyID: 85, BodyType: 'Station',
    Body: 'Anders City', StationName: 'Anders City', StationType: 'Outpost',
    DistFromStarLS: 970.037866,
  }));
  const sys = t.current()!;
  resolvePorts(sys);
  const port = sys.ports.get(85)!;
  assert.equal(port.name, 'Anders City');
  assert.equal(port.parentId, 21, 'both measure from the arrival star, so they agree');
  assert.equal(port.parentKnown, undefined, 'and it is flagged as inferred, not stated');
});

test('a surface settlement takes the body the journal names, not a guess', () => {
  const t = portSystem();
  t.apply(ev({
    timestamp: '2026-08-16T00:02:00Z', event: 'ApproachSettlement',
    Name: 'Bawa Hospitality Site', MarketID: 1, StarSystem: 'HIP 71120',
    SystemAddress: 83986911994, BodyID: 43, BodyName: 'HIP 71120 4 c',
    Latitude: 41.2, Longitude: -130.5,
  }));
  const sys = t.current()!;
  resolvePorts(sys);
  const port = [...sys.ports.values()].find((p) => p.name === 'Bawa Hospitality Site')!;
  assert.equal(port.parentId, 43);
  assert.equal(port.parentKnown, true, 'stated outright, so distance never overrides it');
  assert.equal(port.latitude, 41.2);
});

test('a station too far from anything scanned is left unplaced, not guessed', () => {
  const t = portSystem();
  t.apply(ev({
    timestamp: '2026-08-16T00:03:00Z', event: 'Location', StarSystem: 'HIP 71120',
    SystemAddress: 83986911994, BodyID: 99, BodyType: 'Station', Body: 'Nowhere Dock',
    StationName: 'Nowhere Dock', StationType: 'Coriolis', DistFromStarLS: 40000,
  }));
  const sys = t.current()!;
  resolvePorts(sys);
  assert.equal(sys.ports.get(99)?.parentId, undefined, 'better absent than beside the wrong world');
});

test('fleet carriers are never pinned to a body, because they jump', () => {
  const t = portSystem();
  t.apply(ev({
    timestamp: '2026-08-16T00:04:00Z', event: 'Location', StarSystem: 'HIP 71120',
    SystemAddress: 83986911994, BodyID: 77, BodyType: 'Station', Body: 'V6W-TTJ',
    StationName: 'V6W-TTJ', StationType: 'FleetCarrier', DistFromStarLS: 970,
  }));
  assert.equal(t.current()!.ports.has(77), false, 'this table is persisted; a carrier would go stale');
});

test('docking fills in the distance for a station first seen on a drop', () => {
  const t = portSystem();
  t.apply(ev({
    timestamp: '2026-08-16T00:05:00Z', event: 'SupercruiseExit', StarSystem: 'HIP 71120',
    SystemAddress: 83986911994, BodyID: 85, BodyType: 'Station', Body: 'Anders City',
  }));
  assert.equal(t.current()!.ports.get(85)?.distanceLs, undefined, 'a drop gives no distance');
  // Docked carries the distance but no BodyID at all, so it merges by name.
  t.apply(ev({
    timestamp: '2026-08-16T00:06:00Z', event: 'Docked', StationName: 'Anders City',
    StationType: 'Outpost', StarSystem: 'HIP 71120', SystemAddress: 83986911994,
    DistFromStarLS: 970.037866,
  }));
  const sys = t.current()!;
  assert.equal(sys.ports.get(85)?.distanceLs, 970.037866);
  resolvePorts(sys);
  assert.equal(sys.ports.get(85)?.parentId, 21, 'and only then can it be placed');
});

test('ports survive a reload, since they cost a docking to learn', () => {
  const t = portSystem();
  t.apply(ev({
    timestamp: '2026-08-16T00:07:00Z', event: 'Location', StarSystem: 'HIP 71120',
    SystemAddress: 83986911994, BodyID: 85, BodyType: 'Station', Body: 'Anders City',
    StationName: 'Anders City', StationType: 'Outpost', DistFromStarLS: 970.04,
  }));
  const back = OrreryTracker.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
  assert.equal(back.get('83986911994')?.ports.get(85)?.name, 'Anders City');
});

// ------------------------------------------------------------- historic fold

test('the historic fold learns docks and bodies but never moves the ship', () => {
  const t = portSystem();
  // A live leg is under way.
  t.apply(ev({ timestamp: '2026-08-16T10:00:00Z', event: 'Location', StarSystem: 'HIP 71120', SystemAddress: 83986911994, BodyID: 21 }));
  t.apply(ev({ timestamp: '2026-08-16T10:01:00Z', event: 'SupercruiseEntry', StarSystem: 'HIP 71120', SystemAddress: 83986911994 }));
  assert.equal(t.leg?.fromId, 21);

  // The sweep now replays LAST YEAR's arrivals. Through apply() this would
  // null the live leg and teleport currentBodyId into the past.
  t.applyHistoric(ev({
    timestamp: '2025-06-24T14:00:00Z', event: 'SupercruiseExit', StarSystem: 'HIP 71120',
    SystemAddress: 83986911994, BodyID: 85, BodyType: 'Station', Body: 'Anders City',
  }));
  t.applyHistoric(ev({
    timestamp: '2025-06-24T14:01:00Z', event: 'Docked', StationName: 'Anders City',
    StationType: 'Outpost', StarSystem: 'HIP 71120', SystemAddress: 83986911994,
    DistFromStarLS: 970.037866,
  }));

  assert.equal(t.leg?.fromId, 21, 'the live leg survives the history');
  assert.equal(t.currentBodyId, null, 'and the ship was not teleported to 2025');
  const sys = t.current()!;
  assert.equal(sys.ports.get(85)?.name, 'Anders City', 'while the dock was still learned');
  resolvePorts(sys);
  assert.equal(sys.ports.get(85)?.parentId, 21);
});

test('a dock seen before any scan still lands: the system is created for it', () => {
  // The boot race, distilled: the live journal replays a station arrival
  // before the async history sweep has created the system from scans.
  const t = new OrreryTracker();
  t.apply(ev({
    timestamp: '2026-08-16T09:40:00Z', event: 'SupercruiseExit', StarSystem: 'HIP 71120',
    SystemAddress: 83986911994, BodyID: 91, BodyType: 'Station', Body: 'Heisenberg Depot',
  }));
  const sys = t.get('83986911994');
  assert.ok(sys, 'the system exists although nothing was ever scanned');
  assert.equal(sys.ports.get(91)?.name, 'Heisenberg Depot');
  // The scans arrive later (the sweep resolves) and the port is still there.
  t.applyHistoric(ev({
    timestamp: '2025-06-24T13:53:12Z', event: 'Scan', BodyName: 'HIP 71120 2 b', BodyID: 21,
    Parents: [{ Star: 0 }], StarSystem: 'HIP 71120', SystemAddress: 83986911994,
    PlanetClass: 'Icy body', Radius: 2e6, DistanceFromArrivalLS: 970.0,
    SemiMajorAxis: 1e12, Eccentricity: 0, OrbitalPeriod: 1e7, MeanAnomaly: 3,
  }));
  assert.equal(t.get('83986911994')!.ports.get(91)?.name, 'Heisenberg Depot');
  assert.equal(t.get('83986911994')!.bodies.get(21)?.scanned, true);
});

test('a plain Location with no station in it does not create a system entry', () => {
  const t = new OrreryTracker();
  t.apply(ev({ timestamp: '2026-08-16T09:00:00Z', event: 'Location', StarSystem: 'Passthrough', SystemAddress: 42 }));
  assert.equal(t.get('42'), null, 'an empty entry would cost a slot in the LRU cap');
});

// -------------------------------------------------------------- ship in flight

test('entering supercruise opens a leg from wherever the ship last was', () => {
  const t = new OrreryTracker();
  t.apply(ev({ timestamp: '2026-08-16T01:00:00Z', event: 'Location', StarSystem: 'S', SystemAddress: 5, BodyID: 3 }));
  assert.equal(t.currentBodyId, 3);
  t.apply(ev({ timestamp: '2026-08-16T01:01:00Z', event: 'SupercruiseEntry', StarSystem: 'S', SystemAddress: 5 }));
  assert.equal(t.leg?.fromId, 3, 'SupercruiseEntry names no body — it comes from the tracker');
  assert.equal(t.currentBodyId, null, 'and the ship is no longer AT anything');
});

test('arrival ends the leg, because that is the moment position is certain', () => {
  const t = new OrreryTracker();
  t.apply(ev({ timestamp: '2026-08-16T01:00:00Z', event: 'Location', StarSystem: 'S', SystemAddress: 5, BodyID: 3 }));
  t.apply(ev({ timestamp: '2026-08-16T01:01:00Z', event: 'SupercruiseEntry', StarSystem: 'S', SystemAddress: 5 }));
  t.apply(ev({ timestamp: '2026-08-16T01:04:00Z', event: 'SupercruiseExit', StarSystem: 'S', SystemAddress: 5, BodyID: 9 }));
  assert.equal(t.leg, null, 'no estimate may outlive the fact that replaces it');
  assert.equal(t.currentBodyId, 9);
});

test('a jump clears any leg — the old system is not where we are', () => {
  const t = new OrreryTracker();
  t.apply(ev({ timestamp: '2026-08-16T01:00:00Z', event: 'Location', StarSystem: 'S', SystemAddress: 5, BodyID: 3 }));
  t.apply(ev({ timestamp: '2026-08-16T01:01:00Z', event: 'SupercruiseEntry', StarSystem: 'S', SystemAddress: 5 }));
  t.apply(ev({ timestamp: '2026-08-16T01:02:00Z', event: 'FSDJump', StarSystem: 'T', SystemAddress: 6 }));
  assert.equal(t.leg, null);
});

test('undocking and flying out resolves BOTH ends through the dock table', () => {
  // The exact live sequence: drop at a station, dock, undock, supercruise out.
  // Every id the journal offers here is a STATION id, not a body.
  const t = portSystem();
  t.apply(ev({
    timestamp: '2026-08-16T09:40:00Z', event: 'SupercruiseExit', StarSystem: 'HIP 71120',
    SystemAddress: 83986911994, BodyID: 85, BodyType: 'Station', Body: 'Anders City',
  }));
  t.apply(ev({
    timestamp: '2026-08-16T09:41:00Z', event: 'Docked', StationName: 'Anders City',
    StationType: 'Outpost', StarSystem: 'HIP 71120', SystemAddress: 83986911994,
    DistFromStarLS: 970.037866,
  }));
  t.apply(ev({ timestamp: '2026-08-16T09:50:00Z', event: 'Undocked', StationName: 'Anders City' }));
  t.apply(ev({ timestamp: '2026-08-16T09:51:00Z', event: 'SupercruiseEntry', StarSystem: 'HIP 71120', SystemAddress: 83986911994 }));

  const sys = t.current()!;
  resolvePorts(sys);
  assert.equal(t.leg?.fromId, 85, 'the origin really is a station id');
  assert.equal(sys.bodies.has(85), false, 'and no body table will ever contain it');
  // Which is exactly why it has to be resolved rather than looked up.
  assert.equal(resolveBodyId(sys, t.leg!.fromId), 21, 'origin resolves to the world it orbits');
  // A surface depot targets the planet directly and needs no resolving.
  assert.equal(resolveBodyId(sys, 43), 43);
  assert.equal(resolveBodyId(sys, 9999), null, 'and an unknown id stays unknown');
});

test('progress is an interval that opens, slides and closes', () => {
  const leg = { fromId: 1, toId: 2, departedMs: 0 };
  const early = legProgress(leg, 20_000, 400);
  assert.ok(early.lo < early.hi, 'it is a band, never a point');
  assert.ok(early.hi < 1, 'and it does not claim arrival 20 seconds in');

  const later = legProgress(leg, 120_000, 400);
  assert.ok(later.lo > early.lo && later.hi > early.hi, 'it advances with the clock');
  assert.ok(later.mid > early.mid);

  // Past the fastest plausible leg the upper bound pins at "there", and the
  // band closes from behind rather than overshooting.
  const late = legProgress(leg, 600_000, 400);
  assert.equal(late.hi, 1);
  assert.equal(late.lo, 1);
  assert.ok(late.lo <= late.hi);
});

test('a short hop resolves faster than a cruise, because the data says so', () => {
  const leg = { fromId: 1, toId: 2, departedMs: 0 };
  // 0.8 ls took about as long as 4,697 ls in the real journals, so the split is
  // by manoeuvre-versus-cruise, not by a distance curve.
  const hop = legProgress(leg, 30_000, 0.5);
  const cruise = legProgress(leg, 30_000, 4000);
  assert.ok(hop.hi >= cruise.hi, 'a sub-light-second hop is further along at the same elapsed time');
});

test('progress never runs backwards or leaves the route', () => {
  const leg = { fromId: 1, toId: 2, departedMs: 1000 };
  let prev = -1;
  for (let s = 0; s <= 900; s += 15) {
    const p = legProgress(leg, 1000 + s * 1000, 400);
    assert.ok(p.lo >= 0 && p.hi <= 1, `bounds stay on the line at ${s}s`);
    assert.ok(p.mid >= prev - 1e-9, 'and the marker never slides back');
    prev = p.mid;
  }
});

// ----------------------------------------------------------------- landables

/** Real, from Bleae Thua XN-E b39-5 on 2026-08-10. A hot, airless, 0.71 G rock
 *  with tellurium on it — the kind of body the tab exists to point at. */
const LANDABLE = ev({
  timestamp: '2026-08-10T15:02:18Z',
  event: 'Scan',
  ScanType: 'AutoScan',
  BodyName: 'Bleae Thua XN-E b39-5 1',
  BodyID: 7,
  Parents: [{ Star: 0 }],
  StarSystem: 'Bleae Thua XN-E b39-5',
  SystemAddress: 11652649134417,
  DistanceFromArrivalLS: 6.656309,
  TidalLock: true,
  TerraformState: '',
  PlanetClass: 'High metal content body',
  Atmosphere: '',
  AtmosphereType: 'None',
  Volcanism: 'metallic magma volcanism',
  MassEM: 0.323834,
  Radius: 4318562.5,
  SurfaceGravity: 6.920746,
  SurfaceTemperature: 928.658081,
  SurfacePressure: 0,
  Landable: true,
  Materials: [
    { Name: 'iron', Percent: 21.264542 },
    { Name: 'nickel', Percent: 16.083607 },
    { Name: 'tellurium', Percent: 1.164999 },
    { Name: 'mercury', Percent: 0.928587 },
  ],
  SemiMajorAxis: 1995505452.156067,
  Eccentricity: 0.000003,
  OrbitalPeriod: 76097.061634,
  MeanAnomaly: 174.265541,
  WasDiscovered: true,
  WasMapped: false,
  WasFootfalled: false,
});

test('a landable scan keeps everything the card has to show', () => {
  const t = new OrreryTracker();
  t.apply(LANDABLE);
  const b = t.get('11652649134417')!.bodies.get(7)!;
  assert.equal(b.landable, true);
  assert.equal(b.gravity, 6.920746);
  assert.equal(b.temperature, 928.658081);
  assert.equal(b.volcanism, 'metallic magma volcanism');
  assert.equal(b.tidalLock, true);
  assert.equal(b.wasFootfalled, false, 'nobody has walked here — worth saying so');
  assert.equal(b.materials?.length, 4);
});

test('materials come back richest first, whatever order the game wrote them', () => {
  const mats = readMaterials(LANDABLE)!;
  assert.deepEqual(mats.map((m) => m.name), ['iron', 'nickel', 'tellurium', 'mercury']);
  const shuffled = readMaterials(ev({ ...LANDABLE, Materials: [
    { Name: 'Mercury', Percent: 0.9 },
    { Name: 'Iron', Percent: 21.2 },
  ] }))!;
  assert.deepEqual(shuffled.map((m) => m.name), ['iron', 'mercury'], 'sorted, and lowercased');
});

test('a body with no Materials block yields none rather than an empty list', () => {
  assert.equal(readMaterials(BINARY_A), undefined);
  assert.equal(readMaterials(ev({ ...LANDABLE, Materials: [] })), undefined);
});

test('rarity, not percentage, is what makes a material worth the trip', () => {
  assert.equal(materialGrade('iron'), 1);
  assert.equal(materialGrade('germanium'), 2);
  assert.equal(materialGrade('mercury'), 3);
  assert.equal(materialGrade('tellurium'), 4);
  assert.equal(materialGrade('Tellurium'), 4, 'case is the journal\'s business, not ours');
  // The 21% of iron is grade 1; the 1.16% of tellurium is grade 4.
  const mats = readMaterials(LANDABLE)!;
  assert.ok(mats[0].percent > mats[2].percent);
  assert.ok(materialGrade(mats[2].name) > materialGrade(mats[0].name));
  // An unknown name is treated as ordinary rather than dropped or hyped.
  assert.equal(materialGrade('unobtainium'), 2);
});

// ------------------------------------------------------------------ surfaces

test('a body looks like whatever the journal said it is', () => {
  const of = (planetClass?: string, kind: 'planet' | 'star' | 'belt' = 'planet') =>
    surfaceOf({ id: 1, name: 'x', label: 'x', kind, parentId: null, scanned: true, planetClass });
  assert.equal(of(undefined, 'star'), 'star');
  assert.equal(of('Icy body'), 'icy');
  assert.equal(of('High metal content body'), 'metal');
  assert.equal(of('Metal rich body'), 'metal');
  assert.equal(of('Rocky body'), 'rock');
  assert.equal(of('Earthlike body'), 'ocean');
  assert.equal(of('Water world'), 'ocean');
  assert.equal(of('Ammonia world'), 'ammonia');
  assert.equal(of('Sudarsky class I gas giant'), 'gas');
  // A band is not a body and gets no surface.
  assert.equal(of('Icy body', 'belt'), 'none');
  // Unclassified rock beats inventing something more specific.
  assert.equal(of(''), 'rock');
});

test('bodies grow with zoom, but slower than the distances between them', () => {
  const body = {
    id: 1, name: 'x', label: 'x', kind: 'planet' as const,
    parentId: null, scanned: true, radius: 3_000_000,
  };
  const r1 = bodyRadiusPx(body, 1);
  const r10 = bodyRadiusPx(body, 10);
  assert.ok(r10 > r1 * 2, 'visibly bigger — there is no point zooming otherwise');
  assert.ok(r10 < r1 * 10, 'but sub-linear, or two planets would fill the panel');
  assert.equal(bodyRadiusPx(body, 0.2), r1, 'zooming out never shrinks below the base size');
});

test('a planet is lit by its nearest star, and a lone body by nothing', () => {
  const mk = (id: number, kind: 'star' | 'planet', x: number) => ({
    body: { id, name: `b${id}`, label: `b${id}`, kind, parentId: null, scanned: true },
    x, y: 0, z: 0, trueLs: 0,
  });
  const near = mk(1, 'star', 10);
  const far = mk(2, 'star', -400);
  const planet = mk(3, 'planet', 30);
  assert.equal(lightSource([near, far, planet], planet)?.body.id, 1);
  // A star is not lit by itself.
  assert.equal(lightSource([near], near), null);
  assert.equal(lightSource([planet], planet), null, 'no star, no terminator');
});

// -------------------------------------------------------------------- labels

const wish = (key: number, x: number, y: number, text = `b${key}`, priority = 4) =>
  ({ key, text, x, y, r: 4, priority });

test('a body with room gets its name, on the side that reads first', () => {
  const out = placeLabels([wish(1, 100, 100, 'A')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'A');
  assert.equal(out[0].anchor, 'start', 'to the right of the body');
  assert.ok(out[0].x > 100, 'and clear of it');
});

test('names never overlap each other', () => {
  // Twelve bodies in a tight cluster: some names will not fit, and none of the
  // ones that do may collide.
  const wishes = Array.from({ length: 12 }, (_, i) =>
    wish(i, 200 + (i % 4) * 9, 120 + Math.floor(i / 4) * 9, `body ${i}`),
  );
  const out = placeLabels(wishes);
  const charW = 4.3, lineH = 8;
  const boxes = out.map((l) => {
    const w = l.text.length * charW;
    const left = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - w : l.x - w / 2;
    return { x: left, y: l.y - lineH * 0.8, w, h: lineH };
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const over = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(over, false, `"${out[i].text}" and "${out[j].text}" overlap`);
    }
  }
});

test('priority wins the good berth: the star is never crowded out', () => {
  const crowd = Array.from({ length: 10 }, (_, i) => wish(i + 1, 100, 100, 'rock', 4));
  const out = placeLabels([...crowd, wish(99, 100, 100, 'HIP 71120', 0)]);
  assert.ok(out.some((l) => l.text === 'HIP 71120'), 'the star got a berth');
  assert.equal(out[0].text, 'HIP 71120', 'and took it first');
});

test('a name with nowhere to go is skipped, not stacked', () => {
  // Ten identical long names on one point: at most a few can be placed.
  const stacked = Array.from({ length: 10 }, (_, i) => wish(i, 50, 50, 'a very long designation'));
  const out = placeLabels(stacked);
  assert.ok(out.length < stacked.length, 'some were skipped');
  assert.ok(out.length >= 1, 'but not all of them');
});

test('zooming apart gives the skipped names their berths back', () => {
  const tight = Array.from({ length: 8 }, (_, i) => wish(i, 100 + i * 6, 100, `moon ${i}`));
  const spread = Array.from({ length: 8 }, (_, i) => wish(i, 100 + i * 60, 100, `moon ${i}`));
  assert.ok(
    placeLabels(spread).length > placeLabels(tight).length,
    'more names fit once the bodies are further apart',
  );
});

test('a name is never written across another body', () => {
  // One body, and a second sitting exactly where the first name wants to go.
  const out = placeLabels([wish(1, 100, 100, 'XXXXXX', 0), wish(2, 118, 100, 'y', 1)]);
  const first = out.find((l) => l.key === 1)!;
  assert.notEqual(first.anchor, 'start', 'it went somewhere other than over body 2');
});

// ------------------------------------------------------------------ the tabs

test('the whole system places, with belts kept out of the point layer', () => {
  const t = new OrreryTracker();
  t.apply(BELT_STAR);
  t.apply(BELT);
  const sys = t.get('670954956265')!;

  const points = placeSystem(sys, Date.now());
  assert.deepEqual(points.map((p) => p.body.id), [0], 'only the star is a point');

  const belts = placeBelts(sys, Date.now());
  assert.equal(belts.length, 1);
  assert.equal(belts[0].body.id, 3);
  assert.ok(belts[0].r > 0, 'and it is a band with a radius');
});

test('an orbit path closes, and passes through the body it belongs to', () => {
  const t = new OrreryTracker();
  t.apply(BINARY_A);
  const sys = t.get('2832698872562')!;
  const now = Date.parse('2025-07-05T17:34:30Z');
  const path = orbitPath(sys, 1, now, DEFAULT_SCALE, 48);
  assert.equal(path.length, 49);
  const first = path[0];
  const last = path[path.length - 1];
  assert.ok(Math.hypot(first.x - last.x, first.y - last.y) < 1e-6, 'one period closes the loop');

  const here = placeBody(sys, 1, now, DEFAULT_SCALE)!;
  assert.ok(
    Math.hypot(first.x - here.x, first.y - here.y) < 1e-6,
    'and the path starts where the body actually is',
  );
});

test('warping time moves bodies without drift, forwards and back', () => {
  const t = new OrreryTracker();
  t.apply(BINARY_A);
  const sys = t.get('2832698872562')!;
  const now = Date.now();
  const a = placeBody(sys, 1, now)!;
  const later = placeBody(sys, 1, now + 5e10)!;
  assert.ok(Math.hypot(a.x - later.x, a.y - later.y) > 1e-6, 'it moved');
  // Closed form: coming back evaluates the same equation, not an inverse.
  const back = placeBody(sys, 1, now)!;
  assert.equal(back.x, a.x);
  assert.equal(back.y, a.y);
});

// --------------------------------------------------------------- persistence

test('the tracker survives a round trip through JSON', () => {
  const t = new OrreryTracker();
  t.apply(BINARY_A);
  t.apply(DEEP_MOON);
  const back = OrreryTracker.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
  const sys = back.get('2832698872562')!;
  assert.equal(sys.bodies.get(1)?.name, 'Col 285 Sector MJ-F c12-10 A');
  assert.equal(sys.bodies.get(1)?.elements?.meanAnomaly, 168.213545);
  assert.ok(placeBody(sys, 1, Date.now()), 'and still places after reload');
});

test('a later scan of the same body updates it rather than duplicating it', () => {
  const t = new OrreryTracker();
  t.apply(BINARY_A);
  t.apply(ev({ ...BINARY_A, timestamp: '2025-07-05T19:00:00Z', MeanAnomaly: 200 }));
  const sys = t.get('2832698872562')!;
  assert.equal(sys.bodies.size, 2, 'star A and the barycentre, not four things');
  assert.equal(sys.bodies.get(1)?.elements?.meanAnomaly, 200);
});
