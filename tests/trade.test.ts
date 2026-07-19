/** Trade memory — market snapshots, opportunity finding, dismissal/staleness. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MarketMemory,
  findOpportunities,
  parseMarketSnapshot,
} from '../src/engine/trade.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const NOW = Date.parse('2026-07-19T16:00:00Z');

function market(
  marketId: number,
  station: string,
  system: string,
  items: Array<{ name: string; buy?: number; sell?: number; stock?: number; demand?: number }>,
  at = '2026-07-19T15:00:00Z',
): JournalEvent {
  return {
    timestamp: at,
    event: 'Market',
    MarketID: marketId,
    StationName: station,
    StarSystem: system,
    Items: items.map((i) => ({
      Name: `$${i.name.toLowerCase()}_name;`,
      Name_Localised: i.name,
      BuyPrice: i.buy ?? 0,
      SellPrice: i.sell ?? 0,
      Stock: i.stock ?? 0,
      Demand: i.demand ?? 0,
    })),
  } as unknown as JournalEvent;
}

function loadedMemory(): MarketMemory {
  const mem = new MarketMemory();
  mem.record(
    parseMarketSnapshot(
      market(1, "Bolden's Enterprise", 'Tir', [
        { name: 'Tritium', buy: 3500, sell: 3400, stock: 5000 },
        { name: 'Gold', buy: 45000, sell: 44000, stock: 200 },
      ]),
    )!,
  );
  mem.record(
    parseMarketSnapshot(
      market(2, 'Colonia Dream', 'Ratraii', [
        { name: 'Tritium', sell: 14200, demand: 8000 },
        { name: 'Gold', sell: 46000, demand: 300 },
      ]),
    )!,
  );
  return mem;
}

test('parseMarketSnapshot keeps only tradeable rows', () => {
  const rec = parseMarketSnapshot(
    market(9, 'X', 'Y', [
      { name: 'Tritium', buy: 100, stock: 10 },
      { name: 'Junk' }, // no stock, no demand — dropped
    ]),
  )!;
  assert.equal(rec.items.length, 1);
  assert.equal(rec.items[0].name, 'Tritium');
});

test('finds the profitable spread and ranks by profit', () => {
  const opps = findOpportunities(loadedMemory(), { nowMs: NOW });
  assert.equal(opps.length, 1, 'gold spread (1,000) is under the 5,000 default threshold');
  assert.equal(opps[0].commodity, 'Tritium');
  assert.equal(opps[0].profitPerTon, 14200 - 3500);
  assert.equal(opps[0].buy.station, "Bolden's Enterprise");
  assert.equal(opps[0].sell.station, 'Colonia Dream');
});

test('dismissed keys and stale prices are excluded', () => {
  const mem = loadedMemory();
  const [opp] = findOpportunities(mem, { nowMs: NOW });
  assert.equal(findOpportunities(mem, { nowMs: NOW, exclude: new Set([opp.key]) }).length, 0);
  // 3 days later both records are stale.
  assert.equal(findOpportunities(mem, { nowMs: NOW + 72 * 3600_000 }).length, 0);
});

test('same-station spreads and thin quantities are ignored', () => {
  const mem = new MarketMemory();
  mem.record(
    parseMarketSnapshot(
      market(5, 'One Stop', 'Solo', [
        { name: 'Silver', buy: 1000, sell: 90000, stock: 900, demand: 900 },
      ]),
    )!,
  );
  assert.equal(findOpportunities(mem, { nowMs: NOW }).length, 0, 'needs two stations');
  mem.record(
    parseMarketSnapshot(
      market(6, 'Thin Air', 'Solo', [{ name: 'Silver', sell: 95000, demand: 3 }]),
    )!,
  );
  assert.equal(findOpportunities(mem, { nowMs: NOW }).length, 0, 'demand 3 is not a cargo run');
});

test('stationIn finds the freshest real station market, never a carrier', () => {
  const mem = new MarketMemory();
  mem.record(parseMarketSnapshot(market(7, 'Sakai Mineralogic Hub', 'Tir', [{ name: 'Coffee', buy: 1000, stock: 10 }], '2026-07-19T10:00:00Z'))!);
  mem.record(parseMarketSnapshot(market(8, "Bolden's Enterprise", 'Tir', [{ name: 'Coffee', buy: 1100, stock: 10 }], '2026-07-19T12:00:00Z'))!);
  // The commander's own fleet carrier market must never be a route start.
  mem.record(parseMarketSnapshot(market(9, 'V6W-TTJ', 'Tir', [{ name: 'Tritium', sell: 40000, demand: 500 }], '2026-07-19T14:00:00Z'))!);
  assert.equal(mem.stationIn('Tir'), "Bolden's Enterprise");
  assert.equal(mem.stationIn('tir'), "Bolden's Enterprise", 'case-insensitive');
  assert.equal(mem.stationIn('Nowhere'), null);
});
