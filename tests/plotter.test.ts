/** Route plotter — Spansh neutron + fleet-carrier replies, and the tritium bill. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtLy,
  nextWaypoint,
  parseCarrierPlot,
  parseShipPlot,
  plotContextLine,
  plotProgress,
  plotSummary,
  remaining,
} from '../src/engine/plotter.ts';

const NOW = Date.parse('2026-08-07T21:00:00Z');

// Trimmed from a real reply: POST /api/route from=Sol to=Colonia range=50
// efficiency=60. The full route is 131 waypoints; the shape is identical.
const SHIP_JSON = JSON.stringify({
  result: {
    destination_system: 'Colonia',
    distance: 22000.4740453411,
    efficiency: 60,
    range: 50,
    source_system: 'Sol',
    total_jumps: 63,
    system_jumps: [
      { system: 'Sol', distance_jumped: 0, distance_left: 22000.4740453411, jumps: 0, neutron_star: false },
      {
        system: 'PSR J1752-2806',
        distance_jumped: 407.486400990496,
        distance_left: 21629.3877108911,
        jumps: 10,
        neutron_star: true,
      },
      {
        system: 'Nova Aquila No 3',
        distance_jumped: 379.383912838054,
        distance_left: 21349.9114306519,
        jumps: 6,
        neutron_star: true,
      },
    ],
  },
});

// Trimmed from a real reply: POST /api/fleetcarrier/route source=Sol
// destinations=Colonia capacity_used=5000 current_fuel=1000
// calculate_starting_fuel=1. 46 rows in full; four here, one of them a restock.
const CARRIER_JSON = JSON.stringify({
  result: {
    source: 'Sol',
    destinations: ['Colonia'],
    capacity: 25000,
    capacity_used: 5000,
    mass: 30000,
    jumps: [
      {
        name: 'Sol',
        distance: 0,
        distance_to_destination: 22000.47,
        fuel_used: 0,
        fuel_in_tank: 1000,
        restock_amount: 267,
        must_restock: 1,
        has_icy_ring: false,
        is_system_pristine: false,
      },
      {
        name: 'Col 359 Sector MB-A b16-7',
        distance: 499.1,
        distance_to_destination: 21501.37,
        fuel_used: 89,
        fuel_in_tank: 1000,
        restock_amount: 0,
        must_restock: 0,
        has_icy_ring: false,
        is_system_pristine: false,
      },
      {
        name: 'IC 1287 Sector DB-X c1-18',
        distance: 498.4,
        distance_to_destination: 21002.97,
        fuel_used: 89,
        fuel_in_tank: 1000,
        restock_amount: 140,
        must_restock: 1,
        has_icy_ring: true,
        is_system_pristine: true,
      },
      {
        name: 'Colonia',
        distance: 497.0,
        distance_to_destination: 0,
        fuel_used: 89,
        fuel_in_tank: 1000,
        restock_amount: 0,
        must_restock: 0,
        has_icy_ring: true,
        is_system_pristine: false,
      },
    ],
  },
});

// ------------------------------------------------------------------ ship side

test('the neutron plotter parses into waypoints with their jump counts', () => {
  const r = parseShipPlot(SHIP_JSON, NOW)!;
  assert.equal(r.kind, 'ship');
  assert.equal(r.source, 'Sol');
  assert.equal(r.destination, 'Colonia');
  assert.equal(r.totalJumps, 63);
  assert.equal(r.waypoints.length, 3);
  // The intermediate jumps are a COUNT, not rows — 10 ordinary jumps to reach
  // the first supercharge. Rendering them as stops would be a 63-row list of
  // systems the commander never has to type.
  assert.equal(r.waypoints[1].jumps, 10);
  assert.equal(r.waypoints[1].neutron, true);
  assert.equal(r.waypoints[0].neutron, false);
  assert.equal(r.waypoints[1].legLy, 407.5);
  assert.equal(r.tritium, null);
});

test('a reply with no route, or unusable rows, is null rather than an empty card', () => {
  assert.equal(parseShipPlot('not json'), null);
  assert.equal(parseShipPlot('{"error":"Unable to find route","status":"failed"}'), null);
  assert.equal(parseShipPlot('{"result":{"system_jumps":[]}}'), null);
  // A row with no system name would render a copy button that copies "".
  assert.equal(parseShipPlot('{"result":{"system_jumps":[{"distance_jumped":1}]}}'), null);
});

// --------------------------------------------------------------- carrier side

test('the carrier plotter parses jumps, rings and the restock stops', () => {
  const r = parseCarrierPlot(CARRIER_JSON, {}, NOW)!;
  assert.equal(r.kind, 'carrier');
  assert.equal(r.destination, 'Colonia');
  assert.equal(r.totalJumps, 3); // four rows, the first of which is where we stand
  assert.equal(r.totalLy, 22000.5);
  assert.equal(r.waypoints[2].icyRing, true);
  assert.equal(r.waypoints[2].pristine, true);
});

test('the tritium bill is the burn, not the tank — and it says what is missing', () => {
  const r = parseCarrierPlot(CARRIER_JSON, { inTank: 1000, inHold: 0, shipCargo: 400 }, NOW)!;
  const t = r.tritium!;
  assert.equal(t.burn, 267); // 89 × 3, summed from the jumps themselves
  assert.equal(t.inTank, 1000);
  // The depot alone covers it, so nothing is owed even though Spansh's own
  // origin restock_amount (267) states the whole burn.
  assert.equal(t.shortfall, 0);
  assert.equal(t.trips, 0);

  // The case that strands people: a nearly dry carrier.
  const dry = parseCarrierPlot(CARRIER_JSON, { inTank: 50, inHold: 17, shipCargo: 400 }, NOW)!.tritium!;
  assert.equal(dry.shortfall, 200);
  assert.equal(dry.trips, 1); // one 400 t hold covers it
  const small = parseCarrierPlot(CARRIER_JSON, { inTank: 0, inHold: 0, shipCargo: 64 }, NOW)!.tritium!;
  assert.equal(small.shortfall, 267);
  assert.equal(small.trips, 5); // 267 / 64 rounded up — five trips, not four
});

test('mid-route restocks are listed; the departure load is not one of them', () => {
  const t = parseCarrierPlot(CARRIER_JSON, {}, NOW)!.tritium!;
  // Sol's restock_amount is the whole trip's fuel, an instruction for before
  // you leave — listing it as a stop would tell the commander to refuel at the
  // system they are standing in, mid-route.
  assert.equal(t.restocks.length, 1);
  assert.equal(t.restocks[0].system, 'IC 1287 Sector DB-X c1-18');
  assert.equal(t.restocks[0].tons, 140);
  assert.equal(t.restocks[0].icyRing, true);
  assert.equal(t.miningStops, 2);
});

test('a load that will not fit in the hold is flagged, not silently planned', () => {
  const fits = parseCarrierPlot(CARRIER_JSON, { freeSpace: 18590 }, NOW)!.tritium!;
  assert.equal(fits.overCapacity, false);
  const cramped = parseCarrierPlot(CARRIER_JSON, { freeSpace: 100 }, NOW)!.tritium!;
  assert.equal(cramped.overCapacity, true);
  // Tritium already aboard is part of the load, so it does not count twice.
  const partly = parseCarrierPlot(CARRIER_JSON, { inHold: 200, freeSpace: 100 }, NOW)!.tritium!;
  assert.equal(partly.overCapacity, false);
  // Unknown free space is unknown — never a warning invented from nothing.
  assert.equal(parseCarrierPlot(CARRIER_JSON, {}, NOW)!.tritium!.overCapacity, false);
});

test('a carrier reply with only an origin is not a route', () => {
  assert.equal(parseCarrierPlot('{"result":{"jumps":[{"name":"Sol"}]}}'), null);
  assert.equal(parseCarrierPlot('{"error":"Unable to find route","status":"failed"}'), null);
});

// -------------------------------------------------------------------- progress

test('progress finds the waypoint underfoot, and holds position off-route', () => {
  const r = parseCarrierPlot(CARRIER_JSON, {}, NOW)!;
  assert.equal(plotProgress(r, 'Sol'), 0);
  assert.equal(plotProgress(r, 'IC 1287 Sector DB-X c1-18'), 2);
  assert.equal(plotProgress(r, 'col 359 sector mb-a b16-7'), 1); // case-insensitive
  // Between supercharges on a ship route, or anywhere off it, the caller keeps
  // its last-good index rather than snapping back to the start.
  assert.equal(plotProgress(r, 'Deciat'), null);
  assert.equal(plotProgress(r, 'unknown'), null);
});

test('a route that passes through one system twice resolves to the later visit', () => {
  const loop = parseShipPlot(
    JSON.stringify({
      result: {
        source_system: 'Sol',
        destination_system: 'Sol',
        distance: 100,
        total_jumps: 4,
        system_jumps: [
          { system: 'Sol', distance_jumped: 0, distance_left: 100, jumps: 0, neutron_star: false },
          { system: 'Deciat', distance_jumped: 50, distance_left: 50, jumps: 2, neutron_star: true },
          { system: 'Sol', distance_jumped: 50, distance_left: 0, jumps: 2, neutron_star: false },
        ],
      },
    }),
    NOW,
  )!;
  assert.equal(plotProgress(loop, 'Sol'), 2);
});

test('what is left counts only the road ahead', () => {
  const r = parseShipPlot(SHIP_JSON, NOW)!;
  assert.deepEqual(remaining(r, 0), { jumps: 16, ly: 786.9 });
  assert.deepEqual(remaining(r, 1), { jumps: 6, ly: 379.4 });
  assert.deepEqual(remaining(r, 2), { jumps: 0, ly: 0 });
  assert.equal(nextWaypoint(r, 1)!.system, 'Nova Aquila No 3');
  assert.equal(nextWaypoint(r, 2), null);
});

// ----------------------------------------------------------------- the words

test('the spoken summary names the destination, the cost and the first stop', () => {
  const ship = plotSummary(parseShipPlot(SHIP_JSON, NOW)!);
  assert.match(ship, /Neutron route to Colonia/);
  assert.match(ship, /63 jumps/);
  assert.match(ship, /First stop PSR J1752-2806/);

  const short = plotSummary(parseCarrierPlot(CARRIER_JSON, { inTank: 40 }, NOW)!);
  assert.match(short, /Carrier route to Colonia: 3 carrier jumps/);
  assert.match(short, /burns 267 tons of tritium/);
  assert.match(short, /227 short/);
  const ok = plotSummary(parseCarrierPlot(CARRIER_JSON, { inTank: 1000 }, NOW)!);
  assert.match(ok, /you have enough/);
});

test('the operator is told the shortfall in the same breath as the destination', () => {
  const r = parseCarrierPlot(CARRIER_JSON, { inTank: 50, inHold: 0, freeSpace: 10 }, NOW)!;
  const line = plotContextLine(r, 0);
  assert.match(line, /Fleet-carrier route plotted to Colonia/);
  assert.match(line, /3 jump\(s\)/);
  assert.match(line, /next waypoint Col 359 Sector MB-A b16-7/);
  assert.match(line, /217 t short/);
  assert.match(line, /cannot hold the whole load/);
  // At the end of the route there is no next waypoint to name.
  assert.match(plotContextLine(r, 3), /at the final waypoint/);
  // A ship route says supercharge, and never mentions tritium.
  const ship = plotContextLine(parseShipPlot(SHIP_JSON, NOW)!, 0);
  assert.match(ship, /neutron — supercharge/);
  assert.doesNotMatch(ship, /tritium/);
});

test('distances read the way a commander says them', () => {
  assert.equal(fmtLy(407.486), '407.5 ly');
  assert.equal(fmtLy(22000.47), '22,000 ly');
  assert.equal(fmtLy(0), '0 ly');
});
