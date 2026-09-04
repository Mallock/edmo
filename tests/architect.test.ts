/**
 * The construction-site shopping list.
 *
 * Every event below is copied from the live build at HIP 71120 on 2026-08-10 —
 * "Orbital Construction Site: Perga's Progress", 6,721 t wanted across
 * seventeen commodities, 0.27% built.
 *
 * The naming is the trap and the reason this module exists: the depot says
 * `$aluminium_name;`, the contribution receipt says `$LiquidOxygen_name;` with
 * capitals, the hold says plain `methaneclathrate`, and a market says
 * "Liquid oxygen". Four spellings of one commodity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConstructionTracker,
  architectFacts,
  buildShoppingList,
  commodityKey,
  coversFromMarket,
  describeCoverage,
  describeDepot,
  holdAtSites,
  isConstructionDepot,
  siteRoster,
  tonsRemaining,
  type SystemCommodityRow,
} from '../src/engine/architect.ts';
import type { MarketLookupRow } from '../src/engine/tools.ts';
import type { JournalEvent } from '../src/engine/types.ts';
import type { MarketRecord } from '../src/engine/trade.ts';

const at = (iso: string, o: Record<string, unknown>): JournalEvent =>
  ({ timestamp: iso, ...o }) as unknown as JournalEvent;

const NOW = Date.parse('2026-08-10T21:00:00Z');

// The real Docked event. Its LandingPads say Large 0 — and that is a LIE the
// game tells about construction sites; the commander docks here in a Panther
// Clipper Mk II. Kept in the fixture precisely so the "not trusted" test below
// is exercised against the false data rather than a tidied-up version of it.
const DOCKED = at('2026-08-10T20:43:00Z', {
  event: 'Docked',
  StationName: "Orbital Construction Site: Perga's Progress",
  StationType: 'SpaceConstructionDepot',
  StarSystem: 'HIP 71120',
  MarketID: 3955029250,
  StationServices: ['dock', 'commodities', 'colonisationcontribution'],
  LandingPads: { Small: 3, Medium: 11, Large: 0 },
});

const res = (name: string, localised: string, required: number, provided: number, payment: number) => ({
  Name: name,
  Name_Localised: localised,
  RequiredAmount: required,
  ProvidedAmount: provided,
  Payment: payment,
});

// The real requirement, trimmed to the rows the tests reason about.
const DEPOT = at('2026-08-10T20:45:41Z', {
  event: 'ColonisationConstructionDepot',
  MarketID: 3955029250,
  ConstructionProgress: 0.002678,
  ConstructionComplete: false,
  ConstructionFailed: false,
  ResourcesRequired: [
    res('$steel_name;', 'Steel', 2542, 0, 5057),
    res('$titanium_name;', 'Titanium', 1525, 0, 5360),
    res('$aluminium_name;', 'Aluminium', 1322, 0, 3239),
    res('$liquidoxygen_name;', 'Liquid oxygen', 678, 2, 2260),
    res('$water_name;', 'Water', 22, 16, 662),
    res('$fruitandvegetables_name;', 'Fruit and Vegetables', 9, 0, 865),
    res('$microcontrollers_name;', 'Micro Controllers', 13, 0, 6395),
  ],
});

const row = (o: Partial<MarketLookupRow> & { station: string; system: string }): MarketLookupRow => ({
  distanceLy: 0,
  price: 100,
  stock: 10_000,
  demand: 0,
  pad: '3',
  carrier: false,
  updatedAt: '2026-08-10T09:00:00Z',
  ...o,
});

// ------------------------------------------------------------------- the names

test('one commodity, one key, across all four spellings', () => {
  assert.equal(commodityKey('$aluminium_name;'), 'aluminium');
  assert.equal(commodityKey('$LiquidOxygen_name;'), 'liquidoxygen'); // capitals in the receipt
  assert.equal(commodityKey('Liquid oxygen'), 'liquidoxygen'); // market listing
  assert.equal(commodityKey('methaneclathrate'), 'methaneclathrate'); // Cargo.json
  assert.equal(commodityKey('Fruit and Vegetables'), 'fruitandvegetables');
  assert.equal(commodityKey(''), '');
});

test('a construction site is recognised by type or by the service it offers', () => {
  assert.equal(isConstructionDepot(DOCKED), true);
  // Planetary sites report a different type; the service is the constant.
  assert.equal(
    isConstructionDepot(at('x', { event: 'Docked', StationType: 'PlanetaryConstructionDepot' })),
    true,
  );
  assert.equal(
    isConstructionDepot(at('x', { event: 'Docked', StationType: 'Coriolis', StationServices: ['dock', 'commodities'] })),
    false,
  );
});

// ------------------------------------------------------------------ the folding

test('the depot event becomes a requirement, and docking gives it a place', () => {
  const t = new ConstructionTracker();
  t.apply(DOCKED);
  assert.equal(t.apply(DEPOT), true);
  const d = t.depot!;
  assert.equal(d.station, "Orbital Construction Site: Perga's Progress");
  assert.equal(d.system, 'HIP 71120');
  assert.equal(d.progress, 0.002678);
  // 2542+1525+1322+678+22+9+13 required, less the 18 t already provided.
  assert.equal(tonsRemaining(d), 6093);
  const water = d.resources.find((r) => r.key === 'water')!;
  assert.equal(water.provided, 16);
  assert.equal(water.remaining, 6);
});

test('a depot seen before docking is named the moment the ship lands', () => {
  const t = new ConstructionTracker();
  t.apply(DEPOT); // the panel can fire before Docked is processed
  assert.equal(t.depot!.station, null);
  assert.equal(t.apply(DOCKED), true); // docking backfills the name
  assert.equal(t.depot!.station, "Orbital Construction Site: Perga's Progress");
});

test('a contribution is credited at once, not when the depot next reports', () => {
  const t = new ConstructionTracker();
  t.apply(DOCKED);
  t.apply(DEPOT);
  // The real receipt, capitalised symbols and all.
  assert.equal(
    t.apply(at('2026-08-10T20:46:00Z', {
      event: 'ColonisationContribution',
      MarketID: 3955029250,
      Contributions: [
        { Name: '$LiquidOxygen_name;', Name_Localised: 'Liquid oxygen', Amount: 2 },
        { Name: '$Water_name;', Name_Localised: 'Water', Amount: 6 },
      ],
    })),
    true,
  );
  const d = t.depot!;
  assert.equal(d.resources.find((r) => r.key === 'liquidoxygen')!.provided, 4);
  // Water is now complete — and must not go negative or past its requirement.
  const water = d.resources.find((r) => r.key === 'water')!;
  assert.equal(water.provided, 22);
  assert.equal(water.remaining, 0);
});

test('over-delivering finishes a commodity rather than owing negative tons', () => {
  const t = new ConstructionTracker();
  t.apply(DOCKED);
  t.apply(DEPOT);
  t.apply(at('2026-08-10T20:47:00Z', {
    event: 'ColonisationContribution',
    MarketID: 3955029250,
    Contributions: [{ Name: '$Water_name;', Amount: 500 }],
  }));
  const water = t.depot!.resources.find((r) => r.key === 'water')!;
  assert.equal(water.remaining, 0);
  assert.equal(water.provided, 22);
});

test('a contribution at a DIFFERENT site does not credit this one', () => {
  const t = new ConstructionTracker();
  t.apply(DOCKED);
  t.apply(DEPOT);
  assert.equal(
    t.apply(at('x', { event: 'ColonisationContribution', MarketID: 999, Contributions: [{ Name: '$Water_name;', Amount: 6 }] })),
    false,
  );
  assert.equal(t.depot!.resources.find((r) => r.key === 'water')!.provided, 16);
});

test('the list survives a restart', () => {
  const t = new ConstructionTracker();
  t.apply(DOCKED);
  t.apply(DEPOT);
  const restored = new ConstructionTracker();
  restored.load(JSON.parse(JSON.stringify(t.toJSON())));
  assert.equal(tonsRemaining(restored.depot), 6093);
  assert.equal(restored.depot!.station, "Orbital Construction Site: Perga's Progress");
  restored.load(null);
  assert.equal(restored.depot!.system, 'HIP 71120');
});

// ------------------------------------------------------------------- the order

const listDepot = () => {
  const t = new ConstructionTracker();
  t.apply(DOCKED);
  t.apply(DEPOT);
  return t.depot!;
};

const listOf = (input = {}) => buildShoppingList(listDepot(), { nowMs: NOW, ...input });

test('what is already in the hold outranks everything else', () => {
  const groups = listOf({ cargo: new Map([['steel', 40], ['methaneclathrate', 4]]) });
  assert.equal(groups[0].bucket, 'deliver');
  assert.equal(groups[0].items[0].name, 'Steel');
  assert.equal(groups[0].items[0].deliverNow, 40);
  assert.equal(groups[0].tons, 40);
  // Methane clathrate is in the hold but the site never asked for it.
  assert.equal(groups[0].items.length, 1);
});

test('you can only hand over what is still wanted, not the whole hold', () => {
  // 6 t of water outstanding; the hold has 60.
  const groups = listOf({ cargo: new Map([['water', 60]]) });
  const water = groups[0].items.find((i) => i.key === 'water')!;
  assert.equal(water.inHold, 60);
  assert.equal(water.deliverNow, 6);
});

test("the station under the ship beats anyone else's report", () => {
  const localMarket: MarketRecord = {
    marketId: 1,
    station: 'Perga Hub',
    system: 'HIP 71120',
    at: '2026-08-10T20:40:00Z',
    items: [{ name: 'Steel', buy: 4200, sell: 4100, stock: 9000, demand: 0 }],
  };
  const groups = listOf({
    localMarket,
    sources: new Map([['steel', [row({ station: 'Elsewhere', system: 'Far', distanceLy: 12, price: 900 })]]]),
  });
  const here = groups.find((g) => g.bucket === 'here')!;
  const steel = here.items.find((i) => i.key === 'steel')!;
  assert.equal(steel.best!.station, 'Perga Hub');
  assert.equal(steel.best!.own, true);
  // The cheaper distant seller is kept as the runner-up, not discarded.
  assert.equal(steel.alternatives[0].station, 'Elsewhere');
});

test('the build leads, not the nearest errand', () => {
  // The real failure this ordering was rewritten for: against live HIP 71120
  // data the tree opened with 9 t of Fruit and Vegetables 13 ly away, and put
  // the 2,542 t of steel that IS the build at the bottom because it was 76 ly.
  const groups = listOf({
    sources: new Map([
      ['fruitandvegetables', [row({ station: 'Zoline Terminal', system: 'Close', distanceLy: 13 })]],
      ['steel', [row({ station: 'Crippen Reach', system: 'Col 285 Sector RZ-E c12-18', distanceLy: 76 })]],
    ]),
  });
  const nearby = groups.find((g) => g.bucket === 'nearby')!;
  assert.deepEqual(nearby.items.map((i) => i.name), ['Steel', 'Fruit and Vegetables']);
});

test('one seller with two lines is one stop, ranked by what it clears', () => {
  // Crippen Reach really does sell both, for 4,067 t of the 6,703 outstanding.
  const crippen = { station: 'Crippen Reach', system: 'Col 285 Sector RZ-E c12-18', distanceLy: 76 };
  const groups = listOf({
    sources: new Map([
      ['steel', [row(crippen)]],
      ['titanium', [row(crippen)]],
      // A nearer stop, but it clears far less of the build.
      ['liquidoxygen', [row({ station: 'Ventura', system: 'HIP 68830', distanceLy: 49 })]],
      ['microcontrollers', [row({ station: 'Ventura', system: 'HIP 68830', distanceLy: 49 })]],
    ]),
  });
  const nearby = groups.find((g) => g.bucket === 'nearby')!;
  // The two Crippen lines stay adjacent and lead; Ventura's pair follows.
  assert.deepEqual(
    nearby.items.map((i) => i.name),
    ['Steel', 'Titanium', 'Liquid oxygen', 'Micro Controllers'],
  );
  const steel = nearby.items[0];
  assert.equal(steel.stop!.lines, 2);
  assert.equal(steel.stop!.tons, 2542 + 1525);
  assert.equal(nearby.items[2].stop!.tons, 676 + 13);
});

test('two hauls of the same size are separated by distance', () => {
  const groups = listOf({
    sources: new Map([
      ['steel', [row({ station: 'Far Foundry', system: 'Far', distanceLy: 400 })]],
      ['titanium', [row({ station: 'Near Foundry', system: 'Near', distanceLy: 12 })]],
    ]),
  });
  const nearby = groups.find((g) => g.bucket === 'nearby')!;
  // Steel is the bigger line, so it still leads on tonnage.
  assert.deepEqual(nearby.items.map((i) => i.name), ['Steel', 'Titanium']);
  // But make them equal and the nearer one wins.
  const tied = buildShoppingList(
    { ...listDepot(), resources: listDepot().resources.map((r) => ({ ...r, remaining: 100, required: 100, provided: 0 })) },
    {
      nowMs: NOW,
      sources: new Map([
        ['steel', [row({ station: 'Far Foundry', system: 'Far', distanceLy: 400 })]],
        ['titanium', [row({ station: 'Near Foundry', system: 'Near', distanceLy: 12 })]],
      ]),
    },
  );
  const order = tied.find((g) => g.bucket === 'nearby')!.items.map((i) => i.name);
  assert.equal(order[0], 'Titanium');
});

test('looked-and-found-nobody is not the same as never looked', () => {
  const groups = listOf({ sources: new Map([['steel', []]]) });
  const unknown = groups.find((g) => g.bucket === 'unknown')!;
  const steel = unknown.items.find((i) => i.key === 'steel')!;
  assert.equal(steel.scanned, true); // searched, nothing out there
  assert.equal(unknown.items.find((i) => i.key === 'titanium')!.scanned, false); // never searched
});

test('a finished commodity drops to the bottom and out of the tonnage', () => {
  const t = new ConstructionTracker();
  t.apply(DOCKED);
  t.apply(DEPOT);
  t.apply(at('x', { event: 'ColonisationContribution', MarketID: 3955029250, Contributions: [{ Name: '$Water_name;', Amount: 6 }] }));
  const groups = buildShoppingList(t.depot, { nowMs: NOW });
  const done = groups.find((g) => g.bucket === 'done')!;
  assert.deepEqual(done.items.map((i) => i.name), ['Water']);
  assert.equal(done.tons, 0);
  assert.equal(groups.find((g) => g.bucket === 'unknown')!.items.some((i) => i.key === 'water'), false);
});

test('trips are counted against the hold the commander actually has', () => {
  const groups = listOf({ cargoCapacity: 720 });
  const steel = groups.flatMap((g) => g.items).find((i) => i.key === 'steel')!;
  assert.equal(steel.trips, 4); // 2,542 t in a 720 t hold
  assert.equal(listOf()[0].items[0].trips, null); // capacity unknown → no guess
});

test('empty in, empty out — no depot means no tree', () => {
  assert.deepEqual(buildShoppingList(null), []);
  assert.equal(describeDepot(null, []), null);
  assert.equal(architectFacts(null, []), null);
});

// ------------------------------------------------- markets we have seen ourselves

const market = (
  station: string,
  system: string,
  at: string,
  items: Array<[string, number, number]>,
): MarketRecord => ({
  marketId: station.length + system.length,
  station,
  system,
  at,
  items: items.map(([name, buy, stock]) => ({ name, buy, sell: 0, stock, demand: 0 })),
});

test('a station we docked at in the build system needs no jump, and leads', () => {
  // Ardent has never heard of HIP 71120 — it was colonised days ago. The only
  // way the list can know Perga Hub sells steel is that we docked and read it.
  const groups = listOf({
    visited: [market('Perga Hub', 'HIP 71120', '2026-08-10T20:00:00Z', [['Steel', 4200, 9000]])],
    sources: new Map([
      ['steel', [row({ station: 'Crippen Reach', system: 'Col 285 Sector RZ-E c12-18', distanceLy: 76, price: 3425 })]],
      // Titanium is only available out of system, so both groups exist.
      ['titanium', [row({ station: 'Crippen Reach', system: 'Col 285 Sector RZ-E c12-18', distanceLy: 76 })]],
    ]),
  });
  const inSystem = groups.find((g) => g.bucket === 'system')!;
  assert.match(inSystem.title, /In HIP 71120 — no jump/);
  const steel = inSystem.items.find((i) => i.key === 'steel')!;
  assert.equal(steel.best!.station, 'Perga Hub');
  assert.equal(steel.best!.inSystem, true);
  assert.equal(steel.best!.own, true);
  // The cheaper 76 ly seller is kept underneath, not thrown away.
  assert.equal(steel.alternatives[0].station, 'Crippen Reach');
  // ...and the in-system group outranks the nearby one.
  const order = groups.map((g) => g.bucket);
  assert.ok(order.indexOf('system') < order.indexOf('nearby'));
});

test('several stations in the system are all remembered, cheapest first', () => {
  const groups = listOf({
    visited: [
      market('Perga Hub', 'HIP 71120', '2026-08-10T20:00:00Z', [['Steel', 4200, 9000]]),
      market('Dagny Port', 'HIP 71120', '2026-08-10T19:00:00Z', [['Steel', 3800, 400], ['Titanium', 5100, 2000]]),
    ],
  });
  const inSystem = groups.find((g) => g.bucket === 'system')!;
  const steel = inSystem.items.find((i) => i.key === 'steel')!;
  assert.equal(steel.best!.station, 'Dagny Port'); // 3,800 beats 4,200
  assert.equal(steel.alternatives[0].station, 'Perga Hub');
  assert.equal(inSystem.items.find((i) => i.key === 'titanium')!.best!.station, 'Dagny Port');
});

test('what we read ourselves replaces a report about the same station', () => {
  const groups = listOf({
    visited: [market('Crippen Reach', 'Col 285 Sector RZ-E c12-18', '2026-08-10T18:00:00Z', [['Steel', 4400, 120]])],
    sources: new Map([
      // The 71-day-old community row for the SAME station claims 8,173 t.
      ['steel', [row({
        station: 'Crippen Reach',
        system: 'Col 285 Sector RZ-E c12-18',
        distanceLy: 76,
        price: 3425,
        stock: 8173,
        updatedAt: '2026-05-31T19:57:18Z',
      })]],
    ]),
  });
  const steel = groups.flatMap((g) => g.items).find((i) => i.key === 'steel')!;
  assert.equal(steel.best!.own, true);
  assert.equal(steel.best!.stock, 120); // what we actually saw, not the rumour
  // The stale duplicate is gone rather than sitting underneath contradicting us.
  assert.equal(steel.alternatives.some((s) => s.station === 'Crippen Reach'), false);
});

test('a station we found empty is not offered back to us', () => {
  const groups = listOf({
    // We docked at Crippen Reach and it had steel but no titanium.
    visited: [market('Crippen Reach', 'Col 285 Sector RZ-E c12-18', '2026-08-10T18:00:00Z', [['Steel', 4400, 120]])],
    sources: new Map([
      ['titanium', [row({ station: 'Crippen Reach', system: 'Col 285 Sector RZ-E c12-18', distanceLy: 76 })]],
    ]),
  });
  const titanium = groups.flatMap((g) => g.items).find((i) => i.key === 'titanium')!;
  assert.equal(titanium.best, null);
  assert.equal(titanium.bucket, 'unknown');
  assert.equal(titanium.scanned, true);
});

test('a station in the build system beats a cheaper one out of system', () => {
  // The real shape of the HIP 71120 answer: Niinimäki, a crater outpost in the
  // build's own system, holds 371,309 t of steel — while the galaxy-wide sweep
  // was recommending Crippen Reach, 76 ly away, because it was 31 cr cheaper.
  const groups = listOf({
    sources: new Map([
      ['steel', [
        row({ station: 'Crippen Reach', system: 'Col 285 Sector RZ-E c12-18', distanceLy: 76, price: 3425, stock: 8173 }),
        row({ station: 'Niinimäki', system: 'HIP 71120', distanceLy: 0, price: 3456, stock: 371_309 }),
      ]],
    ]),
  });
  const inSystem = groups.find((g) => g.bucket === 'system')!;
  const steel = inSystem.items.find((i) => i.key === 'steel')!;
  assert.equal(steel.best!.station, 'Niinimäki');
  assert.equal(steel.best!.inSystem, true);
  assert.equal(steel.best!.own, false); // community data, not our own eyes
  assert.equal(steel.alternatives[0].station, 'Crippen Reach');
});

test('a market we read ourselves still leads the in-system community rows', () => {
  const groups = listOf({
    visited: [market('Anders City', 'HIP 71120', '2026-08-10T20:00:00Z', [['Steel', 3518, 60_021]])],
    sources: new Map([
      ['steel', [row({ station: 'Niinimäki', system: 'HIP 71120', distanceLy: 0, price: 3456, stock: 371_309 })]],
    ]),
  });
  const steel = groups.flatMap((g) => g.items).find((i) => i.key === 'steel')!;
  assert.equal(steel.best!.station, 'Anders City'); // dearer, but we SAW it
  assert.equal(steel.best!.own, true);
  assert.equal(steel.alternatives[0].station, 'Niinimäki');
});

test('a docking reports what it covers of the build', () => {
  const depot = listDepot();
  const covers = coversFromMarket(
    depot,
    market('Perga Hub', 'HIP 71120', '2026-08-10T20:00:00Z', [
      ['Steel', 4200, 9000],
      ['Bromellite', 800, 40], // not part of the build
      ['Water', 120, 500],
    ]),
  );
  assert.deepEqual(covers.map((c) => c.name), ['Steel', 'Water']); // biggest need first
  assert.equal(covers[0].needed, 2542);
  const line = describeCoverage('Perga Hub', covers, true)!;
  assert.match(line, /Perga Hub sells Steel \(2,542 t of the 2,542 t wanted\), Water/);
  assert.match(line, /no jump/);
  // A station holding less than the need says so honestly.
  const thin = coversFromMarket(depot, market('Tiny', 'HIP 71120', '2026-08-10T20:00:00Z', [['Steel', 4200, 60]]));
  assert.match(describeCoverage('Tiny', thin, true)!, /Steel \(60 t of the 2,542 t wanted\)/);
  assert.equal(describeCoverage('Nowhere', [], true), null);
});

// ------------------------------------------------------------------ the telling

test("the site's own pad count is not trusted, because it lies", () => {
  // DOCKED carries the real journal figures: {Small: 3, Medium: 11, Large: 0}.
  // Those numbers are WRONG. The same commander docked at this site four times
  // in a Panther Clipper Mk II — a 1,046 t large-pad-only hauler — and the
  // event reported Large 0 every time. A warning built on this field told them
  // their ship could not dock at a pad they were standing on.
  const t = new ConstructionTracker();
  t.apply(DOCKED);
  t.apply(DEPOT);
  const depot = t.depot!;
  // The field is not carried at all, so nothing downstream can reach for it.
  assert.equal('pads' in depot, false);
  assert.equal(JSON.stringify(t.toJSON()).includes('pads'), false);
});

test('the summary leads with what can be handed over right now', () => {
  const t = new ConstructionTracker();
  t.apply(DOCKED);
  t.apply(DEPOT);
  const withCargo = buildShoppingList(t.depot, { nowMs: NOW, cargo: new Map([['steel', 40]]) });
  const line = describeDepot(t.depot, withCargo)!;
  assert.match(line, /6,093 t still wanted across 7 commodities, 0.3% built/);
  assert.match(line, /carrying 40 t of Steel/);
  // With an empty hold it names the long pole instead.
  assert.match(describeDepot(t.depot, buildShoppingList(t.depot, { nowMs: NOW }))!, /long pole is Steel, 2,542 t/);
});

test('the model is handed the plan, and told when its sources are rumours', () => {
  const t = new ConstructionTracker();
  t.apply(DOCKED);
  t.apply(DEPOT);
  const groups = buildShoppingList(t.depot, {
    nowMs: NOW,
    sources: new Map([['steel', [row({ station: 'Old Yard', system: 'Stale', distanceLy: 9, updatedAt: '2026-07-01T00:00:00Z' })]]]),
  });
  const facts = architectFacts(t.depot, groups)!;
  assert.match(facts, /CONSTRUCTION: Orbital Construction Site: Perga's Progress in HIP 71120/);
  assert.match(facts, /Steel 2,542 t — Old Yard \(Stale, 9 ly\) at 100 cr/);
  assert.match(facts, /1 of these sources are community reports over 7 days old/);
});

// ---------------------------------------------------------------- many depots

const site = (id: number, name: string) => ({
  event: 'Docked',
  StationName: name,
  StationType: 'SpaceConstructionDepot',
  StarSystem: 'Preae Aihm EH-D d12-64',
  MarketID: id,
  StationServices: ['dock', 'commodities', 'colonisationcontribution'],
});

/** Nth hour of the build week, so eviction order is unambiguous. */
const hour = (n: number): string =>
  new Date(Date.parse('2026-08-01T09:00:00Z') + n * 3_600_000).toISOString();

/** Dock at a site and read its board, in the order the game writes them. */
const visit = (
  t: ConstructionTracker,
  id: number,
  name: string,
  iso: string,
  o: { complete?: boolean; steel?: number; given?: number } = {},
): void => {
  t.apply(at(iso, site(id, name)));
  t.apply(
    at(iso, {
      event: 'ColonisationConstructionDepot',
      MarketID: id,
      ConstructionProgress: 0.1,
      ConstructionComplete: o.complete ?? false,
      ResourcesRequired: [res('$steel_name;', 'Steel', o.steel ?? 1000, o.given ?? 0, 5000)],
    }),
  );
};

test('docking at a second site does not forget the first', () => {
  const t = new ConstructionTracker();
  visit(t, 3800001, 'Orbital Construction Site: Perga’s Progress', hour(1), { steel: 2542 });
  visit(t, 3800002, 'Orbital Construction Site: Forsberg Sanctuary', hour(9), { steel: 900 });
  assert.equal(t.all.length, 2);
  // The one under the ship is the active one, and it is the second.
  assert.equal(t.depot?.marketId, 3800002);
  assert.equal(t.all[0].marketId, 3800002);
  const first = t.all.find((d) => d.marketId === 3800001)!;
  assert.equal(first.resources[0].remaining, 2542);
  assert.equal(first.station, 'Orbital Construction Site: Perga’s Progress');
});

test('docking again at a remembered site makes it the active one', () => {
  const t = new ConstructionTracker();
  visit(t, 3800001, 'Site One', hour(1));
  visit(t, 3800002, 'Site Two', hour(9));
  t.apply(at(hour(20), site(3800001, 'Site One')));
  assert.equal(t.depot?.marketId, 3800001);
  assert.equal(t.all.length, 2);
});

test('docking somewhere whose board we have never opened keeps the last list', () => {
  // ColonisationConstructionDepot is written when the contribution panel is
  // opened, not when the ship lands — so a docking on its own must never take
  // a requirement off the screen.
  const t = new ConstructionTracker();
  visit(t, 3800001, 'Site One', hour(1), { steel: 1000 });
  t.apply(at(hour(9), site(3800002, 'Site Two')));
  assert.equal(t.depot?.marketId, 3800001);
  assert.equal(t.depot?.resources[0].remaining, 1000);
  // And the moment its board IS opened, it takes over.
  t.apply(
    at(hour(10), {
      event: 'ColonisationConstructionDepot',
      MarketID: 3800002,
      ConstructionProgress: 0.2,
      ResourcesRequired: [res('$titanium_name;', 'Titanium', 1525, 0, 4000)],
    }),
  );
  assert.equal(t.depot?.marketId, 3800002);
  assert.equal(t.depot?.station, 'Site Two');
});

test('a contribution is credited to its own site, never to a sibling', () => {
  const t = new ConstructionTracker();
  visit(t, 3800001, 'Site One', hour(1), { steel: 1000 });
  visit(t, 3800002, 'Site Two', hour(9), { steel: 1000 });
  t.apply(
    at(hour(10), {
      event: 'ColonisationContribution',
      MarketID: 3800002,
      Contributions: [{ Name: '$Steel_name;', Amount: 400 }],
    }),
  );
  const one = t.all.find((d) => d.marketId === 3800001)!;
  const two = t.all.find((d) => d.marketId === 3800002)!;
  assert.equal(one.resources[0].provided, 0);
  assert.equal(one.resources[0].remaining, 1000);
  assert.equal(two.resources[0].provided, 400);
  assert.equal(two.resources[0].remaining, 600);
});

test('re-reading a known board replaces it, and does not add a second entry', () => {
  const t = new ConstructionTracker();
  visit(t, 3800001, 'Site One', hour(1), { steel: 1000 });
  visit(t, 3800001, 'Site One', hour(40), { steel: 1000, given: 640 });
  assert.equal(t.all.length, 1);
  assert.equal(t.depot?.resources[0].provided, 640);
  assert.equal(t.depot?.resources[0].remaining, 360);
});

test('a finished build is the first memory to go when the cap is reached', () => {
  const t = new ConstructionTracker();
  // Site 20 is done — and done is the least useful thing to remember.
  for (let i = 1; i <= 32; i++) visit(t, i, `Site ${i}`, hour(i), { complete: i === 20 });
  assert.equal(t.all.length, 32);
  visit(t, 33, 'Site 33', hour(100));
  assert.equal(t.all.length, 32);
  assert.ok(!t.all.some((d) => d.marketId === 20), 'the completed build was evicted');
  // The oldest outstanding one is still there: finished beats old.
  assert.ok(t.all.some((d) => d.marketId === 1));
  assert.ok(t.all.some((d) => d.marketId === 33));
});

test('the site under the ship is never the one forgotten', () => {
  const t = new ConstructionTracker();
  for (let i = 1; i <= 32; i++) visit(t, i, `Site ${i}`, hour(i));
  // Dock at the first site again, logged as the oldest docking of all — now
  // the active site is also the one eviction would otherwise reach for.
  t.apply(at(hour(-500), site(1, 'Site 1')));
  assert.equal(t.depot?.marketId, 1);
  // A thirty-third board read, without undocking from site 1.
  t.apply(
    at(hour(100), {
      event: 'ColonisationConstructionDepot',
      MarketID: 33,
      ConstructionProgress: 0.1,
      ResourcesRequired: [res('$steel_name;', 'Steel', 1000, 0, 5000)],
    }),
  );
  assert.equal(t.all.length, 32);
  assert.equal(t.depot?.marketId, 1, 'the active site survived');
  assert.ok(!t.all.some((d) => d.marketId === 2), 'the oldest other one went instead');
});

test('the old single-depot save loads with its tonnage intact', () => {
  const t = new ConstructionTracker();
  // Exactly the shape every version up to 1.9.3 wrote.
  t.load({
    depot: {
      marketId: 3955029250,
      station: 'Orbital Construction Site: Perga’s Progress',
      system: 'HIP 71120',
      progress: 0.002678,
      complete: false,
      failed: false,
      at: '2026-08-10T20:45:41Z',
      resources: [
        { key: 'steel', name: 'Steel', required: 2542, provided: 12, remaining: 2530, payment: 5000 },
      ],
    },
  });
  assert.equal(t.all.length, 1);
  assert.equal(t.depot?.marketId, 3955029250);
  assert.equal(t.depot?.resources[0].remaining, 2530);
});

test('the many-depot save round-trips, active site and all', () => {
  const t = new ConstructionTracker();
  visit(t, 3800001, 'Site One', hour(1), { steel: 1000 });
  visit(t, 3800002, 'Site Two', hour(9), { steel: 500 });
  const back = new ConstructionTracker();
  back.load(JSON.parse(JSON.stringify(t.toJSON())));
  assert.equal(back.all.length, 2);
  assert.equal(back.depot?.marketId, 3800002);
  assert.equal(back.all.find((d) => d.marketId === 3800001)?.resources[0].remaining, 1000);
});

test('an unreadable save leaves the tracker empty rather than throwing', () => {
  const bad = [
    null,
    {},
    { depot: null },
    { depot: { marketId: 1, resources: 'not an array' } },
    { depots: [{ marketId: 0, resources: [] }], activeId: 99 },
    { depots: 'nope' },
  ] as unknown as Array<Parameters<ConstructionTracker['load']>[0]>;
  for (const d of bad) {
    const t = new ConstructionTracker();
    assert.doesNotThrow(() => t.load(d));
    assert.equal(t.all.length, 0);
    assert.equal(t.depot, null);
  }
});

// ---------------------------------------------------------------- the roster

/**
 * A real whole-system sweep, captured from
 * api.ardent-insight.com/v2/system/name/Preae%20Aihm%20EH-D%20d12-64/commodities
 * on 2026-08-29 and trimmed exactly the way spansh.test.ts trims a route: the
 * fields the Rust mapper forwards, every construction site in the system, and
 * at most three of each site's commodity rows.
 *
 * The numbers below are the point of the fixture. 42 stations in this ONE
 * system are construction depots; twelve of them have ever been reported, and
 * thirty are known to exist and nothing more. And on every single row, across
 * all 160 in the untrimmed capture, `demand` is 0 — which is why a SiteListing
 * carries no tonnage.
 */
const SWEPT = Date.parse('2026-08-29T12:00:00Z');
const PREAE = 'Preae Aihm EH-D d12-64';

const r = (
  commodity: string | null,
  station: string,
  stationType: string,
  price: number | null,
  pad: string | null,
  distanceLs: number | null,
  updatedAt: string | null,
): SystemCommodityRow => ({
  commodity,
  station,
  system: PREAE,
  stationType,
  price,
  pad,
  distanceLs,
  updatedAt,
});

const SWEEP: SystemCommodityRow[] = [
  r(null, 'Orbital Construction Site: Coney Platform', 'SpaceConstructionDepot', null, '2', 11413, null),
  r(null, 'Orbital Construction Site: Mattingly\'s Inheritance', 'SpaceConstructionDepot', null, '2', 11413, null),
  r(null, 'Orbital Construction Site: Polya Sanctuary', 'SpaceConstructionDepot', null, '2', 11762, null),
  r(null, 'Orbital Construction Site: Coolidge\'s Inheritance', 'SpaceConstructionDepot', null, '2', 11437, null),
  r(null, 'Orbital Construction Site: Horrocks Vista', 'SpaceConstructionDepot', null, '2', 0, null),
  r(null, 'Orbital Construction Site: Oja Depot', 'SpaceConstructionDepot', null, '2', 140, null),
  r(null, 'Orbital Construction Site: Pordenone Vista', 'SpaceConstructionDepot', null, '2', 11461, null),
  r(null, 'Orbital Construction Site: Fincke Terminal', 'SpaceConstructionDepot', null, '2', 11436, null),
  r(null, 'Orbital Construction Site: Balfonheim Smeltery', 'SpaceConstructionDepot', null, '2', 11451, null),
  r(null, 'Orbital Construction Site: Vlaicu Point', 'SpaceConstructionDepot', null, '2', 11428, null),
  r(null, 'Orbital Construction Site: Jean Reach', 'SpaceConstructionDepot', null, '2', 11413, null),
  r(null, 'Goldbart Legacy', 'PlanetaryConstructionDepot', null, '3', 11416, null),
  r(null, 'Freud Terminal', 'PlanetaryConstructionDepot', null, '3', 11414, null),
  r(null, 'Zulawski Terminal', 'PlanetaryConstructionDepot', null, '3', 11414, null),
  r(null, 'Avogadro City', 'PlanetaryConstructionDepot', null, '3', 11414, null),
  r(null, 'Orbital Construction Site: Galtea\'s Forge', 'SpaceConstructionDepot', null, '2', 11418, null),
  r(null, 'Orbital Construction Site: Snow City', 'SpaceConstructionDepot', null, '2', 11762, null),
  r(null, 'Orbital Construction Site: McGuire Enterprise', 'SpaceConstructionDepot', null, '2', 11760, null),
  r(null, 'Orbital Construction Site: Stebbins Town', 'SpaceConstructionDepot', null, '2', 11760, null),
  r(null, 'Orbital Construction Site: Trimble Relay', 'SpaceConstructionDepot', null, '2', 0, null),
  r(null, 'Orbital Construction Site: Shapley City', 'SpaceConstructionDepot', null, '2', 11440, null),
  r(null, 'Orbital Construction Site: Weizsacker\'s Inheritance', 'SpaceConstructionDepot', null, '2', 11429, null),
  r(null, 'Orbital Construction Site: Shear\'s Progress', 'SpaceConstructionDepot', null, '2', 140, null),
  r(null, 'Orbital Construction Site: Creighton Vista', 'SpaceConstructionDepot', null, '2', 138, null),
  r(null, 'Orbital Construction Site: OrtizMoreno\'s Folly', 'SpaceConstructionDepot', null, '2', 11453, null),
  r(null, 'Orbital Construction Site: Baille Hub', 'SpaceConstructionDepot', null, '2', 11774, null),
  r(null, 'Dukaj Terminal', 'PlanetaryConstructionDepot', null, '3', 11457, null),
  r(null, 'Orbital Construction Site: Siodmak Gateway', 'SpaceConstructionDepot', null, '2', 11783, null),
  r(null, 'Orbital Construction Site: Marcos Prospect', 'SpaceConstructionDepot', null, '2', 11962, null),
  r(null, 'Orbital Construction Site: Winterbottom Vista', 'SpaceConstructionDepot', null, '2', 11546, null),
  r('advancedcatalysers', 'Crevenna Town', 'PlanetaryConstructionDepot', 1986, '3', 11772, '2026-07-15T12:39:38Z'),
  r('evacuationshelter', 'Crevenna Town', 'PlanetaryConstructionDepot', 218, '3', 11772, '2026-07-15T12:39:38Z'),
  r('fruitandvegetables', 'Crevenna Town', 'PlanetaryConstructionDepot', 218, '3', 11772, '2026-07-15T12:39:38Z'),
  r('aluminium', 'Orbital Construction Site: Forsberg Sanctuary', 'SpaceConstructionDepot', 1738, '2', 11737, '2026-07-14T12:41:09Z'),
  r('basicmedicines', 'Orbital Construction Site: Forsberg Sanctuary', 'SpaceConstructionDepot', 218, '2', 11737, '2026-07-14T11:58:12Z'),
  r('ceramiccomposites', 'Orbital Construction Site: Forsberg Sanctuary', 'SpaceConstructionDepot', 118, '2', 11737, '2026-07-14T12:09:35Z'),
  r('aluminium', 'Orbital Construction Site: Balfonheim City', 'SpaceConstructionDepot', 1738, '2', 11959, '2026-07-15T15:50:41Z'),
  r('cmmcomposite', 'Orbital Construction Site: Balfonheim City', 'SpaceConstructionDepot', 4193, '2', 11959, '2026-07-15T16:38:50Z'),
  r('liquidoxygen', 'Orbital Construction Site: Balfonheim City', 'SpaceConstructionDepot', 565, '2', 11959, '2026-07-15T11:13:24Z'),
  r('aluminium', 'Orbital Construction Site: Revin Depot', 'SpaceConstructionDepot', 1738, '2', 11737, '2026-07-14T14:06:53Z'),
  r('ceramiccomposites', 'Orbital Construction Site: Revin Depot', 'SpaceConstructionDepot', 118, '2', 11737, '2026-07-14T13:52:36Z'),
  r('computercomponents', 'Orbital Construction Site: Revin Depot', 'SpaceConstructionDepot', 371, '2', 11737, '2026-07-14T14:39:20Z'),
  r('aluminium', 'Orbital Construction Site: Bohnhoff Enterprise', 'SpaceConstructionDepot', 1701, '2', 11774, '2026-07-13T01:18:02Z'),
  r('ceramiccomposites', 'Orbital Construction Site: Bohnhoff Enterprise', 'SpaceConstructionDepot', 108, '2', 11774, '2026-07-13T01:55:38Z'),
  r('computercomponents', 'Orbital Construction Site: Bohnhoff Enterprise', 'SpaceConstructionDepot', 351, '2', 11774, '2026-07-13T01:55:38Z'),
  r('aluminium', 'Orbital Construction Site: Grego\'s Inheritance', 'SpaceConstructionDepot', 1738, '2', 11777, '2026-07-13T13:45:44Z'),
  r('basicmedicines', 'Orbital Construction Site: Grego\'s Inheritance', 'SpaceConstructionDepot', 213, '2', 11777, '2026-07-13T13:15:23Z'),
  r('buildingfabricators', 'Orbital Construction Site: Grego\'s Inheritance', 'SpaceConstructionDepot', 1510, '2', 11777, '2026-07-13T13:15:23Z'),
  r('basicmedicines', 'Orbital Construction Site: Brorsen Beacon', 'SpaceConstructionDepot', 213, '2', 11777, '2026-07-13T13:16:58Z'),
  r('buildingfabricators', 'Orbital Construction Site: Brorsen Beacon', 'SpaceConstructionDepot', 1510, '2', 11777, '2026-07-13T13:16:58Z'),
  r('ceramiccomposites', 'Orbital Construction Site: Brorsen Beacon', 'SpaceConstructionDepot', 118, '2', 11777, '2026-07-13T14:43:01Z'),
  r('basicmedicines', 'Orbital Construction Site: Sutcliffe Sanctuary', 'SpaceConstructionDepot', 213, '2', 11777, '2026-07-13T13:18:25Z'),
  r('buildingfabricators', 'Orbital Construction Site: Sutcliffe Sanctuary', 'SpaceConstructionDepot', 1510, '2', 11777, '2026-07-13T13:18:25Z'),
  r('copper', 'Orbital Construction Site: Sutcliffe Sanctuary', 'SpaceConstructionDepot', 324, '2', 11777, '2026-07-13T13:18:25Z'),
  r('ceramiccomposites', 'Orbital Construction Site: Eisenstein Hub', 'SpaceConstructionDepot', 110, '2', 11774, '2026-07-13T01:59:05Z'),
  r('computercomponents', 'Orbital Construction Site: Eisenstein Hub', 'SpaceConstructionDepot', 356, '2', 11774, '2026-07-13T01:59:05Z'),
  r('copper', 'Orbital Construction Site: Eisenstein Hub', 'SpaceConstructionDepot', 316, '2', 11774, '2026-07-13T01:59:05Z'),
  r('ceramiccomposites', 'Orbital Construction Site: Murakami Gateway', 'SpaceConstructionDepot', 118, '2', 11412, '2026-07-15T12:01:49Z'),
  r('cmmcomposite', 'Orbital Construction Site: Murakami Gateway', 'SpaceConstructionDepot', 4193, '2', 11412, '2026-07-15T11:56:36Z'),
  r('fish', 'Orbital Construction Site: Murakami Gateway', 'SpaceConstructionDepot', 284, '2', 11412, '2026-07-15T11:03:48Z'),
  r('ceramiccomposites', 'Orbital Construction Site: Wandrei Point', 'SpaceConstructionDepot', 118, '2', 11548, '2026-07-16T04:45:58Z'),
  r('cmmcomposite', 'Orbital Construction Site: Wandrei Point', 'SpaceConstructionDepot', 4193, '2', 11548, '2026-07-16T04:46:03Z'),
  r('copper', 'Orbital Construction Site: Wandrei Point', 'SpaceConstructionDepot', 331, '2', 11548, '2026-07-16T04:45:58Z'),
  r('steel', 'Orbital Construction Site: The Rock At Balfonheim', 'SpaceConstructionDepot', 2985, '2', 11460, '2026-07-16T06:51:48Z'),
  r('advancedcatalysers', 'Trimble Relay', 'Outpost', 2523, '2', 14, '2026-08-10T12:23:34Z'),
  r('fruitandvegetables', 'V8Z-4XK', 'FleetCarrier', 483, '3', 0, '2026-07-08T01:40:17Z'),
  r('agriculturalmedicines', 'Balfonheim Productions', 'CraterOutpost', 982, '3', 11410, '2026-08-17T19:00:48Z'),
];

test('the sweep already in hand names every construction site in the system', () => {
  const roster = siteRoster(SWEEP, { first: PREAE, nowMs: SWEPT });
  assert.equal(roster.length, 42, 'every construction depot in the system');
  const reported = roster.filter((s) => s.commodities.length);
  const unreported = roster.filter((s) => !s.commodities.length);
  assert.equal(reported.length, 12);
  // Dropping these would say the system holds twelve sites when it holds 42.
  assert.equal(unreported.length, 30);
  // Sites with something known about them lead; the unreported ones follow.
  assert.ok(roster.slice(0, 12).every((s) => s.commodities.length));
  // The outpost, the carrier and the crater outpost in the same response are
  // not construction sites and must not appear.
  assert.ok(!roster.some((s) => s.station === 'Trimble Relay'));
  assert.ok(!roster.some((s) => s.station === 'V8Z-4XK'));
  assert.ok(!roster.some((s) => s.station === 'Balfonheim Productions'));
});

test('a site listing carries its commodities, its pad and its distance', () => {
  const roster = siteRoster(SWEEP, { first: PREAE, nowMs: SWEPT });
  const forsberg = roster.find((s) => s.station.endsWith('Forsberg Sanctuary'))!;
  assert.equal(forsberg.stationType, 'SpaceConstructionDepot');
  assert.equal(forsberg.pad, '2');
  assert.equal(forsberg.distanceLs, 11737);
  assert.deepEqual(
    forsberg.commodities.map((c) => c.key),
    ['aluminium', 'basicmedicines', 'ceramiccomposites'],
  );
  assert.equal(forsberg.commodities.find((c) => c.key === 'aluminium')?.payment, 1738);
});

test('a site listing carries no tonnage, ever', () => {
  // Structural, not a spot check: EDDN reports demand 0 for every construction
  // depot row, so any field here that could be read as "how much it wants" is
  // a figure the app invented. A missing field cannot be misread.
  const forbidden = [
    'required',
    'provided',
    'remaining',
    'demand',
    'stock',
    'tons',
    'tonnage',
    'amount',
    'quantity',
    'needed',
    'outstanding',
  ];
  const roster = siteRoster(SWEEP, { first: PREAE, nowMs: SWEPT });
  assert.ok(roster.length > 0);
  for (const s of roster) {
    for (const k of Object.keys(s)) assert.ok(!forbidden.includes(k.toLowerCase()), `${k} on a listing`);
    for (const c of s.commodities) {
      for (const k of Object.keys(c)) assert.ok(!forbidden.includes(k.toLowerCase()), `${k} on a commodity`);
    }
  }
});

test('a six-week-old board is shown as a rumour, not a destination', () => {
  const roster = siteRoster(SWEEP, { first: PREAE, nowMs: SWEPT });
  const forsberg = roster.find((s) => s.station.endsWith('Forsberg Sanctuary'))!;
  // Reported 2026-07-14, swept 2026-08-29.
  assert.equal(forsberg.ageDays, 45);
  assert.equal(forsberg.stale, true);
  // A site nobody has ever reported has no age at all — and "undated" is not
  // "fresh", so it is never allowed to sit above a dated report.
  const quiet = roster.find((s) => !s.commodities.length)!;
  assert.equal(quiet.updatedAt, null);
  assert.equal(quiet.ageDays, null);
  assert.equal(quiet.stale, true);
});

test('a site we have docked at appears once, as our own, not twice', () => {
  const t = new ConstructionTracker();
  t.apply(
    at('2026-08-29T08:00:00Z', {
      event: 'Docked',
      StationName: 'Orbital Construction Site: Forsberg Sanctuary',
      StationType: 'SpaceConstructionDepot',
      StarSystem: PREAE,
      MarketID: 3800077,
    }),
  );
  t.apply(
    at('2026-08-29T08:00:10Z', {
      event: 'ColonisationConstructionDepot',
      MarketID: 3800077,
      ConstructionProgress: 0.4,
      ResourcesRequired: [res('$aluminium_name;', 'Aluminium', 1322, 300, 1738)],
    }),
  );
  const roster = siteRoster(SWEEP, { known: t.all, first: PREAE, nowMs: SWEPT });
  assert.equal(roster.length, 41, 'the visited site left the community list');
  assert.ok(!roster.some((s) => s.station.endsWith('Forsberg Sanctuary')));
  // And the first-hand record is the one that survives — with its tonnage.
  assert.equal(t.all[0].resources[0].remaining, 1022);
});

test('the current system leads, and the build system follows', () => {
  const elsewhere = SWEEP.filter((row) => row.station.endsWith('Wandrei Point')).map((row) => ({
    ...row,
    system: 'HIP 71120',
  }));
  const roster = siteRoster([...elsewhere, ...SWEEP], { first: 'HIP 71120', nowMs: SWEPT });
  assert.equal(roster[0].system, 'HIP 71120');
  assert.ok(roster.slice(1).every((s) => s.system === PREAE));
});

// ------------------------------------------------------------------- the hold

test('what is aboard is matched to who takes it, however it is spelled', () => {
  const roster = siteRoster(SWEEP, { first: PREAE, nowMs: SWEPT });
  // The hold says 'liquidoxygen'; a depot would say '$LiquidOxygen_name;'.
  // Both have to land on the same site listing or the panel says nothing.
  const cargo = new Map([[commodityKey('$LiquidOxygen_name;'), 96]]);
  const [match] = holdAtSites(cargo, roster);
  assert.equal(match.key, 'liquidoxygen');
  assert.equal(match.tons, 96);
  assert.equal(match.note, null);
  assert.equal(match.sites.length, 1);
  assert.equal(match.sites[0].station, 'Orbital Construction Site: Balfonheim City');
  assert.equal(match.sites[0].payment, 565);
  assert.equal(match.sites[0].pad, '2');
  assert.equal(match.sites[0].distanceLs, 11959);
  assert.equal(match.sites[0].ageDays, 44);
});

test('several sites taking the same thing are all named, best paid first', () => {
  const roster = siteRoster(SWEEP, { first: PREAE, nowMs: SWEPT });
  const match = holdAtSites(new Map([['ceramiccomposites', 40]]), roster)[0];
  assert.equal(match.sites.length, 7);
  assert.deepEqual(
    match.sites.map((s) => s.payment),
    [118, 118, 118, 118, 118, 110, 108],
  );
});

test('nothing here taking it is said out loud, not left blank', () => {
  const roster = siteRoster(SWEEP, { first: PREAE, nowMs: SWEPT });
  const match = holdAtSites(new Map([['tritium', 300]]), roster)[0];
  assert.equal(match.sites.length, 0);
  assert.match(match.note ?? '', /no known site here accepts this/i);
});

test('the name a site listing shows is the one the game wrote', () => {
  // Ardent squashes it to 'liquidoxygen'; the hold spells it out. Where the
  // journal has given us a spelling, that is the one on the panel.
  const names = new Map([['liquidoxygen', 'Liquid oxygen']]);
  const roster = siteRoster(SWEEP, { names, first: PREAE, nowMs: SWEPT });
  const balfonheim = roster.find((s) => s.station.endsWith('Balfonheim City'))!;
  assert.equal(balfonheim.commodities.find((c) => c.key === 'liquidoxygen')?.name, 'Liquid oxygen');
  // And where it has not, the key is shown as it is rather than guessed at.
  assert.equal(balfonheim.commodities.find((c) => c.key === 'cmmcomposite')?.name, 'Cmmcomposite');
});

test('a fresher report leads a stale one, whatever it pays', () => {
  const rows: SystemCommodityRow[] = [
    r('steel', 'Old Site', 'SpaceConstructionDepot', 9000, '3', 100, '2026-06-01T00:00:00Z'),
    r('steel', 'New Site', 'SpaceConstructionDepot', 3000, '3', 900, '2026-08-28T00:00:00Z'),
  ];
  const roster = siteRoster(rows, { first: PREAE, nowMs: SWEPT });
  const match = holdAtSites(new Map([['steel', 700]]), roster)[0];
  // 9,000 cr/t is a better price and a three-month-old rumour. It does not lead.
  assert.deepEqual(
    match.sites.map((s) => s.station),
    ['New Site', 'Old Site'],
  );
});

// ------------------------------------------------- a price table is not a list

/**
 * Ardent never expires a row, so one station can arrive carrying two unrelated
 * readings at once. Captured from Pueloi VY-S d3-94 on 2026-08-29, where the
 * Galtean bridge was building: "Orbital Construction Site: Archades Hammer"
 * returned 371 commodities — 364 of them the entire game catalogue, dated
 * 2026-07-01, and seven dated 2026-08-25/26 that are the real outpost list.
 */
const HUB = 'Pueloi VY-S d3-94';
const HAMMER = 'Orbital Construction Site: Archades Hammer';
const READ = Date.parse('2026-08-29T12:00:00Z');

const hub = (
  commodity: string | null,
  station: string,
  price: number | null,
  updatedAt: string | null,
): SystemCommodityRow => ({
  commodity,
  station,
  system: HUB,
  stationType: 'SpaceConstructionDepot',
  price,
  pad: '2',
  distanceLs: 18840,
  updatedAt,
});

// The July dump, in miniature: real commodities beside things no station has
// ever asked a hauler for.
const JULY = [
  'advert1',
  'albinoquechuamammoth',
  'alieneggs',
  'alexandrite',
  'tritium',
  'steel',
  'gold',
  'imperialslaves',
  'wine',
  'painite',
  'bauxite',
  'coffee',
];

test('a stale price table is not mistaken for a requirement', () => {
  const rows: SystemCommodityRow[] = [
    // 364 rows in the wild; enough here to cross the threshold.
    ...Array.from({ length: 60 }, (_, i) =>
      hub(JULY[i % JULY.length] + (i < JULY.length ? '' : `filler${i}`), HAMMER, 39501, '2026-07-01T00:00:00Z'),
    ),
    // What the site actually asked for, read this week.
    ...['aluminium', 'insulatingmembrane', 'liquidoxygen', 'polymers', 'steel', 'titanium', 'water'].map(
      (c) => hub(c, HAMMER, 2985, '2026-08-26T09:00:00Z'),
    ),
  ];
  const [site] = siteRoster(rows, { first: HUB, nowMs: READ });
  assert.deepEqual(
    site.commodities.map((c) => c.key),
    ['aluminium', 'insulatingmembrane', 'liquidoxygen', 'polymers', 'steel', 'titanium', 'water'],
  );
  // The junk is gone, and with it the claim that this site takes tritium.
  const match = holdAtSites(new Map([['tritium', 300]]), [site])[0];
  assert.equal(match.sites.length, 0);
  assert.match(match.note ?? '', /no known site here accepts this/i);
  // And the site now reads as freshly reported rather than seven weeks old.
  assert.equal(site.ageDays, 3);
  assert.equal(site.stale, false);
});

test('a long requirement reported over weeks is left alone', () => {
  // Baily Landing's real shape: 27 commodities whose rows trickled in between
  // 2026-07-30 and 2026-08-23. Nothing here is implausible, so nothing is cut.
  const days = ['2026-07-30', '2026-08-01', '2026-08-14', '2026-08-22', '2026-08-23'];
  const rows = Array.from({ length: 27 }, (_, i) =>
    hub(`commodity${i}`, 'Orbital Construction Site: Baily Landing', 500 + i, `${days[i % days.length]}T00:00:00Z`),
  );
  const [site] = siteRoster(rows, { first: HUB, nowMs: READ });
  assert.equal(site.commodities.length, 27);
});

test('the newest reading of a board beats the first one in the array', () => {
  const rows: SystemCommodityRow[] = [
    hub('steel', HAMMER, 9999, '2026-07-01T00:00:00Z'),
    hub('steel', HAMMER, 2985, '2026-08-26T09:00:00Z'),
  ];
  const [site] = siteRoster(rows, { first: HUB, nowMs: READ });
  assert.equal(site.commodities.length, 1);
  assert.equal(site.commodities[0].payment, 2985);
  assert.equal(site.ageDays, 3);
});
