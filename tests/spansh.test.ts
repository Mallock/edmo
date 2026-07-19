/** Spansh route parsing — against a captured real API response (Tir, 40 ly). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commodityLine, parseSpanshRoute, routeSummary } from '../src/engine/spansh.ts';

// Trimmed but structurally identical to the live /api/results body captured
// from spansh.co.uk during development (2026-07-19).
const REAL = JSON.stringify({
  job: '5B36BFB2',
  state: 'completed',
  status: 'ok',
  result: [
    {
      commodities: [
        { amount: 1, name: 'Basic Medicines', profit: 3266, total_profit: 3266 },
        { amount: 3, name: 'Biowaste', profit: 531, total_profit: 1593 },
      ],
      cumulative_profit: 4859,
      total_profit: 4859,
      distance: 9.5744,
      source: { station: "Bolden's Enterprise", system: 'Tir', market_updated_at: 1784479805 },
      destination: {
        station: 'Rosewell Agricultural Garden',
        system: 'Alberta',
        market_updated_at: 1784449144,
      },
    },
    {
      commodities: [{ amount: 69, name: 'Grain', profit: 13304, total_profit: 917976 }],
      cumulative_profit: 922835,
      total_profit: 917976,
      distance: 35.707,
      source: { station: 'Rosewell Agricultural Garden', system: 'Alberta', market_updated_at: 1784449144 },
      destination: {
        station: 'Toussaint Prospecting Hub',
        system: 'Luchtaine',
        market_updated_at: 1784451006,
      },
    },
  ],
});

const NOW = 1784480000 * 1000;

test('parses a real two-hop route, leading with the best commodity per hop', () => {
  const r = parseSpanshRoute(REAL, NOW)!;
  assert.equal(r.hops.length, 2);
  assert.equal(r.totalProfit, 922835);
  assert.equal(r.hops[0].commodity, 'Basic Medicines');
  assert.equal(r.hops[0].toStation, 'Rosewell Agricultural Garden');
  assert.equal(r.hops[0].distanceLy, 9.6);
  assert.equal(r.hops[1].commodity, 'Grain');
  assert.equal(r.hops[1].profitPerTon, 13304);
  assert.equal(r.hops[1].toSystem, 'Luchtaine');
  assert.ok(r.hops[1].marketAgeh >= 8, 'destination market age computed');
});

test('summary reads like an operator line', () => {
  const s = routeSummary(parseSpanshRoute(REAL, NOW)!);
  assert.match(s, /^Route found from Bolden's Enterprise/);
  assert.match(s, /Grain to Toussaint Prospecting Hub \(Luchtaine, 35.7 ly\)/);
  assert.match(s, /922,835 cr total/);
});

test('empty and malformed bodies yield null', () => {
  assert.equal(parseSpanshRoute('{"status":"ok","result":[]}'), null);
  assert.equal(parseSpanshRoute('not json'), null);
  assert.equal(parseSpanshRoute('{"error":"No such system"}'), null);
});

// Captured live 2026-07-20 (Sakai Mineralogic Hub, Tir — the commander's real
// starting point after the carrier-start fix).
const REAL2 = JSON.stringify({
  result: [
    {
      source: { station: 'Sakai Mineralogic Hub', system: 'Tir', market_updated_at: 1784450976 },
      destination: { station: 'Neugebauer Mines', system: 'Luchtaine', market_updated_at: 1784480621 },
      distance: 29.8381375612654,
      total_profit: 14213,
      cumulative_profit: 14213,
      commodities: [
        { name: 'Bauxite', amount: 1, profit: 14213, total_profit: 14213, source_commodity: { buy_price: 634 }, destination_commodity: { sell_price: 14847 } },
      ],
    },
    {
      source: { station: 'Neugebauer Mines', system: 'Luchtaine', market_updated_at: 1784480621 },
      destination: { station: 'Dukhnovenko Defence Installation', system: 'Ratraii', market_updated_at: 1780479693 },
      distance: 23.6525550284742,
      total_profit: 1976142,
      cumulative_profit: 1990355,
      commodities: [
        { name: 'Military Grade Fabrics', amount: 163, profit: 12122, total_profit: 1975886, source_commodity: { buy_price: 93 }, destination_commodity: { sell_price: 12215 } },
        { name: 'Hydrogen Fuel', amount: 4, profit: 64, total_profit: 256, source_commodity: { buy_price: 11 }, destination_commodity: { sell_price: 75 } },
      ],
    },
  ],
});

test('profit calculator: buy/sell prices, amounts, margins, per-trip totals', () => {
  const r = parseSpanshRoute(REAL2, NOW)!;
  assert.equal(r.totalProfit, 1990355);
  const fabrics = r.hops[1].commodities[0];
  assert.equal(fabrics.name, 'Military Grade Fabrics');
  assert.equal(fabrics.amount, 163);
  assert.equal(fabrics.buyPrice, 93);
  assert.equal(fabrics.sellPrice, 12215);
  assert.equal(fabrics.marginPct, Math.round((12122 / 93) * 100)); // ~13,034%
  assert.equal(fabrics.totalProfit, 1_975_886);
  // The hop leads with the biggest EARNER, not the best cr/t.
  assert.equal(r.hops[1].commodity, 'Military Grade Fabrics');
  assert.match(commodityLine(fabrics), /163 t Military Grade Fabrics: buy 93 → sell 12,215/);
});
