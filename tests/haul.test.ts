/** The next load, and how long the build has left. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShoppingList, type DepotState } from '../src/engine/architect.ts';
import { describeHaulClock, describeTrip, haulClock, HaulLog, planTrip, stopPlans, stopHere, PurchaseLog, basketAt, describeBasketLine, cartStatus, describeCart, describeCartFilled } from '../src/engine/haul.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent =>
  ({ timestamp: '2026-09-18T20:11:50Z', ...o }) as unknown as JournalEvent;

/** A stripped-down version of the commander's real HIP 71120 requirement. */
const depot = (over: Partial<DepotState> = {}): DepotState => ({
  marketId: 3928364800,
  station: '$EXT_PANEL_ColonisationShip',
  system: 'HIP 71120',
  progress: 0.063,
  complete: false,
  failed: false,
  at: '2026-09-18T18:00:00Z',
  resources: [
    { key: 'titanium', name: 'Titanium', required: 5534, provided: 0, remaining: 5534, payment: 0 },
    { key: 'steel', name: 'Steel', required: 5358, provided: 0, remaining: 5358, payment: 0 },
    { key: 'water', name: 'Water', required: 741, provided: 0, remaining: 741, payment: 0 },
    { key: 'polymers', name: 'Polymers', required: 521, provided: 0, remaining: 521, payment: 0 },
  ],
  ...over,
});

/** Two sellers: one that stocks the two big lines, one that stocks the rest. */
const sources = new Map<string, Array<Record<string, unknown>>>([
  ['titanium', [{ station: 'Crippen Reach', system: 'Trianguli Sector', distanceLy: 14, price: 900, stock: 9000, pad: '3', carrier: false, updatedAt: '2026-09-18T12:00:00Z' }]],
  ['steel', [{ station: 'Crippen Reach', system: 'Trianguli Sector', distanceLy: 14, price: 700, stock: 9000, pad: '3', carrier: false, updatedAt: '2026-09-18T12:00:00Z' }]],
  ['water', [{ station: 'Hayashi Forge', system: 'Bhritzameno', distanceLy: 40, price: 120, stock: 4000, pad: '3', carrier: false, updatedAt: '2026-09-18T12:00:00Z' }]],
  ['polymers', [{ station: 'Hayashi Forge', system: 'Bhritzameno', distanceLy: 40, price: 400, stock: 4000, pad: '3', carrier: false, updatedAt: '2026-09-18T12:00:00Z' }]],
]) as never;

const list = (extra: Record<string, unknown> = {}) =>
  buildShoppingList(depot(), { sources, cargoCapacity: 784, nowMs: Date.parse('2026-09-18T20:00:00Z'), ...extra });

test('no hold size means no trip to plan', () => {
  assert.equal(planTrip(list(), { capacity: null }), null);
  assert.equal(planTrip(list(), { capacity: 0 }), null);
});

test('the manifest fills the hold from one stop, biggest line first', () => {
  const plan = planTrip(list(), { capacity: 784, depotSystem: 'HIP 71120' })!;
  assert.equal(plan.source, 'market');
  assert.equal(plan.station, 'Crippen Reach');
  assert.equal(plan.tons, 784);
  // One line covers the whole hold here — titanium is 5,534 t outstanding.
  assert.equal(plan.lines[0].name, 'Titanium');
  assert.equal(plan.lines[0].tons, 784);
  assert.equal(plan.lines[0].closes, false);
  assert.equal(plan.cost, 784 * 900);
  assert.equal(plan.loadsHere, Math.ceil((5534 + 5358) / 784));
});

test('a part-full hold is topped up, not re-planned from empty', () => {
  const plan = planTrip(list(), { capacity: 784, holdUsed: 300 })!;
  assert.equal(plan.tons, 484);
  assert.equal(plan.capacity, 784);
  // A full hold has nothing to add.
  assert.equal(planTrip(list(), { capacity: 784, holdUsed: 784 }), null);
});

test('small lines are closed out when the hold has room left', () => {
  const small = depot({
    resources: [
      { key: 'water', name: 'Water', required: 500, provided: 0, remaining: 500, payment: 0 },
      { key: 'polymers', name: 'Polymers', required: 120, provided: 0, remaining: 120, payment: 0 },
    ],
  });
  const groups = buildShoppingList(small, { sources, cargoCapacity: 784, nowMs: Date.parse('2026-09-18T20:00:00Z') });
  const plan = planTrip(groups, { capacity: 784 })!;
  assert.equal(plan.tons, 620);
  assert.deepEqual(plan.lines.map((l) => [l.name, l.tons, l.closes]), [
    ['Water', 500, true],
    ['Polymers', 120, true],
  ]);
  assert.equal(plan.moreHere, 0);
  assert.equal(plan.loadsHere, 1);
});

test('a stop is never asked for more than it stocks', () => {
  const thin = new Map([
    ['titanium', [{ station: 'Crippen Reach', system: 'Trianguli Sector', distanceLy: 14, price: 900, stock: 300, pad: '3', carrier: false, updatedAt: '2026-09-18T12:00:00Z' }]],
  ]) as never;
  const groups = buildShoppingList(depot(), { sources: thin, cargoCapacity: 784, nowMs: Date.parse('2026-09-18T20:00:00Z') });
  const plan = planTrip(groups, { capacity: 784 })!;
  assert.equal(plan.tons, 300);
  assert.equal(plan.lines[0].tons, 300);
});

test('the carrier beats every market when it is parked at the build', () => {
  const carrier = { tons: new Map([['steel', 4000]]), system: 'HIP 71120', callsign: 'V6W-TTJ' };
  const groups = list({ carrier });
  const plan = planTrip(groups, {
    capacity: 784,
    depotSystem: 'HIP 71120',
    carrierSystem: 'HIP 71120',
    carrierName: 'V6W-TTJ',
  })!;
  assert.equal(plan.source, 'carrier');
  assert.equal(plan.station, 'V6W-TTJ');
  assert.equal(plan.tons, 784);
  assert.equal(plan.cost, null);
  assert.match(describeTrip(plan)!, /already paid for/);
});

test('a carrier parked elsewhere is not a load-out — it is a carrier jump', () => {
  const carrier = { tons: new Map([['steel', 4000]]), system: 'Tir', callsign: 'V6W-TTJ' };
  const groups = list({ carrier });
  const plan = planTrip(groups, {
    capacity: 784,
    depotSystem: 'HIP 71120',
    carrierSystem: 'Tir',
    carrierName: 'V6W-TTJ',
  })!;
  assert.equal(plan.source, 'market');
  // And the steel it holds is not on the buy list any more either.
  assert.equal(plan.lines.some((l) => l.key === 'steel'), false);
});

test('nothing to fetch returns null rather than an empty manifest', () => {
  const done = depot({
    resources: [{ key: 'steel', name: 'Steel', required: 100, provided: 100, remaining: 0, payment: 0 }],
  });
  assert.equal(planTrip(buildShoppingList(done, { cargoCapacity: 784 }), { capacity: 784 }), null);
});

// ------------------------------------------------------------------ the clock

const hours = (n: number): number => Date.parse('2026-09-18T12:00:00Z') + n * 3_600_000;

test('no history is no rate, and no ETA invented from one', () => {
  const c = haulClock([], 20464);
  assert.equal(c.runs, 0);
  assert.equal(c.tonsPerHour, null);
  assert.equal(describeHaulClock(c, 20464), null);
});

test('the rate comes from gaps between deliveries, not the calendar', () => {
  // Four runs in one evening, 784 t each, twenty minutes apart.
  const runs = [0, 1 / 3, 2 / 3, 1].map((h) => ({ at: hours(h), marketId: 1, tons: 784 }));
  const c = haulClock(runs, 5000, 1);
  assert.equal(c.runs, 4);
  assert.equal(c.tonsDelivered, 3136);
  assert.equal(c.tonsPerRun, 784);
  // Three 20-minute gaps plus a nominal 20 for the first run = 80 minutes.
  assert.equal(Math.round(c.tonsPerHour!), 2352);
  assert.equal(Math.round(c.hoursLeft! * 10) / 10, 2.1);
});

test('an overnight gap is sleep, and is not counted as hauling', () => {
  const evening = [0, 1 / 3, 2 / 3].map((h) => ({ at: hours(h), marketId: 1, tons: 784 }));
  const nextDay = [24, 24.33, 24.67].map((h) => ({ at: hours(h), marketId: 1, tons: 784 }));
  const straight = haulClock(evening, 5000, 1).tonsPerHour!;
  const across = haulClock([...evening, ...nextDay], 5000, 1).tonsPerHour!;
  // Two evenings of identical work must read as the same rate, not half of it.
  assert.ok(Math.abs(straight - across) / straight < 0.15, `${straight} vs ${across}`);
});

test('deliveries at another site do not count towards this one', () => {
  const mixed = [
    { at: hours(0), marketId: 1, tons: 784 },
    { at: hours(0.5), marketId: 2, tons: 700 },
    { at: hours(1), marketId: 1, tons: 784 },
  ];
  assert.equal(haulClock(mixed, 5000, 1).tonsDelivered, 1568);
  assert.equal(haulClock(mixed, 5000, 2).runs, 1);
  assert.equal(haulClock(mixed, 5000).tonsDelivered, 2268);
});

test('two deliveries is an anecdote, not a rate', () => {
  const two = [0, 0.5].map((h) => ({ at: hours(h), marketId: 1, tons: 784 }));
  assert.equal(describeHaulClock(haulClock(two, 5000, 1), 5000), null);
  const four = [0, 0.33, 0.66, 1].map((h) => ({ at: hours(h), marketId: 1, tons: 784 }));
  const line = describeHaulClock(haulClock(four, 5000, 1), 5000)!;
  assert.match(line, /5,000 t left/);
  assert.match(line, /hours of hauling/);
  assert.match(line, /t\/hr/);
});

test('the log folds contributions and ignores a replay of the same one', () => {
  const log = new HaulLog();
  const contribution = ev({
    event: 'ColonisationContribution',
    MarketID: 3928364800,
    Contributions: [
      { Name: '$LiquidOxygen_name;', Amount: 2 },
      { Name: '$Water_name;', Amount: 16 },
    ],
  });
  assert.equal(log.apply(contribution), true);
  assert.equal(log.all[0].tons, 18);
  // Bootstrap re-reads the journal; the same delivery must not double.
  assert.equal(log.apply(contribution), false);
  assert.equal(log.all.length, 1);
  // Anything that is not a contribution is not a delivery.
  assert.equal(log.apply(ev({ event: 'Docked', MarketID: 3928364800 })), false);
});

test('the log survives storage', () => {
  const log = new HaulLog();
  log.apply(ev({ event: 'ColonisationContribution', MarketID: 7, Contributions: [{ Name: 'steel', Amount: 500 }] }));
  const back = new HaulLog();
  back.load(JSON.parse(JSON.stringify(log.toJSON())));
  assert.equal(back.all.length, 1);
  assert.equal(back.all[0].tons, 500);
  back.load(null);
  assert.equal(back.all.length, 1);
});

test('one hour is an hour, not "1 hours"', () => {
  // 3,814 t at 3,673 t/hr is 1.038 hours, which rounded to "about 1 hours of
  // hauling" on the one line of the panel read on every single run.
  const reading = (hoursLeft: number) => ({
    runs: 4,
    tonsDelivered: 4000,
    tonsPerHour: 1000,
    hoursLeft,
    tonsPerRun: 1000,
    lastAt: 0,
  });
  assert.match(describeHaulClock(reading(1), 1000)!, /about 1 hour of hauling/);
  assert.match(describeHaulClock(reading(2), 2000)!, /about 2 hours of hauling/);
  assert.match(describeHaulClock(reading(1.04), 1040)!, /about 1 hour of hauling/);
  assert.match(describeHaulClock(reading(1.1), 1100)!, /about 1.1 hours of hauling/);
  // Under an hour still reads in minutes.
  assert.match(describeHaulClock(reading(0.5), 500)!, /about 30 minutes/);
});

// ------------------------------------------------------------- the whole run

/** Two stations and a carrier, as the commander's real steel row looks. */
const RUN_SOURCES = new Map<string, Array<Record<string, unknown>>>([
  ['titanium', [
    { station: 'Gustard Watch', system: 'Greae Hype TO-G c27-107', distanceLy: 464, price: 3746, stock: 900000, pad: '3', carrier: false, updatedAt: '2026-09-19T00:00:00Z' },
    { station: 'FLK-B2Z', system: 'Floanth FY-L c10-107', distanceLy: 107, price: 4179, stock: 6660, pad: '3', carrier: true, updatedAt: '2026-09-20T00:00:00Z' },
  ]],
  ['steel', [
    { station: 'Gustard Watch', system: 'Greae Hype TO-G c27-107', distanceLy: 464, price: 3746, stock: 900000, pad: '3', carrier: false, updatedAt: '2026-09-19T00:00:00Z' },
  ]],
  ['water', [
    { station: 'Cleaver City', system: 'Greae Hype TO-G c27-107', distanceLy: 464, price: 120, stock: 600000, pad: '3', carrier: false, updatedAt: '2026-09-20T00:00:00Z' },
  ]],
  ['polymers', [
    { station: 'Gustard Watch', system: 'Greae Hype TO-G c27-107', distanceLy: 464, price: 400, stock: 900000, pad: '3', carrier: false, updatedAt: '2026-09-19T00:00:00Z' },
  ]],
]) as never;

const run = () =>
  stopPlans(
    buildShoppingList(depot(), { sources: RUN_SOURCES, cargoCapacity: 784, nowMs: Date.parse('2026-09-18T20:00:00Z') }),
    { capacity: 784 },
  );

test('the run answers by STOP, and names everything one visit clears', () => {
  const plans = run();
  const best = plans[0];
  assert.equal(best.station, 'Gustard Watch');
  // Titanium, steel and polymers — three of the four lines, from one pad.
  assert.deepEqual(best.lines.map((l) => l.key), ['titanium', 'steel', 'polymers']);
  assert.equal(best.tons, 5534 + 5358 + 521);
  assert.equal(best.loads, Math.ceil((5534 + 5358 + 521) / 784));
  assert.equal(best.cost, (5534 + 5358) * 3746 + 521 * 400);
  assert.equal(Math.round(best.share * 100), 94);
  assert.equal(best.distanceLy, 464);
});

test('a stop is credited for lines it is only the SECOND best source of', () => {
  // FLK-B2Z is nearer and dearer, so it never wins the titanium row outright —
  // but it can still sell 6,660 t of it, and a run view that only counted
  // winners would show this stop as having nothing at all.
  const flk = run().find((p) => p.station === 'FLK-B2Z')!;
  assert.ok(flk, 'a second-choice stop must still appear');
  assert.deepEqual(flk.lines.map((l) => l.key), ['titanium']);
  assert.equal(flk.tons, 5534);
  assert.equal(flk.carrier, true);
});

test('a stop that cannot cover a line says so on that line', () => {
  const thin = new Map([
    ['titanium', [{ station: 'Tiny', system: 'Nearby', distanceLy: 5, price: 900, stock: 300, pad: '3', carrier: false, updatedAt: '2026-09-20T00:00:00Z' }]],
  ]) as never;
  const plans = stopPlans(
    buildShoppingList(depot(), { sources: thin, cargoCapacity: 784, nowMs: Date.parse('2026-09-18T20:00:00Z') }),
    { capacity: 784 },
  );
  assert.equal(plans[0].lines[0].tons, 300);
  assert.equal(plans[0].lines[0].short, true);
});

test('nothing left to buy is an empty run, not a stop with no lines', () => {
  const done = depot({
    resources: [{ key: 'steel', name: 'Steel', required: 100, provided: 100, remaining: 0, payment: 0 }],
  });
  assert.deepEqual(stopPlans(buildShoppingList(done, {}), {}), []);
  assert.deepEqual(stopPlans([], {}), []);
});

test('the run is capped, so it stays a plan rather than a directory', () => {
  const many = new Map([
    ['titanium', Array.from({ length: 20 }, (_, i) => ({
      station: `S${i}`, system: `Sys${i}`, distanceLy: i + 1, price: 900 + i,
      stock: 9000, pad: '3', carrier: false, updatedAt: '2026-09-20T00:00:00Z',
    }))],
  ]) as never;
  const groups = buildShoppingList(depot(), { sources: many, cargoCapacity: 784, nowMs: Date.parse('2026-09-18T20:00:00Z') });
  // Twenty sellers go in and five come out: a shopping line carries its best
  // source plus four alternatives, so one commodity can never name more than
  // five stops however many stations stock it. On a real seventeen-commodity
  // build the union across lines is far wider, which is why the cap matters.
  assert.equal(stopPlans(groups, { capacity: 784 }).length, 5);
  assert.equal(stopPlans(groups, { capacity: 784, limit: 3 }).length, 3);
  // And they come back nearest-of-the-equals first, since every stop here
  // supplies the same tonnage.
  assert.deepEqual(stopPlans(groups, { capacity: 784, limit: 2 }).map((p) => p.distanceLy), [1, 2]);
});

// --------------------------------------------------------- the basket at the pad

const CLEAVER = 3222064896;

test('the basket resets on arriving somewhere new, and survives a re-dock', () => {
  const log = new PurchaseLog();
  assert.equal(log.apply(ev({ event: 'Docked', MarketID: CLEAVER })), true);
  log.apply(ev({ event: 'MarketBuy', MarketID: CLEAVER, Type: 'steel', Count: 800 }));
  assert.equal(log.tons.get('steel'), 800);
  // Undocking to shuffle cargo and coming straight back is the same visit.
  log.apply(ev({ event: 'Undocked' }));
  assert.equal(log.apply(ev({ event: 'Docked', MarketID: CLEAVER })), false);
  assert.equal(log.tons.get('steel'), 800);
  // A different pad is a different basket.
  log.apply(ev({ event: 'Docked', MarketID: 999 }));
  assert.equal(log.tons.size, 0);
});

test('only purchases at THIS pad count, and selling back corrects them', () => {
  const log = new PurchaseLog();
  log.apply(ev({ event: 'Docked', MarketID: CLEAVER }));
  log.apply(ev({ event: 'MarketBuy', MarketID: CLEAVER, Type: 'steel', Count: 800 }));
  // Another station's market, seen in the same journal, is not this basket.
  log.apply(ev({ event: 'MarketBuy', MarketID: 12345, Type: 'steel', Count: 500 }));
  assert.equal(log.tons.get('steel'), 800);
  log.apply(ev({ event: 'MarketSell', MarketID: CLEAVER, Type: 'steel', Count: 300 }));
  assert.equal(log.tons.get('steel'), 500);
  // It never goes negative, however much is sold back.
  log.apply(ev({ event: 'MarketSell', MarketID: CLEAVER, Type: 'steel', Count: 9000 }));
  assert.equal(log.tons.get('steel'), 0);
});

/** Cleaver City's real four lines, as the commander's run shows them. */
const CLEAVER_STOP = {
  station: 'Cleaver City',
  system: 'Greae Hype TO-G c27-107',
  inSystem: true,
  distanceLy: 0,
  jumps: 0,
  pad: '3',
  carrier: false,
  tons: 2462,
  cost: 8669063,
  loads: 2,
  share: 0.98,
  lines: [
    { key: 'steel', name: 'Steel', tons: 2070, price: 4142, short: false },
    { key: 'water', name: 'Water', tons: 371, price: 66, short: false },
    { key: 'medicaldiagnosticequipment', name: 'Medical Diagnostic Equipment', tons: 13, price: 2729, short: false },
    { key: 'titanium', name: 'Titanium', tons: 8, price: 4395, short: false },
  ],
};

test('the basket shows what is in and what is still to buy, and they add up', () => {
  // 800 t of steel and all the water are aboard, so the live requirement has
  // already shrunk by exactly that much.
  const stop = {
    ...CLEAVER_STOP,
    lines: [
      { ...CLEAVER_STOP.lines[0], tons: 1270 },
      { ...CLEAVER_STOP.lines[1], tons: 0 },
      CLEAVER_STOP.lines[2],
      CLEAVER_STOP.lines[3],
    ],
  };
  const b = basketAt(stop, new Map([['steel', 800], ['water', 371]]))!;
  const steel = b.lines.find((l) => l.key === 'steel')!;
  assert.equal(steel.bought, 800);
  assert.equal(steel.left, 1270);
  assert.equal(steel.wanted, 2070); // neither half double-counts the other
  const water = b.lines.find((l) => l.key === 'water')!;
  assert.equal(water.done, true);
  assert.equal(water.wanted, 371);
  // Finished lines sink to the bottom; the work to do leads.
  assert.equal(b.lines[b.lines.length - 1].key, 'water');
  assert.equal(b.left, 1270 + 13 + 8);
  assert.equal(b.complete, false);
});

test('a stop with nothing left reads as complete', () => {
  const stop = { ...CLEAVER_STOP, lines: CLEAVER_STOP.lines.map((l) => ({ ...l, tons: 0 })) };
  const b = basketAt(stop, new Map([['steel', 2070], ['water', 371]]))!;
  assert.equal(b.complete, true);
  assert.equal(b.left, 0);
  assert.equal(b.bought, 2441);
});

test('no stop under the ship is no basket at all', () => {
  assert.equal(basketAt(null, new Map()), null);
  assert.equal(basketAt(undefined, new Map([['steel', 5]])), null);
  // A pad where nothing was bought and nothing is wanted is not a list.
  assert.equal(basketAt({ ...CLEAVER_STOP, lines: [] }, new Map()), null);
});

test('finishing a line is called out once, with what is still here', () => {
  const before = basketAt(CLEAVER_STOP, new Map())!;
  const stop = {
    ...CLEAVER_STOP,
    lines: [CLEAVER_STOP.lines[0], { ...CLEAVER_STOP.lines[1], tons: 0 }, CLEAVER_STOP.lines[2], CLEAVER_STOP.lines[3]],
  };
  const after = basketAt(stop, new Map([['water', 371]]))!;
  const line = describeBasketLine(before, after)!;
  assert.match(line, /Water done at Cleaver City/);
  assert.match(line, /Still here: 2,070 t of Steel and 2 more/);
  // Said once: the same pair of baskets does not announce it twice.
  assert.equal(describeBasketLine(after, after), null);
});

test('clearing the last line says the stop is finished', () => {
  const before = basketAt({ ...CLEAVER_STOP, lines: [CLEAVER_STOP.lines[0]] }, new Map())!;
  const after = basketAt(
    { ...CLEAVER_STOP, lines: [{ ...CLEAVER_STOP.lines[0], tons: 0 }] },
    new Map([['steel', 2070]]),
  )!;
  assert.match(describeBasketLine(before, after)!, /everything this stop can give you/);
});

test('a basket is built from the pad’s own board, at ANY station', () => {
  // Nothing about the run: a board, and what the build still wants.
  const groups = buildShoppingList(depot(), { sources, cargoCapacity: 784, nowMs: Date.parse('2026-09-18T20:00:00Z') });
  const board = new Map([['steel', 400000], ['water', 300], ['gold', 9000]]);
  const stop = stopHere('Some Backwater Dock', 'Nowhere Special', board, groups)!;
  assert.equal(stop.station, 'Some Backwater Dock');
  // Gold is on the board and not on the build, so it is not a line.
  assert.deepEqual(stop.lines.map((l) => l.key), ['steel', 'water']);
  // Never more than the board holds: water wants 741 t and it has 300.
  assert.equal(stop.lines.find((l) => l.key === 'water')!.tons, 300);
  assert.equal(stop.lines.find((l) => l.key === 'steel')!.tons, 5358);
});

test('a station selling nothing this build wants gets no basket', () => {
  const groups = buildShoppingList(depot(), { sources, cargoCapacity: 784, nowMs: Date.parse('2026-09-18T20:00:00Z') });
  assert.equal(stopHere('Dock', 'Sys', new Map([['gold', 9000]]), groups), null);
  assert.equal(stopHere('Dock', 'Sys', new Map(), groups), null);
  assert.equal(stopHere('', 'Sys', new Map([['steel', 9000]]), groups), null);
});

// ------------------------------------------------------------------- the cart

const cartOf = (carrier: Record<string, number>, cargo: Record<string, number> = {}) =>
  cartStatus(
    buildShoppingList(depot(), {
      sources,
      cargoCapacity: 784,
      nowMs: Date.parse('2026-09-18T20:00:00Z'),
      cargo: new Map(Object.entries(cargo)),
      carrier: { tons: new Map(Object.entries(carrier)), system: 'HIP 71120', callsign: 'V6W-TTJ' },
    }),
  );

test('the cart counts what is gathered and what is still missing, without overlap', () => {
  const cart = cartOf({ steel: 5358, water: 400 }, { titanium: 784 });
  const steel = cart.lines.find((l) => l.key === 'steel')!;
  assert.equal(steel.onCarrier, 5358);
  assert.equal(steel.missing, 0);
  assert.equal(steel.done, true);
  const water = cart.lines.find((l) => l.key === 'water')!;
  assert.equal(water.needed, 741);
  assert.equal(water.onCarrier, 400);
  assert.equal(water.missing, 341);
  // Titanium is in the ship, not the cart — counted, and not as carrier stock.
  const titanium = cart.lines.find((l) => l.key === 'titanium')!;
  assert.equal(titanium.inHold, 784);
  assert.equal(titanium.onCarrier, 0);
  assert.equal(titanium.missing, 5534 - 784);
  // The three columns never double-count: needed = carrier + hold + missing.
  for (const l of cart.lines) assert.equal(l.onCarrier + l.inHold + l.missing, l.needed);
  assert.equal(cart.complete, false);
  assert.equal(cart.linesDone, 1);
  assert.equal(cart.ofLines, 4);
});

test('unfinished lines lead, biggest gap first', () => {
  const cart = cartOf({ steel: 5358 });
  assert.equal(cart.lines[0].key, 'titanium'); // 5,534 t missing, the largest
  assert.equal(cart.lines[cart.lines.length - 1].key, 'steel'); // gathered, so last
});

test('a full cart says so, and says where to take it', () => {
  const cart = cartOf({ titanium: 5534, steel: 5358, water: 741, polymers: 521 });
  assert.equal(cart.complete, true);
  assert.equal(cart.missing, 0);
  const line = describeCart(cart, 'V6W-TTJ', 'Floanth PW-G b16-3')!;
  assert.match(line, /V6W-TTJ has the whole of what this build still wants/);
  assert.match(line, /12,154 t across 4 commodities/);
  assert.match(line, /Jump it to Floanth PW-G b16-3/);
});

test('a part-full cart reports the gap, not the total', () => {
  const line = describeCart(cartOf({ steel: 5358 }), 'V6W-TTJ', 'Floanth PW-G b16-3')!;
  assert.match(line, /1 of 4 lines gathered/);
  assert.match(line, /Still to buy: 5,534 t of Titanium/);
  assert.doesNotMatch(line, /Jump it/);
});

test('the cart being filled is announced exactly once', () => {
  const part = cartOf({ steel: 5358 });
  const full = cartOf({ titanium: 5534, steel: 5358, water: 741, polymers: 521 });
  assert.match(describeCartFilled(part, full, 'V6W-TTJ', 'Home')!, /whole of what this build/);
  // Already full before and after: nothing new to say.
  assert.equal(describeCartFilled(full, full, 'V6W-TTJ', 'Home'), null);
  // Still not full: not the moment.
  assert.equal(describeCartFilled(null, part, 'V6W-TTJ', 'Home'), null);
});

test('a build with nothing outstanding is not a cart', () => {
  const done = depot({
    resources: [{ key: 'steel', name: 'Steel', required: 100, provided: 100, remaining: 0, payment: 0 }],
  });
  const cart = cartStatus(buildShoppingList(done, {}));
  assert.equal(cart.ofLines, 0);
  assert.equal(cart.complete, false);
  assert.equal(describeCart(cart, 'V6W-TTJ', 'Home'), null);
});
