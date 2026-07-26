/** Operator tool loop — schema shape, MarketMemory queries, and runTool dispatch. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_SCHEMAS, TOOL_NAMES, runTool, type ToolContext } from '../src/engine/tools.ts';
import { MarketMemory, type MarketRecord } from '../src/engine/trade.ts';
import type { ShipLoadout } from '../src/engine/ship.ts';
import type { Mission } from '../src/engine/types.ts';
import type { TradeRoute } from '../src/engine/spansh.ts';

const nowIso = new Date().toISOString();

function market(partial: Partial<MarketRecord> & Pick<MarketRecord, 'marketId' | 'station' | 'system' | 'items'>): MarketRecord {
  return { at: nowIso, ...partial };
}

function memoryWith(...recs: MarketRecord[]): MarketMemory {
  const m = new MarketMemory();
  m.load(recs);
  return m;
}

const SAKAI = market({
  marketId: 1,
  station: 'Sakai Mineralogic Hub',
  system: 'Tir',
  items: [
    { name: 'Cobalt', buy: 2418, sell: 0, stock: 594, demand: 0 },
    { name: 'Coltan', buy: 4314, sell: 0, stock: 2077, demand: 0 },
    { name: 'Haematite', buy: 1243, sell: 0, stock: 650, demand: 0 },
    { name: 'Gold', buy: 0, sell: 48000, stock: 0, demand: 120 },
  ],
});
const NEUGEBAUER = market({
  marketId: 2,
  station: 'Neugebauer Mines',
  system: 'Luchtaine',
  at: new Date(Date.parse(nowIso) - 3600_000).toISOString(),
  items: [{ name: 'Bauxite', buy: 634, sell: 0, stock: 1200, demand: 0 }],
});

const SHIP: ShipLoadout = {
  ship: 'panther_clipper',
  shipName: 'Mule',
  maxJumpRange: 22,
  cargoCapacity: 400,
  cabins: { economy: 0, business: 0, first: 0, luxury: 0, total: 0 },
  hasFuelScoop: true,
  hasRefinery: false,
  hasCollectorLimpet: false,
  hasProspectorLimpet: false,
  hasShieldGenerator: true,
  hasFsdInterdictor: false,
  hasSurfaceScanner: false,
};

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    system: 'Tir',
    station: 'Sakai Mineralogic Hub',
    markets: memoryWith(SAKAI, NEUGEBAUER),
    ship: SHIP,
    shipDescription: 'Panther Clipper Mk II, 400 t hold',
    liveCargo: 0,
    statusLine: 'Ship status: fuel 100%, docked.',
    missions: [],
    materialsLine: null,
    exploreLine: null,
    systemIntelLine: 'Current system (Tir): security: Medium',
    planRoute: async () => null,
    galaxyMarket: null,
    findTradeRun: null,
    galnetNews: null,
    systemSurvey: null,
    ...over,
  };
}

// ---------------------------------------------------------------- schema shape

test('TOOL_SCHEMAS are well-formed OpenAI function tools with unique names', () => {
  const names = new Set<string>();
  for (const t of TOOL_SCHEMAS) {
    assert.equal(t.type, 'function');
    assert.equal(typeof t.function.name, 'string');
    assert.ok(t.function.description.length > 10, `${t.function.name} needs a description`);
    assert.equal(t.function.parameters.type, 'object');
    assert.ok(!names.has(t.function.name), `duplicate tool ${t.function.name}`);
    names.add(t.function.name);
  }
  assert.deepEqual(names, TOOL_NAMES);
  assert.ok(names.has('get_current_market') && names.has('plan_trade_route'));
});

// ------------------------------------------------------------ MarketMemory API

test('MarketMemory.latest / byId / withCommodity', () => {
  const mem = memoryWith(SAKAI, NEUGEBAUER);
  assert.equal(mem.latest()?.station, 'Sakai Mineralogic Hub'); // newest
  assert.equal(mem.latest({ station: 'Neugebauer Mines' })?.marketId, 2);
  assert.equal(mem.byId(2)?.station, 'Neugebauer Mines');
  assert.equal(mem.byId(999), null);
  const buyGold = mem.withCommodity('gold', 'sell');
  assert.equal(buyGold.length, 1);
  assert.equal(buyGold[0].market.station, 'Sakai Mineralogic Hub');
  assert.equal(mem.withCommodity('bauxite', 'buy')[0].market.station, 'Neugebauer Mines');
});

// -------------------------------------------------------------- runTool bodies

test('get_current_market lists what is actually in stock here', async () => {
  const out = await runTool('get_current_market', '', ctx());
  assert.match(out, /Sakai Mineralogic Hub/);
  assert.match(out, /Coltan/);
  assert.doesNotMatch(out, /Bauxite/); // the whole point: no phantom bauxite
});

test('find_commodity reports where to buy, and says so when unknown', async () => {
  const buy = await runTool('find_commodity', JSON.stringify({ commodity: 'Bauxite', side: 'buy' }), ctx());
  assert.match(buy, /Neugebauer Mines/);
  assert.match(buy, /634/);
  const miss = await runTool('find_commodity', JSON.stringify({ commodity: 'Palladium', side: 'buy' }), ctx());
  assert.match(miss, /No visited market/i);
});

test('plan_trade_route passes requires_large_pad for a Panther Clipper', async () => {
  let seen: { maxHops: number; requiresLargePad: boolean } | null = null;
  const route: TradeRoute = {
    hops: [{ fromStation: 'Sakai Mineralogic Hub', fromSystem: 'Tir', toStation: 'X', toSystem: 'Y', distanceLy: 12, commodity: 'Coltan', profitPerTon: 3000, totalProfit: 900000, marketAgeh: 2, commodities: [{ name: 'Coltan', amount: 400, buyPrice: 4314, sellPrice: 7314, profitPerTon: 3000, totalProfit: 1200000, marginPct: 69 }] }],
    totalProfit: 900000,
    fetchedAt: Date.now(),
  };
  const out = await runTool('plan_trade_route', JSON.stringify({ max_hops: 2 }), ctx({
    planRoute: async (opts) => { seen = opts; return route; },
  }));
  assert.ok(seen);
  assert.equal(seen!.requiresLargePad, true);
  assert.equal(seen!.maxHops, 2);
  assert.match(out, /large-pad only/);
  assert.match(out, /Coltan/);
});

test('plan_trade_route needs a starting station', async () => {
  const out = await runTool('plan_trade_route', '', ctx({ station: null }));
  assert.match(out, /needs a starting station/i);
});

test('check_fit judges hold space against live cargo', async () => {
  assert.match(await runTool('check_fit', JSON.stringify({ tons: 200 }), ctx()), /Fits/);
  assert.match(await runTool('check_fit', JSON.stringify({ tons: 500 }), ctx()), /Won't fit|exceeds/);
  assert.match(await runTool('check_fit', JSON.stringify({ tons: 100 }), ctx({ liveCargo: 350 })), /Tight/);
});

test('data tools echo their context line, with sensible empty-state text', async () => {
  assert.match(await runTool('get_ship', '', ctx()), /Panther Clipper/);
  assert.match(await runTool('get_ship_status', '', ctx()), /docked/);
  assert.match(await runTool('get_missions', '', ctx({ missions: [{ id: 1, title: 'Haul it', category: 'Delivery', reward: 50000, faction: 'Tir Gov', wing: false, expiry: null, acceptedAt: nowIso, steps: [], state: 'ACTIVE', redirected: false, killProgress: 0, raw: { timestamp: '', event: 'X' } } as unknown as Mission] })), /Haul it/);
  assert.match(await runTool('get_missions', '', ctx()), /No active missions/i);
  assert.match(await runTool('get_materials', '', ctx()), /Nothing notable/i);
  assert.match(await runTool('get_system_intel', '', ctx()), /Tir/);
});

test('runTool rejects unknown tools and malformed arguments', async () => {
  assert.match(await runTool('do_a_barrel_roll', '', ctx()), /unknown tool/i);
  assert.match(await runTool('find_commodity', '{not json', ctx()), /could not parse/i);
});

test('get_galnet_news relays headlines, and says how to switch the wire on', async () => {
  const off = await runTool('get_galnet_news', '', ctx());
  assert.match(off, /Settings/);
  assert.doesNotMatch(off, /Thargoid/);

  const on = await runTool('get_galnet_news', '', ctx({
    galnetNews: async () => [
      { title: 'Thargoid Incursion Repelled', date: '15 Jul 3311', lead: 'Aegis reports the titan withdrew.' },
    ],
  }));
  assert.match(on, /Thargoid Incursion Repelled/);
  assert.match(on, /NOT the commander/i); // the model must not claim it was there
});

test('survey_system reports logged biology, and never calls silence proof of absence', async () => {
  const found = await runTool('survey_system', JSON.stringify({ system: 'Nervi' }), ctx({
    systemSurvey: async () => ({
      system: 'Nervi', bodyCount: 12, landablePlanets: 4, earthLikes: 0, waterWorlds: 1,
      ammoniaWorlds: null, terraformables: 2,
      bodiesWithOrganics: [{ body: 'Nervi 2 a', subType: 'High metal content body', distanceLs: 1104.3, species: ['Bacterium Alcyoneum'] }],
    }),
  }));
  assert.match(found, /Nervi 2 a/);
  assert.match(found, /Bacterium Alcyoneum/);
  assert.match(found, /1104 Ls/);
  assert.match(found, /five-times.*gone|gone/i);

  const empty = await runTool('survey_system', '', ctx({
    system: 'Eol Prou PM-L c8-118',
    systemSurvey: async () => ({
      system: 'Eol Prou PM-L c8-118', bodyCount: 9, landablePlanets: 3, earthLikes: 0,
      waterWorlds: 0, ammoniaWorlds: 0, terraformables: 0, bodiesWithOrganics: [],
    }),
  }));
  assert.match(empty, /not proof/i);
  assert.match(empty, /first log/i);

  assert.match(await runTool('survey_system', '', ctx()), /Settings/);
});

test('no closed loop falls back to a one-way run rather than dead-ending', async () => {
  // The live failure: docked at Tir, asked for a "trade loop", told to go read
  // the market board by hand while a 44k cr/t run sat 30 ly away.
  const find = async () => ({
    legs: [{
      commodity: 'bauxite', fromStation: 'Webster Excavation Complex', fromSystem: 'Tir',
      toStation: 'Neugebauer Mines', toSystem: 'Luchtaine', distanceLy: 30, fromLs: 354, toLs: 1463,
      buyPrice: 629, sellPrice: 44946, profitPerTon: 44317, tons: 400, profitPerTrip: 17726800,
      stock: 2000, demand: 80644, fromPad: 3, toPad: 2, dataAgeH: 3,
    }],
    originKnown: true, checked: 8, candidates: 27,
    filters: { minPad: 2, minVolume: 1000, cargo: 400, maxAgeDays: 14 },
    origin: 'Tir',
  });
  const out = await runTool('plan_trade_route', '', ctx({ planRoute: async () => null, findTradeRun: find }));
  assert.match(out, /No closed loop/);
  assert.match(out, /Neugebauer Mines/);
  assert.match(out, /44,317 cr a ton/);
  // Without the community toggle there is nothing to fall back to; say so plainly.
  const off = await runTool('plan_trade_route', '', ctx({ planRoute: async () => null }));
  assert.match(off, /no profitable loop/i);
  assert.doesNotMatch(off, /Neugebauer/);
});

test('find_trade_run reads a ship name as "here, in this ship"', async () => {
  let sawOrigin = '';
  const find = async (o: { origin: string }) => {
    sawOrigin = o.origin;
    return { legs: [], originKnown: true, checked: 0, candidates: 0,
      filters: { minPad: 2, minVolume: 1000, cargo: 400, maxAgeDays: 14 }, origin: o.origin };
  };
  const withShip = ctx({
    system: 'Tir',
    ship: { ...SHIP, ship: 'type8', shipName: 'rahtari', shipIdent: 'MA-26T' },
    findTradeRun: find,
  });
  await runTool('find_trade_run', JSON.stringify({ system: 'rahtari' }), withShip);
  assert.equal(sawOrigin, 'Tir');
  await runTool('find_trade_run', JSON.stringify({ system: 'Ratraii' }), withShip);
  assert.equal(sawOrigin, 'Ratraii');
});
