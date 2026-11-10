/**
 * Deep-space colonisation, wired — journal in, plan out.
 *
 * carrierhold/haul/buildtypes prove the modules. These prove the store FEEDS
 * them: that a CargoTransfer reaches the shopping list as tonnage the commander
 * already owns, that a contribution reaches the haul clock, that the depot's
 * total tonnage names the build, and that a route search from a construction
 * site no longer asks Spansh about a station it has never heard of.
 *
 * Same harness as manifestwiring.test.ts — the real AppCore against mocked
 * browser globals.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ArchitectView } from '../src/ui/store.ts';
import { MarketMemory, routeStartFrom } from '../src/engine/trade.ts';
import { architectFacts, describeDepot } from '../src/engine/architect.ts';

const bank = new Map<string, string>();
beforeEach(() => bank.clear());

before(() => {
  const g = globalThis as Record<string, unknown>;
  g.localStorage = {
    getItem: (k: string) => (bank.has(k) ? bank.get(k)! : null),
    setItem: (k: string, v: string) => void bank.set(k, String(v)),
    removeItem: (k: string) => void bank.delete(k),
  };
  g.window = { addEventListener() {}, removeEventListener() {} };
  g.document = { addEventListener() {}, removeEventListener() {} };
  g.speechSynthesis = { getVoices: () => [], cancel() {}, speak() {} };
  g.SpeechSynthesisUtterance = class {};
  g.Audio = class {
    play() {
      return Promise.resolve();
    }
  };
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
  }
});

const line = (ts: string, o: Record<string, unknown>) =>
  JSON.stringify({ timestamp: `2026-09-18T${ts}Z`, ...o });

const CARRIER = 3712889600;
const DEPOT_ID = 3928364800;
/** The commander's own site, spelled the way the game spells it. */
const SITE = '$EXT_PANEL_ColonisationShip; Byeong-cheon Reach';

const res = (name: string, localised: string, required: number, provided = 0) => ({
  Name: name,
  Name_Localised: localised,
  RequiredAmount: required,
  ProvidedAmount: provided,
  Payment: 5000,
});

/**
 * A primary Commercial Outpost: 21,835 t, which is 18,988 t plus the surcharge
 * the game puts on a system's first station. The split below is invented but
 * the TOTAL is not — it is the number on the commander's own panel.
 */
const REQUIREMENT = [
  res('$steel_name;', 'Steel', 10000),
  res('$titanium_name;', 'Titanium', 8000),
  res('$aluminium_name;', 'Aluminium', 3000),
  res('$water_name;', 'Water', 835),
];

const ARRIVAL = [
  line('18:00:00', { event: 'Location', StarSystem: 'HIP 71120', Docked: false }),
  line('18:01:00', {
    event: 'Docked',
    StarSystem: 'HIP 71120',
    StationName: SITE,
    StationType: 'SpaceConstructionDepot',
    MarketID: DEPOT_ID,
    StationServices: ['dock', 'commodities', 'colonisationcontribution'],
  }),
  line('18:01:30', {
    event: 'ColonisationConstructionDepot',
    MarketID: DEPOT_ID,
    ConstructionProgress: 0.063,
    ConstructionComplete: false,
    ConstructionFailed: false,
    ResourcesRequired: REQUIREMENT,
  }),
];

interface CoreInnards {
  bootstrapped: boolean;
  onLines(lines: string[], live: boolean): void;
  architectView(): ArchitectView | null;
  planTradeRoute?(): Promise<void>;
  snapshot(): { feed: Array<{ text: string }> };
}

async function bootedCore(history: string[]) {
  const { AppCore } = await import('../src/ui/store.ts');
  const core = new AppCore();
  const c = core as unknown as CoreInnards;
  c.onLines(history, false);
  c.bootstrapped = true;
  return c;
}

test('the depot reaches the panel, and its tonnage names what is being built', async () => {
  const c = await bootedCore(ARRIVAL);
  const v = c.architectView()!;
  assert.ok(v, 'a depot event must produce a panel');
  assert.equal(v.totalRequired, 21835);
  assert.equal(v.build!.primary, true);
  assert.ok(v.build!.types.some((t) => t.key === 'Commercial_Outpost'));
  assert.match(v.buildLine!, /first station/);
});

test('with no carrier the panel says so rather than showing an empty one', async () => {
  const c = await bootedCore(ARRIVAL);
  assert.equal(c.architectView()!.carrier, null);
});

test('a cargo transfer reaches the shopping list as tonnage already owned', async () => {
  const c = await bootedCore([
    line('17:00:00', { event: 'CarrierLocation', CarrierID: CARRIER, StarSystem: 'Tir' }),
    line('17:00:01', {
      event: 'CarrierStats',
      CarrierID: CARRIER,
      Callsign: 'V6W-TTJ',
      SpaceUsage: { TotalCapacity: 25000, Cargo: 8000, FreeSpace: 17000 },
    }),
    line('17:30:00', {
      event: 'CargoTransfer',
      Transfers: [{ Type: 'steel', Type_Localised: 'Steel', Count: 8000, Direction: 'tocarrier' }],
    }),
    ...ARRIVAL,
  ]);
  const v = c.architectView()!;
  assert.ok(v.carrier, 'owning a carrier must produce the warehouse block');
  assert.equal(v.carrier!.hold.callsign, 'V6W-TTJ');
  assert.equal(v.carrier!.coverage.tons, 8000);
  assert.equal(v.carrier!.coverage.lines, 1);
  // Parked in Tir, not at the build — that is a carrier jump, not a shuttle.
  assert.equal(v.carrier!.atBuild, false);
  // And the steel is off the buy list: 10,000 t wanted, 8,000 t already owned.
  const steel = v.groups.flatMap((g) => g.items).find((i) => i.key === 'steel')!;
  assert.equal(steel.onCarrier, 8000);
  assert.equal(steel.toBuy, 2000);
  assert.equal(steel.remaining, 10000);
});

test("the carrier's own board is read; another station's is not", async () => {
  const c = await bootedCore([
    line('17:00:00', { event: 'CarrierLocation', CarrierID: CARRIER, StarSystem: 'HIP 71120' }),
    line('17:00:01', { event: 'CarrierStats', CarrierID: CARRIER, Callsign: 'V6W-TTJ', SpaceUsage: { Cargo: 500 } }),
    ...ARRIVAL,
  ]);
  const core = c as unknown as { onSnapshotFile(name: string, text: string): void };
  const board = (marketId: number, stock: number) =>
    JSON.stringify({
      timestamp: '2026-09-18T18:05:00Z',
      event: 'Market',
      MarketID: marketId,
      StationName: 'V6W-TTJ',
      StarSystem: 'HIP 71120',
      Items: [{ Name: '$steel_name;', Name_Localised: 'Steel', BuyPrice: 0, SellPrice: 0, Stock: stock, Demand: 0 }],
    });
  core.onSnapshotFile('Market.json', board(CARRIER, 500));
  assert.equal(c.architectView()!.carrier!.coverage.tons, 500);
  // A bubble station's board must not be credited to the carrier's hold.
  core.onSnapshotFile('Market.json', board(128666762, 99999));
  assert.equal(c.architectView()!.carrier!.coverage.tons, 500);
});

test('a carrier parked at the build is a shuttle run, and leads the next load', async () => {
  const c = await bootedCore([
    line('17:00:00', { event: 'CarrierLocation', CarrierID: CARRIER, StarSystem: 'HIP 71120' }),
    line('17:00:01', { event: 'CarrierStats', CarrierID: CARRIER, Callsign: 'V6W-TTJ', SpaceUsage: { Cargo: 8000 } }),
    line('17:30:00', { event: 'CargoTransfer', Transfers: [{ Type: 'steel', Count: 8000, Direction: 'tocarrier' }] }),
    line('17:31:00', { event: 'Loadout', Ship: 'type9', CargoCapacity: 784 }),
    ...ARRIVAL,
  ]);
  const v = c.architectView()!;
  assert.equal(v.carrier!.atBuild, true);
  assert.equal(v.trip!.source, 'carrier');
  assert.equal(v.trip!.station, 'V6W-TTJ');
  assert.equal(v.trip!.cost, null);
});

test('contributions reach the haul clock, and the build gets a horizon', async () => {
  const runs = ['18:10:00', '18:30:00', '18:50:00', '19:10:00'].map((t) =>
    line(t, {
      event: 'ColonisationContribution',
      MarketID: DEPOT_ID,
      Contributions: [{ Name: '$steel_name;', Amount: 700 }],
    }),
  );
  const c = await bootedCore([...ARRIVAL, ...runs]);
  const v = c.architectView()!;
  assert.equal(v.clock.runs, 4);
  assert.equal(v.clock.tonsDelivered, 2800);
  assert.ok(v.clock.tonsPerHour! > 0);
  assert.match(v.clockLine!, /hours of hauling/);
  // And the requirement moved: 21,835 t less the 2,800 handed over.
  assert.equal(v.totalRemaining, 21835 - 2800);
});

test('the breakdown the commander read is filed under the build’s cost', async () => {
  const c = await bootedCore(ARRIVAL);
  const v = c.architectView()!;
  const learned = v.learned.find((l) => l.tons === 21835)!;
  assert.ok(learned, 'the requirement must be remembered against its cost');
  assert.equal(learned.lines.length, 4);
  assert.equal(learned.lines.find((l) => l.key === 'steel')!.required, 10000);
  assert.equal(learned.system, 'HIP 71120');
  // And it survives into storage, so the next build of this cost is predicted.
  assert.ok(bank.get('edmo.buildlib.v1')!.includes('21835'));
});

test('a route search refuses a construction site as its start', () => {
  // fetchRoute() itself needs the Tauri shell, so the decision it makes lives
  // in a pure function — this is that decision, against the real site name.
  const memory = new MarketMemory();
  const start = routeStartFrom({
    system: 'HIP 71120',
    station: SITE,
    atConstructionSite: true,
    memory,
  });
  assert.equal(start.ok, false);
  assert.equal(start.ok === false && start.reason, 'depot');
});

test('a station read in the same system is used as the start instead', () => {
  const memory = new MarketMemory();
  memory.record({
    marketId: 1,
    station: 'Corman Beacon',
    system: 'HIP 71120',
    at: '2026-09-18T17:00:00Z',
    items: [{ name: 'Steel', buy: 700, sell: 0, stock: 9000, demand: 0 }],
  });
  memory.record({
    marketId: 2,
    station: SITE,
    system: 'HIP 71120',
    at: '2026-09-18T18:02:00Z',
    items: [{ name: 'Steel', buy: 0, sell: 5000, stock: 0, demand: 9000 }],
  });
  const start = routeStartFrom({
    system: 'HIP 71120',
    station: SITE,
    atConstructionSite: true,
    knownSites: [SITE],
    memory,
  });
  // The site's own board is the NEWEST market read here, and it is still not
  // a usable start — the older real station is.
  assert.equal(start.ok, true);
  assert.equal(start.ok === true && start.station, 'Corman Beacon');
  assert.equal(start.ok === true && start.moved, true);
});

test('an ordinary station is left exactly where it is', () => {
  const start = routeStartFrom({
    system: 'HIP 71120',
    station: 'Corman Beacon',
    memory: new MarketMemory(),
  });
  assert.equal(start.ok === true && start.station, 'Corman Beacon');
  assert.equal(start.ok === true && start.moved, false);
});

test('a fleet carrier is still refused, and named as one', () => {
  const start = routeStartFrom({ system: 'Tir', station: 'V6W-TTJ', memory: new MarketMemory() });
  assert.equal(start.ok === false && start.reason, 'carrier');
});

// ------------------------------------------- how far, and how many jumps

/** The commander arriving at their build, with the coordinates the game gives. */
const DEEP_ARRIVAL = [
  line('17:50:00', {
    event: 'FSDJump',
    StarSystem: 'Floanth PW-G b16-3',
    StarPos: [4475.15625, -161.84375, 14649.125],
    JumpDist: 33.2,
  }),
];

/** A neighbouring system the commander has also flown to, with a market read. */
const NEIGHBOUR = line('17:40:00', {
  event: 'FSDJump',
  StarSystem: 'HIP 71120',
  StarPos: [4500.15625, -161.84375, 14649.125],
  JumpDist: 25,
});

test('a system the commander has flown to gets a distance the panel can use', async () => {
  const c = await bootedCore([NEIGHBOUR, ...DEEP_ARRIVAL, ...ARRIVAL]);
  const map = c as unknown as { starMap: { between(a: string, b: string): number | null } };
  // 25 ly apart on the x axis, straight off the two StarPos values.
  assert.equal(Math.round(map.starMap.between('Floanth PW-G b16-3', 'HIP 71120')!), 25);
  assert.equal(map.starMap.between('Floanth PW-G b16-3', 'Never Been Here'), null);
});

test('the laden range is measured, and jump counts come from it', async () => {
  const c = await bootedCore([
    line('17:30:00', { event: 'Loadout', Ship: 'type9', CargoCapacity: 784, MaxJumpRange: 52.6 }),
    line('17:31:00', { event: 'Cargo', Count: 784 }),
    // A loaded jump: this is the figure that should win over the rated 52.6.
    line('17:50:00', {
      event: 'FSDJump',
      StarSystem: 'Floanth PW-G b16-3',
      StarPos: [4475.15625, -161.84375, 14649.125],
      JumpDist: 33.2,
    }),
    ...ARRIVAL,
  ]);
  const v = c.architectView()!;
  assert.ok(v.reach, 'a jump with cargo aboard must produce a reach');
  assert.equal(v.reach!.basis, 'laden');
  assert.equal(v.reach!.rangeLy, 33.2);
  assert.match(v.reachLine!, /longest jump with a loaded hold/);
});

test('with no loaded jump the panel says the figure is the empty one', async () => {
  const c = await bootedCore([
    line('17:30:00', { event: 'Loadout', Ship: 'type9', CargoCapacity: 784, MaxJumpRange: 52.6 }),
    ...DEEP_ARRIVAL, // jumped with an empty hold
    ...ARRIVAL,
  ]);
  const v = c.architectView()!;
  assert.equal(v.reach!.basis, 'empty');
  assert.match(v.reachLine!, /a full hold will do worse/);
});

test('the colonisation ship reads as a place, not as a token', async () => {
  const c = await bootedCore(ARRIVAL);
  const v = c.architectView()!;
  // The raw name stays in the data — it is the game's identity for the site,
  // and market memory and the depot map are keyed on it.
  assert.equal(v.depot.station, SITE);
  // Everything a person reads or hears resolves it. describeDepot is what the
  // feed prints and what the voice says.
  const line = describeDepot(v.depot, v.groups)!;
  assert.doesNotMatch(line, /\$EXT_PANEL/);
  assert.match(line, /^Colonisation Ship: Byeong-cheon Reach:/);
  // And so does the block handed to the model.
  const facts = architectFacts(v.depot, v.groups)!;
  assert.doesNotMatch(facts, /\$EXT_PANEL/);
  assert.match(facts, /Colonisation Ship: Byeong-cheon Reach/);
});

// ------------------------------------------------- the basket at the pad

/** Cleaver City, where the commander actually shops. */
const SHOP = 3222064896;
const SHOP_ARRIVAL = [
  line('19:00:00', {
    event: 'FSDJump',
    StarSystem: 'Greae Hype TO-G c27-107',
    StarPos: [4000, -160, 14300],
    JumpDist: 40,
  }),
  line('19:01:00', {
    event: 'Docked',
    StarSystem: 'Greae Hype TO-G c27-107',
    StationName: 'Cleaver City',
    StationType: 'Orbis',
    MarketID: SHOP,
  }),
];

/** Cleaver City's board, as the only source the build has. */
const SHOP_MARKET = JSON.stringify({
  timestamp: '2026-09-18T19:01:30Z',
  event: 'Market',
  MarketID: SHOP,
  StationName: 'Cleaver City',
  StarSystem: 'Greae Hype TO-G c27-107',
  Items: [
    { Name: '$steel_name;', Name_Localised: 'Steel', BuyPrice: 4142, SellPrice: 0, Stock: 400000, Demand: 0 },
    { Name: '$water_name;', Name_Localised: 'Water', BuyPrice: 66, SellPrice: 0, Stock: 600000, Demand: 0 },
  ],
});

async function shopping(extra: string[] = []) {
  const c = await bootedCore([...ARRIVAL, ...SHOP_ARRIVAL, ...extra]);
  (c as unknown as { onSnapshotFile(n: string, t: string): void }).onSnapshotFile('Market.json', SHOP_MARKET);
  return c;
}

test('the pad under the ship gets a basket, priced off its own board', async () => {
  const c = await shopping();
  const b = c.architectView()!.basket!;
  assert.ok(b, 'docking at a stop on the run must produce a basket');
  assert.equal(b.station, 'Cleaver City');
  assert.equal(b.bought, 0);
  assert.equal(b.complete, false);
  assert.deepEqual(b.lines.map((l) => l.key).sort(), ['steel', 'water']);
});

test('buying ticks the line down, and bought plus left stays constant', async () => {
  const before = (await shopping()).architectView()!.basket!;
  const steelWanted = before.lines.find((l) => l.key === 'steel')!.left;
  const c = await shopping([
    line('19:05:00', { event: 'MarketBuy', MarketID: SHOP, Type: 'steel', Count: 800 }),
  ]);
  // The hold is what makes the requirement shrink, and the game states it in
  // Cargo.json beside the purchase — so the basket's two halves come from two
  // different files and must still add up.
  (c as unknown as { onSnapshotFile(n: string, t: string): void }).onSnapshotFile(
    'Cargo.json',
    JSON.stringify({ event: 'Cargo', Count: 800, Inventory: [{ Name: 'steel', Count: 800 }] }),
  );
  const steel = c.architectView()!.basket!.lines.find((l) => l.key === 'steel')!;
  assert.equal(steel.bought, 800);
  assert.equal(steel.left, steelWanted - 800);
  assert.equal(steel.wanted, steelWanted);
});

test('a purchase at another market is not this basket', async () => {
  const c = await shopping([
    line('19:05:00', { event: 'MarketBuy', MarketID: 999999, Type: 'steel', Count: 800 }),
  ]);
  assert.equal(c.architectView()!.basket!.bought, 0);
});

test('standing nowhere near the run is no basket at all', async () => {
  const c = await bootedCore(ARRIVAL);
  assert.equal(c.architectView()!.basket, null);
});

test('a station nowhere near the run still gets a basket from its own board', async () => {
  // A backwater the market sweep has never ranked: no distance, no stop entry,
  // nothing but a board and a build that wants what is on it.
  const c = await bootedCore([
    ...ARRIVAL,
    line('19:20:00', {
      event: 'Docked',
      StarSystem: 'Some Other Place',
      StationName: 'Backwater Dock',
      StationType: 'Outpost',
      MarketID: 424242,
    }),
  ]);
  (c as unknown as { onSnapshotFile(n: string, t: string): void }).onSnapshotFile(
    'Market.json',
    JSON.stringify({
      timestamp: '2026-09-18T19:20:30Z',
      event: 'Market',
      MarketID: 424242,
      StationName: 'Backwater Dock',
      StarSystem: 'Some Other Place',
      Items: [
        { Name: '$steel_name;', Name_Localised: 'Steel', BuyPrice: 5000, SellPrice: 0, Stock: 900, Demand: 0 },
        { Name: '$gold_name;', Name_Localised: 'Gold', BuyPrice: 40000, SellPrice: 0, Stock: 900, Demand: 0 },
      ],
    }),
  );
  const v = c.architectView()!;
  const b = v.basket!;
  assert.ok(b, 'any station whose board has been read must produce a basket');
  assert.equal(b.station, 'Backwater Dock');
  // Only what the build actually wants, capped at what the board holds.
  assert.deepEqual(b.lines.map((l) => l.key), ['steel']);
  assert.equal(b.lines[0].left, 900);
  // The basket is built from the BOARD, not from the run, so it does not
  // matter where — or whether — this station places among the best stops.
  // `stopHere` is unit-tested against that directly; here it is enough that a
  // station the sweep has never ranked answers at all.
  assert.equal(b.lines[0].name, 'Steel');
  assert.equal(v.basket!.complete, false);
});
