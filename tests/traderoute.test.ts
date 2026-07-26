/** Inara-style trade search: pairing, the pad/supply floors, and honesty. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FILTERS,
  bestSink,
  buildLeg,
  cheapestSources,
  describeLeg,
  describeTradeFind,
  probeOrder,
  rankLegs,
  type MarketRow,
  type RouteFilters,
  resolveOrigin,
  bestSinksByCommodity,
  legsToDestination,
  systemDistanceLy,
} from '../src/engine/traderoute.ts';

const NOW = Date.parse('2026-07-26T16:00:00Z');
const RECENT = '2026-07-26T15:46:55.000Z';
const ANCIENT = '2026-05-05T05:17:02.000Z';

const row = (o: Partial<MarketRow>): MarketRow => ({
  commodity: 'bauxite',
  station: 'Somewhere',
  system: 'Tir',
  stationType: 'Coriolis',
  pad: 3,
  distanceLy: 0,
  distanceLs: 100,
  buyPrice: 0,
  sellPrice: 0,
  stock: 0,
  demand: 0,
  updatedAt: RECENT,
  ...o,
});

const F: RouteFilters = { ...DEFAULT_FILTERS };

// The real Tir bauxite run, from live Ardent data.
const SOURCE = row({
  station: 'Webster Excavation Complex',
  system: 'Tir',
  pad: 3,
  buyPrice: 629,
  stock: 2000,
  distanceLs: 354,
});
const SINK = row({
  station: 'Neugebauer Mines',
  system: 'Luchtaine',
  stationType: 'Outpost',
  pad: 2,
  distanceLy: 30,
  distanceLs: 1462,
  sellPrice: 44946,
  demand: 80644,
});

test('the real Tir bauxite run costs out correctly', () => {
  const leg = buildLeg(SOURCE, SINK, F, NOW);
  assert.ok(leg);
  assert.equal(leg.profitPerTon, 44_317);
  // Stock (2000) exceeds the hold, so the hold binds.
  assert.equal(leg.tons, 400);
  assert.equal(leg.profitPerTrip, 17_726_800);
  assert.equal(leg.distanceLy, 30);
  assert.equal(leg.dataAgeH, 0);
});

test('tonnage is bounded by whichever of hold, stock and demand binds first', () => {
  const thin = buildLeg({ ...SOURCE, stock: 1200 }, SINK, F, NOW);
  assert.equal(thin!.tons, 400); // hold still smallest
  const tiny = buildLeg({ ...SOURCE, stock: 1200 }, SINK, { ...F, cargo: 720 }, NOW);
  assert.equal(tiny!.tons, 720);
  const capped = buildLeg({ ...SOURCE, stock: 1200 }, SINK, { ...F, cargo: 5000, minVolume: 0 }, NOW);
  assert.equal(capped!.tons, 1200); // stock binds
  const noDemand = buildLeg(SOURCE, { ...SINK, demand: 50 }, { ...F, minVolume: 0 }, NOW);
  assert.equal(noDemand!.tons, 50); // demand binds
});

test('a leg that loses money is not a leg', () => {
  assert.equal(buildLeg(SOURCE, { ...SINK, sellPrice: 629 }, F, NOW), null);
  assert.equal(buildLeg(SOURCE, { ...SINK, sellPrice: 100 }, F, NOW), null);
  assert.equal(buildLeg(SOURCE, { ...SINK, demand: 0 }, { ...F, minVolume: 0 }, NOW), null);
});

test('a large-pad hull never gets offered an outpost sink', () => {
  // Neugebauer Mines is a medium pad; the default floor allows it...
  assert.ok(bestSink([SINK], F, 'Tir', NOW));
  // ...but a Type-9 cannot land there, so it must not be quoted the route.
  assert.equal(bestSink([SINK], { ...F, minPad: 3 }, 'Tir', NOW), null);
});

test('the supply floor rejects markets too thin to be a route', () => {
  assert.equal(cheapestSources([{ ...SOURCE, stock: 999 }], F, NOW).size, 0);
  assert.equal(cheapestSources([SOURCE], F, NOW).size, 1);
  assert.equal(bestSink([{ ...SINK, demand: 999 }], F, 'Tir', NOW), null);
});

test('selling back into the origin system is not a route', () => {
  assert.equal(bestSink([{ ...SINK, system: 'Tir' }], F, 'Tir', NOW), null);
});

test('cheapestSources keeps the cheapest station per commodity', () => {
  const sources = cheapestSources(
    [
      row({ station: 'Dear', buyPrice: 900, stock: 5000 }),
      row({ station: 'Cheap', buyPrice: 629, stock: 2000 }),
      row({ commodity: 'gold', station: 'H1N-9QN', buyPrice: 44_275, stock: 1802 }),
    ],
    F,
    NOW,
  );
  assert.equal(sources.size, 2);
  assert.equal(sources.get('bauxite')!.station, 'Cheap');
  assert.equal(sources.get('gold')!.buyPrice, 44_275);
});

test('stale market reports are ignored on both sides', () => {
  assert.equal(cheapestSources([{ ...SOURCE, updatedAt: ANCIENT }], F, NOW).size, 0);
  assert.equal(bestSink([{ ...SINK, updatedAt: ANCIENT }], F, 'Tir', NOW), null);
  // A market with no timestamp at all is given the benefit of the doubt.
  assert.equal(cheapestSources([{ ...SOURCE, updatedAt: null }], F, NOW).size, 1);
});

test('probeOrder spends lookups on the best ceiling and skips the hopeless', () => {
  const sources = cheapestSources(
    [
      row({ commodity: 'bauxite', buyPrice: 629, stock: 2000 }),
      row({ commodity: 'gold', buyPrice: 44_275, stock: 1802 }),
      row({ commodity: 'drones', buyPrice: 101, stock: 8161 }),
    ],
    F,
    NOW,
  );
  const order = probeOrder(
    sources,
    new Map([
      ['bauxite', 42_564],
      ['gold', 67_620],
      ['drones', 90], // cannot beat the 101 local buy price anywhere
    ]),
  );
  assert.deepEqual(order, ['bauxite', 'gold']);
});

test('legs rank by credits per trip, richest first', () => {
  const rich = buildLeg(SOURCE, SINK, F, NOW)!;
  const lean = buildLeg(
    { ...SOURCE, commodity: 'gold', buyPrice: 44_275, stock: 1802 },
    { ...SINK, commodity: 'gold', station: 'Exodus Reach', system: 'Ratraii', sellPrice: 67_512, demand: 13_260, distanceLy: 7 },
    F,
    NOW,
  )!;
  assert.deepEqual(rankLegs([lean, null, rich]).map((l) => l.commodity), ['bauxite', 'gold']);
});

test('the spoken leg carries the numbers a commander acts on', () => {
  const text = describeLeg(buildLeg(SOURCE, SINK, F, NOW)!);
  assert.match(text, /Webster Excavation Complex/);
  assert.match(text, /Neugebauer Mines/);
  assert.match(text, /Luchtaine, 30 ly/);
  assert.match(text, /44,317 cr a ton/);
  assert.match(text, /17\.7M for 400 t/);
  assert.match(text, /Pads large\/medium/);
  assert.match(text, /1,462 Ls/);
});

test('the summary admits how much of the search space it covered', () => {
  const find = {
    legs: [buildLeg(SOURCE, SINK, F, NOW)!],
    originKnown: true,
    checked: 8,
    candidates: 31,
    filters: F,
    origin: 'Tir',
  };
  const text = describeTradeFind(find);
  assert.match(text, /checked the 8 likeliest of 31/);
  assert.match(text, /medium pad or better/);
  assert.match(text, /1,000 t either side/);
  assert.match(text, /verify stock on arrival/);
});

test('finding nothing says so, and says what would help', () => {
  const text = describeTradeFind({ legs: [], originKnown: true, checked: 8, candidates: 31, filters: F, origin: 'Tir' });
  assert.match(text, /No profitable run out of Tir/);
  assert.match(text, /8 most promising of 31/);
  assert.match(text, /Widening the range/);
  // It must never imply the search was exhaustive.
  assert.doesNotMatch(text, /nothing exists|no routes exist/i);
});

test('an unknown system is named as such, not reported as unprofitable', () => {
  // "Rahtari" — a real mishearing of Ratraii. Ardent 404s, and saying "no
  // profitable run" would send the commander hunting a market problem.
  const text = describeTradeFind({
    legs: [], originKnown: false, checked: 0, candidates: 0, filters: F, origin: 'Rahtari',
  });
  assert.match(text, /no market data for "Rahtari"/);
  assert.match(text, /check the name/);
  assert.doesNotMatch(text, /No profitable run/);
  assert.doesNotMatch(text, /0 most promising of 0/);
});

// The commander's actual Type-8, from their journal.
const RAHTARI = { ship: 'type8', shipName: 'rahtari', shipIdent: 'MA-26T' };

test('a ship name in the system slot means "here, in this ship"', () => {
  // "find a profitable trade run for rahtari" — Rahtari is the hull, not a
  // place. Looking it up as a system 404s and answers the wrong question.
  assert.deepEqual(resolveOrigin('rahtari', 'Tir', RAHTARI), { origin: 'Tir', namedTheShip: true });
  assert.deepEqual(resolveOrigin('Rahtari', 'Tir', RAHTARI), { origin: 'Tir', namedTheShip: true });
  // The ident and the hull type are the same request in different words.
  assert.equal(resolveOrigin('MA-26T', 'Tir', RAHTARI).namedTheShip, true);
  assert.equal(resolveOrigin('ma26t', 'Tir', RAHTARI).namedTheShip, true);
  assert.equal(resolveOrigin('Type 8', 'Tir', RAHTARI).namedTheShip, true);
});

test('a real place is still treated as a place', () => {
  assert.deepEqual(resolveOrigin('Ratraii', 'Tir', RAHTARI), { origin: 'Ratraii', namedTheShip: false });
  assert.deepEqual(resolveOrigin('', 'Tir', RAHTARI), { origin: 'Tir', namedTheShip: false });
  assert.deepEqual(resolveOrigin(null, 'Tir', RAHTARI), { origin: 'Tir', namedTheShip: false });
  // No loadout known yet: nothing can match the ship, so the name stands.
  assert.deepEqual(resolveOrigin('rahtari', 'Tir', null), { origin: 'rahtari', namedTheShip: false });
});

// Real Valac→Tir data. The commander asked twice for a run TO Tir and was
// twice answered about somewhere else.
const VALAC_SELLS = [
  row({ commodity: 'cobalt', station: "Becker's Burrow", system: 'Valac', buyPrice: 4624, stock: 4000 }),
  row({ commodity: 'basicmedicines', station: 'Salted Womb', system: 'Valac', buyPrice: 2081, stock: 3000 }),
  row({ commodity: 'waterpurifiers', station: 'Salted Womb', system: 'Valac', buyPrice: 168, stock: 9000 }),
];
const TIR_BUYS = [
  row({ commodity: 'cobalt', station: "Bolden's Enterprise", system: 'Tir', sellPrice: 9791, demand: 5000, distanceLy: 43 }),
  row({ commodity: 'basicmedicines', station: 'Huber Metallurgic Enterprise', system: 'Tir', sellPrice: 5027, demand: 9000, distanceLy: 43 }),
  // Tir pays nothing special for water purifiers — the undirected search's pick
  // must not survive into a directed answer.
  row({ commodity: 'waterpurifiers', station: 'Ariss Dock', system: 'Tir', sellPrice: 150, demand: 4000, distanceLy: 43 }),
];

test('a run to a named system carries what THAT system pays for', () => {
  const sources = cheapestSources(VALAC_SELLS, F, NOW);
  const sinks = bestSinksByCommodity(TIR_BUYS, F, 'Valac', NOW);
  const legs = legsToDestination(sources, sinks, F, NOW);
  assert.deepEqual(legs.map((l) => l.commodity), ['cobalt', 'basicmedicines']);
  assert.equal(legs[0].profitPerTon, 5167);
  assert.equal(legs[0].profitPerTrip, 2_066_800);
  assert.equal(legs[0].toSystem, 'Tir');
  // Water purifiers lose money into Tir, so they are not offered at all.
  assert.equal(legs.some((l) => l.commodity === 'waterpurifiers'), false);
});

test('a directed answer never quietly becomes an undirected one', () => {
  const text = describeTradeFind({
    legs: legsToDestination(cheapestSources(VALAC_SELLS, F, NOW), bestSinksByCommodity(TIR_BUYS, F, 'Valac', NOW), F, NOW),
    originKnown: true, destination: 'Tir', destinationKnown: true,
    checked: 3, candidates: 3, filters: F, origin: 'Valac',
  });
  assert.match(text, /Best cargo for the run to Tir/);
  assert.match(text, /cobalt/);
  assert.match(text, /Bolden's Enterprise/);
  // It must not wander off to the best-paying run in some other direction.
  assert.doesNotMatch(text, /Luchtaine|Neugebauer/);
});

test('nothing worth carrying there says exactly that, and offers the alternative', () => {
  const text = describeTradeFind({
    legs: [], originKnown: true, destination: 'Tir', destinationKnown: true,
    checked: 3, candidates: 3, filters: F, origin: 'Valac',
  });
  assert.match(text, /Nothing on sale around Valac sells for more at Tir/);
  assert.match(text, /flying there empty/);
  assert.match(text, /best-paying run in any direction/);
  // Must not read as "there are no trade routes".
  assert.doesNotMatch(text, /No profitable run out of/);
});

test('an unknown destination is named as unknown, not as unprofitable', () => {
  const text = describeTradeFind({
    legs: [], originKnown: true, destination: 'Teer', destinationKnown: false,
    checked: 0, candidates: 0, filters: F, origin: 'Valac',
  });
  assert.match(text, /no market data for "Teer"/);
  assert.doesNotMatch(text, /Nothing on sale/);
});

test('a directed run reports the real distance, not zero', () => {
  // Real coordinates: Valac and Tir are ~43 ly apart. The per-system endpoints
  // send no `distance`, and rendering that as "Tir, 0 ly" reads as "you are
  // already there".
  const valac = row({ commodity: 'cobalt', system: 'Valac', buyPrice: 4624, stock: 4000,
    x: -9532.9, y: -923.4, z: 19799.1 });
  const tir = row({ commodity: 'cobalt', system: 'Tir', sellPrice: 9791, demand: 5000,
    distanceLy: null, x: -9553.5, y: -914.8, z: 19837.3 });
  assert.ok(Math.abs(systemDistanceLy(valac, tir)! - 43.6) < 1);
  assert.equal(buildLeg(valac, tir, F, NOW)!.distanceLy, 44);
  // A row that DOES carry a distance keeps it — the nearby endpoints are authoritative.
  assert.equal(buildLeg(valac, { ...tir, distanceLy: 43 }, F, NOW)!.distanceLy, 43);
  // No coordinates anywhere: fall back to 0 rather than invent one.
  assert.equal(systemDistanceLy(row({}), row({})), null);
});
