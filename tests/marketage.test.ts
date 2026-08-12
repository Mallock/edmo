/**
 * How old is this price? — the field that was fetched, carried, and dropped.
 *
 * The third leg of the same live failure. Told tritium was 2,565 cr at QFB-75N
 * in Tir with 9,789 t in stock, the commander flew fifteen light-years, docked,
 * and found the market had none — and was BUYING tritium at 55,301 cr. The
 * community report behind that recommendation was dated 2026-07-27: twelve days
 * old. A carrier had simply emptied and flipped in the meantime.
 *
 * Ardent returned `updatedAt` on every row. Rust forwarded it. The tool
 * interface declared it away and the answer never rendered it, so a report from
 * this morning and one from a fortnight ago were indistinguishable.
 *
 * A fresher alternative was right there: IDIB in Asura, 10,788 t, reported two
 * days earlier. It lost on distance to a listing nobody had checked since July.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankMarketRows, reportAgeDays, runTool, STALE_DAYS, type MarketLookupRow, type ToolContext } from '../src/engine/tools.ts';
import { MarketMemory } from '../src/engine/trade.ts';

// Relative to the real clock: the tool reads Date.now() itself, so a frozen
// epoch here would drift the rendered ages by a day depending on when the
// suite runs. The extra minute keeps each date safely PAST its day boundary.
const NOW = Date.now();
const daysAgo = (d: number): string => new Date(NOW - d * 86_400_000 - 60_000).toISOString();

// The two that mattered, with their real ages at the time of the run.
const QFB = { station: 'QFB-75N', system: 'Tir', distanceLy: 15, price: 2565, stock: 9789, demand: 0, pad: '3', carrier: true, updatedAt: daysAgo(12) };
const IDIB = { station: 'IDIB', system: 'Asura', distanceLy: 23, price: 2565, stock: 10788, demand: 0, pad: '3', carrier: true, updatedAt: daysAgo(2) };

const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ system: 'Tir', station: null, galaxyMarket: async () => [QFB, IDIB], ...over }) as unknown as ToolContext;

const ask = (c: ToolContext) =>
  runTool('find_market_in_galaxy', JSON.stringify({ commodity: 'Tritium', side: 'buy', near_system: 'Tir' }), c);

// ------------------------------------------------------------------- the age

test('report age is measured in whole days, and survives a missing date', () => {
  assert.equal(reportAgeDays(daysAgo(0), NOW), 0);
  assert.equal(reportAgeDays(daysAgo(12), NOW), 12);
  assert.equal(reportAgeDays(null, NOW), null);
  assert.equal(reportAgeDays('not a date', NOW), null);
  // A clock skew must not produce a negative age.
  assert.equal(reportAgeDays(new Date(NOW + 86_400_000).toISOString(), NOW), 0);
});

test('every row states when it was last seen', async () => {
  const out = await ask(ctx());
  assert.match(out, /QFB-75N.*seen 12 days ago — STALE, may well be wrong/);
  assert.match(out, /IDIB.*seen 2 days ago/);
  assert.doesNotMatch(out, /IDIB.*STALE/);
  // And the header stops promising freshness it cannot deliver.
  assert.doesNotMatch(out, /may be hours old/);
  assert.match(out, /ALWAYS tell the commander how old the one you recommend is/);
});

// -------------------------------------------------------------- the ranking

test('a fresh report beats a nearer stale one', () => {
  // This is the whole bug: QFB-75N is 8 ly closer and identically priced, and
  // it won on distance alone. IDIB was reported ten days more recently.
  assert.equal(rankMarketRows([QFB, IDIB], 'buy', null, NOW)[0].station, 'IDIB');
  assert.equal(rankMarketRows([QFB, IDIB], 'buy', 4865, NOW)[0].station, 'IDIB');
});

test('freshness does not override price — a cheap old listing still leads', () => {
  const cheapOld = { ...QFB, price: 900 };
  assert.equal(rankMarketRows([cheapOld, IDIB], 'buy', null, NOW)[0].station, 'QFB-75N');
});

test('two equally fresh rows still rank on distance', () => {
  const bothFresh = [{ ...QFB, updatedAt: daysAgo(1) }, IDIB];
  assert.equal(rankMarketRows(bothFresh, 'buy', null, NOW)[0].station, 'QFB-75N'); // 15 ly vs 23
});

test('an undated row is treated as fresh enough to rank, not promoted', () => {
  const undated: MarketLookupRow = { ...QFB, updatedAt: null };
  const ranked = rankMarketRows([undated, IDIB], 'buy', null, NOW);
  assert.equal(ranked[0].station, 'QFB-75N'); // nearer, and not KNOWN to be stale
});

// -------------------------------------------- what the commander saw himself

/** The real QFB-75N market, as recorded on docking: no stock, buying at 55,301. */
function ownVisit(): MarketMemory {
  const m = new MarketMemory();
  m.record({
    marketId: 3709, station: 'QFB-75N', system: 'Tir', at: daysAgo(0),
    items: [{ name: 'Tritium', buy: 0, sell: 55301, stock: 0, demand: 4000 }],
  });
  return m;
}

test('a market the commander found empty is demoted and labelled, not re-offered', async () => {
  const out = await ask(ctx({ markets: ownVisit() }));
  const rows = out.split('\n').filter((l) => l.startsWith('- '));
  assert.match(rows[0], /IDIB/); // the one that might actually have it
  assert.match(rows[1], /QFB-75N/);
  assert.match(rows[1], /YOU CHECKED: none for sale here/);
  assert.match(rows[1], /YOU saw this yourself/);
  // The stale 9,789 t claim must not survive our own look.
  assert.doesNotMatch(out, /9,789/);
});

test('a community report NEWER than our visit is left alone', async () => {
  const stale = new MarketMemory();
  stale.record({
    marketId: 3709, station: 'QFB-75N', system: 'Tir', at: daysAgo(30),
    items: [{ name: 'Tritium', buy: 0, sell: 0, stock: 0, demand: 0 }],
  });
  const out = await ask(ctx({ markets: stale }));
  // Ours is from a month ago, theirs from twelve days — theirs wins.
  assert.match(out, /QFB-75N.*9,789 in stock/);
  assert.doesNotMatch(out, /YOU CHECKED/);
});

test('our own visit corrects the price too, not only the stock', async () => {
  const m = new MarketMemory();
  m.record({
    marketId: 3709, station: 'QFB-75N', system: 'Tir', at: daysAgo(0),
    items: [{ name: 'Tritium', buy: 61000, sell: 0, stock: 500, demand: 0 }],
  });
  const out = await ask(ctx({ markets: m }));
  assert.match(out, /QFB-75N.*61,000 cr, 500 in stock, YOU saw this yourself/);
  assert.doesNotMatch(out, /QFB-75N.*2,565/);
});

test('stations we have never visited pass through untouched', async () => {
  const out = await ask(ctx({ markets: ownVisit() }));
  assert.match(out, /IDIB.*10,788 in stock, seen 2 days ago/);
  assert.doesNotMatch(out, /IDIB.*YOU saw/);
});

test('the staleness threshold is a week, and is stated in one place', () => {
  assert.equal(STALE_DAYS, 7);
});
