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
  assert.match(await ask(ctx({ galaxyMarket: async () => [] })), /No sellers of Tritium reported near Tir/);
});
