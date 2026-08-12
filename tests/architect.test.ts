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
  isConstructionDepot,
  tonsRemaining,
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
