/** StatusTracker — Status.json parse + edge-triggered safety alerts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StatusTracker,
  parseStatus,
  isScoopableStar,
  isBusyFocus,
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
