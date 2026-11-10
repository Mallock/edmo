/**
 * Galaxy market lookup — the answer has to RANK, and name a destination.
 *
 * Built from the live failure. A commander plotting a 44-jump carrier route out
 * of Tir needed 4,865 t of tritium and asked where to buy it. The lookup worked
 * perfectly — it returned eight carriers with names, systems, prices and stock —
 * and the operator still sent them nowhere, across four attempts:
 *
 *   "the nearest fleet carriers in the area are all listing Tritium for 2,565"
 *   "Since the price is the same everywhere, there's no single cheapest place"
 *   "I don't keep track of every carrier's name"
 *
 * All three are what a flat, unranked list of identical prices actually says.
 * Every one of those eight carriers listed exactly 2,565 cr, so sorting by
 * price ordered nothing: the nearest sat third, and the only two holding enough
 * to fill the order sat fourth and seventh. The row it did eventually name,
 * G9H-NVZ, holds 3,557 t — 1,308 short of the trip.
 *
 * These rows are the real reply from api.ardent-insight.com for tritium exports
 * near Tir, trimmed to the top eight.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankMarketRows, runTool, type MarketLookupRow, type ToolContext } from '../src/engine/tools.ts';

const TRITIUM: MarketLookupRow[] = [
  { station: 'V4M-T0T', system: 'Ogmar', distanceLy: 18, price: 2565, stock: 2775, demand: 0, pad: '3', carrier: true },
  { station: 'J1H-W6B', system: 'Deriso', distanceLy: 21, price: 2565, stock: 1512, demand: 0, pad: '3', carrier: true },
  { station: 'G9H-NVZ', system: 'Eol Prou LW-L c8-127', distanceLy: 15, price: 2565, stock: 3557, demand: 0, pad: '3', carrier: true },
  { station: 'K4V-11N', system: 'Eol Prou PX-T d3-1078', distanceLy: 40, price: 2565, stock: 9474, demand: 0, pad: '3', carrier: true },
  { station: 'BLF-53B', system: 'Eol Prou IW-W e1-2728', distanceLy: 37, price: 2565, stock: 4464, demand: 0, pad: '3', carrier: true },
  { station: 'V0N-84J', system: 'Eol Prou UC-Y b16-33', distanceLy: 45, price: 2565, stock: 7754, demand: 0, pad: '3', carrier: true },
  { station: 'IDIB', system: 'Asura', distanceLy: 25, price: 2565, stock: 10788, demand: 0, pad: '3', carrier: true },
  { station: 'KNK-NQZ', system: "Sovereign's Reach", distanceLy: 21, price: 2565, stock: 5207, demand: 0, pad: '3', carrier: true },
];

/** A context with only what this tool touches. */
function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    system: 'Tir',
    station: null,
    galaxyMarket: async () => TRITIUM,
    ...over,
  } as unknown as ToolContext;
}

const ask = (c: ToolContext) =>
  runTool('find_market_in_galaxy', JSON.stringify({ commodity: 'Tritium', side: 'buy', near_system: 'Tir' }), c);

// ------------------------------------------------------------------- ranking

test('an all-tied price list still ranks — nearest first', () => {
  const ranked = rankMarketRows(TRITIUM, 'buy');
  assert.equal(ranked[0].station, 'G9H-NVZ'); // 15 ly, the nearest
  assert.deepEqual(ranked.map((r) => r.distanceLy), [15, 18, 21, 21, 25, 37, 40, 45]);
});

test('distance ties break on quantity — a second trip costs more than a few ly', () => {
  // J1H-W6B and KNK-NQZ are both 21 ly; the one holding 5,207 t beats 1,512 t.
  const ranked = rankMarketRows(TRITIUM, 'buy');
  const at21 = ranked.filter((r) => r.distanceLy === 21).map((r) => r.station);
  assert.deepEqual(at21, ['KNK-NQZ', 'J1H-W6B']);
});

test('price still wins when there is a real spread', () => {
  const mixed = [
    { ...TRITIUM[0], station: 'FAR-CHEAP', price: 900, distanceLy: 200 },
    { ...TRITIUM[2], station: 'NEAR-DEAR', price: 5000, distanceLy: 1 },
  ];
  assert.equal(rankMarketRows(mixed, 'buy')[0].station, 'FAR-CHEAP');
  // Selling inverts it: the dearest buyer is the good one.
  assert.equal(rankMarketRows(mixed, 'sell')[0].station, 'NEAR-DEAR');
});

test('rows with no price sort last instead of looking free', () => {
  const withUnknown = [{ ...TRITIUM[0], station: 'NOPRICE', price: null }, TRITIUM[2]];
  assert.equal(rankMarketRows(withUnknown, 'buy')[0].station, 'G9H-NVZ');
  assert.equal(rankMarketRows(withUnknown, 'sell')[0].station, 'G9H-NVZ');
});

test('ranking does not mutate the caller\'s array', () => {
  const before = TRITIUM.map((r) => r.station);
  rankMarketRows(TRITIUM, 'buy');
  assert.deepEqual(TRITIUM.map((r) => r.station), before);
});

// -------------------------------------------------------- what the model sees

test('the recommendation is the first line, and it carries a system to fly to', async () => {
  const out = await ask(ctx());
  const first = out.split('\n').find((l) => l.startsWith('- '))!;
  assert.match(first, /G9H-NVZ/);
  assert.match(first, /Eol Prou LW-L c8-127/); // the destination, not just the callsign
  assert.match(out, /FIRST line is the recommendation/);
});

test('an identical price everywhere is called out, with the refusal pre-empted', async () => {
  const out = await ask(ctx());
  assert.match(out, /Every price here is identical \(2,565 cr\)/);
  assert.match(out, /pick on distance and stock, not price/);
  // The exact sentence the operator produced live, now explicitly forbidden.
  assert.match(out, /Do NOT answer "there is no cheapest"/);
});

test('a real price spread gets no tie note', async () => {
  const spread = TRITIUM.map((r, i) => ({ ...r, price: 2000 + i * 100 }));
  const out = await ask(ctx({ galaxyMarket: async () => spread }));
  assert.doesNotMatch(out, /identical/);
});

test('the system is always the destination, and the callsign only picks it out on arrival', async () => {
  const out = await ask(ctx());
  assert.match(out, /Always tell the commander the SYSTEM to fly to/);
  assert.match(out, /callsign \(G9H-NVZ\) is how they pick the carrier out once they arrive/);
  // With no signals for these systems there is no nav-panel name to offer, and
  // none is invented — see carriername.test.ts for the resolved case.
  assert.doesNotMatch(out, /nav panel as/);
});

// ------------------------------------------------------- filling the order

test('sellers that can fill the order outrank nearer ones that cannot', async () => {
  const out = await ask(ctx({ commodityNeed: () => 4865 }));
  assert.match(out, /for the 4,865 t they need/);
  const first = out.split('\n').find((l) => l.startsWith('- '))!;
  // NOT G9H-NVZ: it is the nearest at 15 ly, and it is what the operator
  // recommended live, but 3,557 t leaves the commander 1,308 t short.
  assert.doesNotMatch(first, /G9H-NVZ/);
  assert.match(first, /KNK-NQZ/); // 21 ly, 5,207 t — nearest that actually covers it
  assert.match(first, /COVERS your need/);
  // The shortfalls are still listed, and still labelled as shortfalls.
  assert.match(out, /G9H-NVZ.*only 73% of what you need/);
});

test('coverage outranks distance, but only for the side that can fall short', () => {
  const near = { ...TRITIUM[2] }; // 15 ly, 3,557 t
  const far = { ...TRITIUM[6] }; // 25 ly, 10,788 t
  assert.equal(rankMarketRows([near, far], 'buy', 4865)[0].station, 'IDIB');
  // No need stated → the nearest is the answer again.
  assert.equal(rankMarketRows([near, far], 'buy', null)[0].station, 'G9H-NVZ');
});

test('when nothing can fill the order it says so instead of hiding it', async () => {
  const out = await ask(ctx({ commodityNeed: () => 50_000 }));
  assert.match(out, /No single seller here holds the 50,000 t needed/);
  assert.match(out, /first stop of more than one/);
  // The biggest holding leads, since that is the best first stop.
  assert.match(out.split('\n').find((l) => l.startsWith('- '))!, /IDIB/);
});

test('no plotted need means no fill annotations at all', async () => {
  const out = await ask(ctx({ commodityNeed: () => null }));
  assert.doesNotMatch(out, /COVERS your need/);
  assert.doesNotMatch(out, /of what you need/);
  assert.doesNotMatch(out, /they need/);
});

test('need applies to buying only — it says nothing about where to sell', async () => {
  const out = await runTool(
    'find_market_in_galaxy',
    JSON.stringify({ commodity: 'Tritium', side: 'sell', near_system: 'Tir' }),
    ctx({ commodityNeed: () => 4865 }),
  );
  assert.doesNotMatch(out, /COVERS your need/);
});

test('the opt-in and empty cases still answer honestly rather than inventing a price', async () => {
  assert.match(await ask(ctx({ galaxyMarket: null })), /Galaxy-wide market lookup is off/);
  // The empty answer names the RADIUS it searched. "No sellers near Tir" reads
  // as "tritium is unavailable"; the limit of the ring is the actual fact.
  const empty = await ask(ctx({ galaxyMarket: async () => [] }));
  assert.match(empty, /No sellers of Tritium reported within [\d,]+ ly of Tir/);
  assert.match(empty, /limit of the search, not of the galaxy/);
});

// --------------------------------------------------- reaching the deep hubs

/**
 * The real reply from api.ardent-insight.com for steel exports near
 * Floanth PW-G b16-3 — the commander's own colonisation build, 15,318 ly from
 * Sol — at maxDistance=1000. At Ardent's default 100 ly ring this query, and
 * the same query for tritium, water, aluminium, gold, copper and polymers,
 * returns a flat zero.
 */
const DEEP_STEEL: MarketLookupRow[] = [
  { station: 'Gustard Watch', system: 'Greae Hype TO-G c27-10', distanceLy: 464, price: 3746, stock: 793835, demand: 0, pad: '3', carrier: false, updatedAt: '2026-09-19T00:00:00Z' },
  { station: 'Cleaver City', system: 'Greae Hype TO-G c27-10', distanceLy: 464, price: 4142, stock: 482353, demand: 0, pad: '3', carrier: false, updatedAt: '2026-09-20T00:00:00Z' },
  { station: 'FLK-B2Z', system: 'Floanth FY-L c10-107', distanceLy: 107, price: 4179, stock: 6660, demand: 0, pad: '3', carrier: true, updatedAt: '2026-09-20T00:00:00Z' },
  { station: 'MOXE', system: 'Floanth KW-O a45-1', distanceLy: 129, price: 4179, stock: 6660, demand: 0, pad: '3', carrier: true, updatedAt: '2026-09-19T00:00:00Z' },
  { station: 'N4J-BKW', system: 'Floanth NK-C b5-12', distanceLy: 257, price: 4179, stock: 1988, demand: 0, pad: '3', carrier: true, updatedAt: '2026-09-17T00:00:00Z' },
];

const NOW_DEEP = Date.parse('2026-09-20T18:00:00Z');

test('a 0.9% price edge does not buy 357 extra light years', () => {
  // Cleaver City (4,142 cr, 464 ly) against FLK-B2Z (4,179 cr, 107 ly): 37 cr
  // a ton. Price-first ranking put the 464 ly hub above the 107 ly carrier —
  // which only became possible once the ring was wide enough to see it.
  const two = [DEEP_STEEL[1], DEEP_STEEL[2]];
  assert.equal(rankMarketRows(two, 'buy', 5358, NOW_DEEP)[0].station, 'FLK-B2Z');
});

test('a real price spread still wins, however far away it is', () => {
  // Gustard Watch is 433 cr a ton cheaper — 10.4%, well outside the tie band,
  // and 2.3 M credits on a 5,358 t order. That IS worth the extra distance.
  const ranked = rankMarketRows(DEEP_STEEL, 'buy', 5358, NOW_DEEP);
  assert.equal(ranked[0].station, 'Gustard Watch');
  // And the near carrier still beats the hub it is only 0.9% dearer than.
  const order = ranked.map((r) => r.station);
  assert.ok(order.indexOf('FLK-B2Z') < order.indexOf('Cleaver City'), order.join(' > '));
});

test('inside a price band the freshest report still leads', () => {
  // FLK-B2Z and MOXE are identically priced and identically stocked; FLK-B2Z is
  // both nearer and newer. N4J-BKW is the same price but a third of the stock.
  const band = [DEEP_STEEL[4], DEEP_STEEL[3], DEEP_STEEL[2]];
  assert.deepEqual(
    rankMarketRows(band, 'buy', null, NOW_DEEP).map((r) => r.station),
    ['FLK-B2Z', 'MOXE', 'N4J-BKW'],
  );
});

test('an empty ring widens itself, and the answer says how far it reached', async () => {
  const rings: number[] = [];
  const ctx = {
    system: 'Floanth PW-G b16-3',
    station: null,
    marketRadiusLy: 100,
    galaxyMarket: async (_c: string, _s: string, _near: string, maxDistanceLy?: number) => {
      rings.push(maxDistanceLy ?? 0);
      // Exactly what the live API does from out there: nothing at 100 ly.
      return maxDistanceLy && maxDistanceLy > 100 ? DEEP_STEEL : [];
    },
  } as unknown as ToolContext;
  const out = await runTool('find_market_in_galaxy', JSON.stringify({ commodity: 'Steel', side: 'buy' }), ctx);
  assert.deepEqual(rings, [100, 1000]);
  assert.match(out, /widened to 1,000 ly/);
  assert.match(out, /DEEP SPACE distances/);
  assert.match(out, /Gustard Watch/);
});

test('a ring that answers is never widened', async () => {
  const rings: number[] = [];
  const ctx = {
    system: 'Tir',
    station: null,
    marketRadiusLy: 100,
    galaxyMarket: async (_c: string, _s: string, _near: string, maxDistanceLy?: number) => {
      rings.push(maxDistanceLy ?? 0);
      return TRITIUM;
    },
  } as unknown as ToolContext;
  const out = await runTool('find_market_in_galaxy', JSON.stringify({ commodity: 'Tritium', side: 'buy' }), ctx);
  assert.deepEqual(rings, [100]);
  assert.doesNotMatch(out, /widened/);
});

test('nothing anywhere says so as a limit of the search, not of the galaxy', async () => {
  const ctx = {
    system: 'Floanth PW-G b16-3',
    station: null,
    marketRadiusLy: 100,
    galaxyMarket: async () => [],
  } as unknown as ToolContext;
  const out = await runTool('find_market_in_galaxy', JSON.stringify({ commodity: 'Gold', side: 'buy' }), ctx);
  assert.match(out, /within 1,000 ly/);
  assert.match(out, /limit of the search, not of the galaxy/);
  assert.match(out, /named hub or staging system/);
});
