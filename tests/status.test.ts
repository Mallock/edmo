/** StatusTracker — Status.json parse + edge-triggered safety alerts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StatusTracker,
  parseStatus,
  isScoopableStar,
  isBusyFocus,
  remainingRouteJumps,
  FLAG,
  FLAG2,
} from '../src/engine/status.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent =>
  ({ event: 'Status', timestamp: '2026-07-20T12:00:00Z', ...o } as unknown as JournalEvent);

test('parseStatus decodes flags, pips, fuel and gui focus', () => {
  const s = parseStatus(
    ev({
      Flags: FLAG.Docked | FLAG.ShieldsUp | FLAG.LowFuel,
      Flags2: 0,
      GuiFocus: 5,
      Pips: [4, 8, 0],
      Fuel: { FuelMain: 8, FuelReservoir: 0.3 },
      LegalState: 'Clean',
      Cargo: 12,
    }),
  )!;
  assert.equal(s.docked, true);
  assert.equal(s.shieldsUp, true);
  assert.equal(s.lowFuel, true);
  assert.equal(s.supercruise, false);
  assert.deepEqual(s.pips, [2, 4, 0]); // halved from raw half-pip units
  assert.equal(s.fuelMain, 8);
  assert.equal(s.guiFocusLabel, 'station services');
  assert.equal(s.cargo, 12);
});

test('parseStatus returns null for a non-status object', () => {
  assert.equal(parseStatus(ev({ Flags: undefined })), null);
});

test('tracker fires an interdiction alert on the rising edge only', () => {
  const t = new StatusTracker();
  // First snapshot establishes a baseline — never alerts.
  assert.deepEqual(t.apply(ev({ Flags: FLAG.Supercruise })), []);
  const a = t.apply(ev({ Flags: FLAG.Supercruise | FLAG.BeingInterdicted }));
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'interdiction');
  assert.equal(a[0].severity, 'urgent');
  // Still interdicted next tick → no repeat (edge already consumed).
  assert.deepEqual(t.apply(ev({ Flags: FLAG.Supercruise | FLAG.BeingInterdicted })), []);
});

test('low-fuel and overheating each fire once when raised', () => {
  const t = new StatusTracker();
  t.apply(ev({ Flags: FLAG.Supercruise }));
  const a = t.apply(ev({ Flags: FLAG.Supercruise | FLAG.LowFuel | FLAG.Overheating }));
  const kinds = a.map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['low-fuel', 'overheating']);
});

test('shields-down only alerts in a threat context', () => {
  const t = new StatusTracker();
  // Shields up, in danger; then shields fall while still in danger → alert.
  t.apply(ev({ Flags: FLAG.ShieldsUp | FLAG.InDanger }));
  const danger = t.apply(ev({ Flags: FLAG.InDanger }));
  assert.equal(danger.some((x) => x.kind === 'shields-down'), true);

  // Shields drop on a calm station approach (no danger/hardpoints) → silent.
  const t2 = new StatusTracker();
  t2.apply(ev({ Flags: FLAG.ShieldsUp }));
  const calm = t2.apply(ev({ Flags: 0 }));
  assert.equal(calm.some((x) => x.kind === 'shields-down'), false);
});

test('shields-down stays quiet when the commander is not in the cockpit', () => {
  // Reported live: an exobiology run fired this eight times between bacterium
  // samples. The ship's bits keep reporting while the commander is on foot or
  // in an SRV, and an SRV's ring flickers on every scrape of terrain — so the
  // operator told someone standing on a rock to "boost to range".
  const onFoot = new StatusTracker();
  onFoot.apply(ev({ Flags: FLAG.ShieldsUp | FLAG.InDanger, Flags2: FLAG2.OnFoot }));
  const walked = onFoot.apply(ev({ Flags: FLAG.InDanger, Flags2: FLAG2.OnFoot }));
  assert.equal(walked.some((x) => x.kind === 'shields-down'), false);

  const srv = new StatusTracker();
  srv.apply(ev({ Flags: FLAG.ShieldsUp | FLAG.InSrv | FLAG.HardpointsDeployed }));
  const scraped = srv.apply(ev({ Flags: FLAG.InSrv | FLAG.HardpointsDeployed }));
  assert.equal(scraped.some((x) => x.kind === 'shields-down'), false);

  // Docking takes the ring down by design, so that is not news either.
  const dock = new StatusTracker();
  dock.apply(ev({ Flags: FLAG.ShieldsUp | FLAG.Docked | FLAG.HardpointsDeployed }));
  const berthed = dock.apply(ev({ Flags: FLAG.Docked | FLAG.HardpointsDeployed }));
  assert.equal(berthed.some((x) => x.kind === 'shields-down'), false);

  // But being shot at while landed on a surface still is: a planet landing does
  // not drop the ring on its own, so this transition means someone hit it.
  const raided = new StatusTracker();
  raided.apply(ev({ Flags: FLAG.ShieldsUp | FLAG.Landed | FLAG.InDanger }));
  const hitOnPad = raided.apply(ev({ Flags: FLAG.Landed | FLAG.InDanger }));
  assert.equal(hitOnPad.some((x) => x.kind === 'shields-down'), true);

  // ...but a real fight in the ship still gets the warning. The guard is a
  // suppression, so a snapshot that never sets a vehicle bit is unaffected.
  const fight = new StatusTracker();
  fight.apply(ev({ Flags: FLAG.ShieldsUp | FLAG.InDanger | FLAG.InMainShip }));
  const hit = fight.apply(ev({ Flags: FLAG.InDanger | FLAG.InMainShip }));
  assert.equal(hit.some((x) => x.kind === 'shields-down'), true);
});

test('on-foot low oxygen raises an urgent alert', () => {
  const t = new StatusTracker();
  t.apply(ev({ Flags: 0, Flags2: FLAG2.OnFoot }));
  const a = t.apply(ev({ Flags: 0, Flags2: FLAG2.OnFoot | FLAG2.LowOxygen }));
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'low-oxygen');
});

test('fuel percentage needs a known tank size', () => {
  const t = new StatusTracker();
  t.setFuelCapacity(32);
  t.apply(ev({ Flags: 0, Fuel: { FuelMain: 32 } }));
  const s = t.apply(ev({ Flags: 0, Fuel: { FuelMain: 8 } }));
  // (alerts irrelevant here) — read the live status the tracker holds.
  void s;
  assert.equal(t.current!.fuelPct, 0.25);
});

test('isScoopableStar recognises KGB FOAM classes only', () => {
  for (const c of ['K', 'G', 'B', 'F', 'O', 'A', 'M']) assert.equal(isScoopableStar(c), true);
  for (const c of ['L', 'T', 'Y', 'D', 'N', 'H']) assert.equal(isScoopableStar(c), false);
  assert.equal(isScoopableStar(undefined), false);
});

test('isBusyFocus flags menus, not the flight HUD', () => {
  assert.equal(isBusyFocus(0), false); // no focus
  assert.equal(isBusyFocus(5), true); // station services
  assert.equal(isBusyFocus(6), true); // galaxy map
  assert.equal(isBusyFocus(9), true); // FSS
  assert.equal(isBusyFocus(1), false); // right panel
});

// --- plotted-route progress --------------------------------------------------
// Reported from a live session: the operator said "Two jumps left" to a
// commander who had ONE. NavRoute.json lists the whole route starting from the
// system it was plotted FROM, and Elite never rewrites it as you fly — so its
// length is right only at the instant of plotting. Progress has to come from
// where the ship actually is.

test('jumps left are counted from the ship position, not the route length', () => {
  // Plotted Colonia → Deriso: 3 hops written to the file, 4 entries.
  const route = ['Colonia', 'Kojeara', 'Luchtaine', 'Deriso'];
  assert.equal(remainingRouteJumps(route, 'Colonia'), 3); // still at the origin
  assert.equal(remainingRouteJumps(route, 'Kojeara'), 2); // one jump flown
  assert.equal(remainingRouteJumps(route, 'Luchtaine'), 1); // the live-session bug
  assert.equal(remainingRouteJumps(route, 'Deriso'), 0); // arrived
});

test('the count is case- and whitespace-insensitive, as journal names vary', () => {
  const route = ['Colonia', "Jaques's Rest", 'Deriso'];
  assert.equal(remainingRouteJumps(route, 'colonia'), 2);
  assert.equal(remainingRouteJumps(route, '  DERISO  '), 0);
  assert.equal(remainingRouteJumps(route, "jaques's rest"), 1);
});

test('a route that revisits a system counts from the LATER visit', () => {
  // A scooping detour back through a system already passed: the commander is at
  // the second occurrence, so 1 jump remains — not 3.
  const route = ['Colonia', 'Kojeara', 'Colonia', 'Deriso'];
  assert.equal(remainingRouteJumps(route, 'Colonia'), 1);
});

test('off-route and unknown positions report null, so a stale count is kept over a wrong one', () => {
  const route = ['Colonia', 'Kojeara', 'Deriso'];
  assert.equal(remainingRouteJumps(route, 'Sol'), null); // deviated
  assert.equal(remainingRouteJumps(route, 'unknown'), null); // position not yet known
  assert.equal(remainingRouteJumps(route, ''), null);
});

test('no route plotted means nothing still to run', () => {
  assert.equal(remainingRouteJumps([], 'Colonia'), 0);
  assert.equal(remainingRouteJumps([], 'unknown'), 0);
});

test('a single-entry route is already complete', () => {
  // Elite writes the origin alone when a plot is cleared to the current system.
  assert.equal(remainingRouteJumps(['Colonia'], 'Colonia'), 0);
});
