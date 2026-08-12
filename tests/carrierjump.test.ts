/**
 * Carrier jump clocks — lockdown countdown and post-jump cooldown.
 *
 * Every event and every timing below is taken from a real 44-jump carrier run,
 * not from folklore about how long a carrier takes:
 *
 *   10:50:00  CarrierJumpRequest  → DepartureTime 11:06:10   (16m10s lockdown)
 *   11:06:10  CarrierLocation     → arrived
 *   ...
 *   12:37:10  CarrierLocation     → arrived
 *   12:42:12  CarrierJumpRequest  → accepted, 5m02s later
 *
 * That last pair is the cooldown: a commander clicking two seconds after it
 * cleared. Five minutes from arrival.
 *
 * The trap is CarrierLocation, which ALSO fires as a periodic status refresh —
 * four times in one evening while the carrier sat still in Tir. Treating those
 * as arrivals would restart the cooldown at random.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARRIER_COOLDOWN_S,
  CarrierJumpAnnouncer,
  CarrierJumpTracker,
  describePhase,
  fmtClock,
} from '../src/engine/carrierjump.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const at = (iso: string, o: Record<string, unknown>): JournalEvent =>
  ({ timestamp: iso, ...o }) as unknown as JournalEvent;

const T = (hhmmss: string): number => Date.parse(`2026-08-08T${hhmmss}Z`);

// The commander's real second hop.
const REQUEST = at('2026-08-08T11:30:22Z', {
  event: 'CarrierJumpRequest',
  CarrierID: 3712889600,
  SystemName: 'Dryooe Flyou OB-P b35-14',
  DepartureTime: '2026-08-08T11:46:10Z',
});
const ARRIVE = at('2026-08-08T11:46:10Z', {
  event: 'CarrierLocation',
  CarrierID: 3712889600,
  StarSystem: 'Dryooe Flyou OB-P b35-14',
});

// ----------------------------------------------------------------- the clock

test('the digital readout is M:SS', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(9), '0:09');
  assert.equal(fmtClock(300), '5:00');
  assert.equal(fmtClock(948), '15:48');
  assert.equal(fmtClock(-5), '0:00'); // never counts backwards
});

test('nothing known yet is idle, not a zeroed clock', () => {
  const t = new CarrierJumpTracker();
  assert.deepEqual(t.phase(T('11:00:00')), { kind: 'idle' });
  assert.equal(describePhase(t.phase(T('11:00:00'))), null);
});

// ------------------------------------------------------------- the lockdown

test('a scheduled jump counts down to its own DepartureTime', () => {
  const t = new CarrierJumpTracker();
  t.apply(REQUEST);
  assert.equal(t.destination, 'Dryooe Flyou OB-P b35-14');

  const p = t.phase(T('11:30:22'));
  assert.equal(p.kind, 'countdown');
  // 11:30:22 → 11:46:10 is 15m48s. Straight from the journal, not a constant.
  assert.equal(Math.round((p as { secondsLeft: number }).secondsLeft), 948);
  assert.match(describePhase(p)!, /jumps to Dryooe Flyou OB-P b35-14 in 15:48/);

  const near = t.phase(T('11:45:40'));
  assert.equal(Math.round((near as { secondsLeft: number }).secondsLeft), 30);
});

test('past the departure time it holds at zero rather than going negative', () => {
  const t = new CarrierJumpTracker();
  t.apply(REQUEST);
  const p = t.phase(T('11:47:00'));
  assert.equal(p.kind, 'countdown');
  assert.equal((p as { secondsLeft: number }).secondsLeft, 0);
});

test('a cancelled jump clears the countdown', () => {
  const t = new CarrierJumpTracker();
  t.apply(REQUEST);
  t.apply(at('2026-08-08T11:35:00Z', { event: 'CarrierJumpCancelled', CarrierID: 3712889600 }));
  assert.equal(t.destination, null);
  assert.equal(t.phase(T('11:36:00')).kind, 'idle');
});

// -------------------------------------------------------------- the cooldown

test('arrival starts a five-minute cooldown, measured from the real run', () => {
  const t = new CarrierJumpTracker();
  t.apply(REQUEST);
  t.apply(ARRIVE);

  const justArrived = t.phase(T('11:46:10'));
  assert.equal(justArrived.kind, 'cooldown');
  assert.equal(Math.round((justArrived as { secondsLeft: number }).secondsLeft), CARRIER_COOLDOWN_S);
  assert.match(describePhase(justArrived)!, /next jump in 5:00/);

  const halfway = t.phase(T('11:48:40'));
  assert.equal(Math.round((halfway as { secondsLeft: number }).secondsLeft), 150);

  // 12:37:10 + 5:00 → the commander's next request landed at +5m02s.
  assert.equal(t.phase(T('11:51:10')).kind, 'ready');
  assert.match(describePhase(t.phase(T('11:51:12')))!, /ready to jump/);
});

test('a periodic CarrierLocation in the SAME system is not an arrival', () => {
  const t = new CarrierJumpTracker();
  t.apply(REQUEST);
  t.apply(ARRIVE);
  // Four of these fired in one evening while the carrier sat still in Tir.
  t.apply(at('2026-08-08T11:49:00Z', { event: 'CarrierLocation', StarSystem: 'Dryooe Flyou OB-P b35-14' }));
  // The cooldown must still be the one that started at 11:46:10, not restarted.
  const p = t.phase(T('11:49:10'));
  assert.equal(p.kind, 'cooldown');
  assert.equal(Math.round((p as { secondsLeft: number }).secondsLeft), 120);
  assert.equal(t.phase(T('11:51:11')).kind, 'ready');
});

test('CarrierJump aboard the carrier is the same arrival, not a second one', () => {
  const t = new CarrierJumpTracker();
  t.apply(REQUEST);
  t.apply(ARRIVE);
  // The real run: CarrierJump lands ~1 min after CarrierLocation, same system.
  t.apply(at('2026-08-08T11:47:13Z', { event: 'CarrierJump', StarSystem: 'Dryooe Flyou OB-P b35-14', Docked: true }));
  assert.equal(Math.round((t.phase(T('11:47:13')) as { secondsLeft: number }).secondsLeft), 237);
});

test('the whole cycle runs end to end', () => {
  const t = new CarrierJumpTracker();
  t.apply(at('2026-08-08T10:50:00Z', {
    event: 'CarrierJumpRequest', SystemName: 'Dryooe Flyou VV-A c28-55', DepartureTime: '2026-08-08T11:06:10Z',
  }));
  assert.equal(t.phase(T('10:55:00')).kind, 'countdown');
  t.apply(at('2026-08-08T11:06:10Z', { event: 'CarrierLocation', StarSystem: 'Dryooe Flyou VV-A c28-55' }));
  assert.equal(t.phase(T('11:07:00')).kind, 'cooldown');
  assert.equal(t.phase(T('11:11:11')).kind, 'ready');
  // ...and the next hop starts the whole thing again.
  t.apply(at('2026-08-08T11:30:22Z', {
    event: 'CarrierJumpRequest', SystemName: 'Dryooe Flyou OB-P b35-14', DepartureTime: '2026-08-08T11:46:10Z',
  }));
  assert.equal(t.phase(T('11:31:00')).kind, 'countdown');
});

test('the clocks survive a restart mid-lockdown', () => {
  const t = new CarrierJumpTracker();
  t.apply(REQUEST);
  const restored = new CarrierJumpTracker();
  restored.load(JSON.parse(JSON.stringify(t.toJSON())));
  assert.equal(restored.destination, 'Dryooe Flyou OB-P b35-14');
  assert.equal(Math.round((restored.phase(T('11:40:10')) as { secondsLeft: number }).secondsLeft), 360);
  restored.load(null);
  assert.equal(restored.destination, 'Dryooe Flyou OB-P b35-14');
});

test('a cooldown still running survives a restart; a finished one is not restored', () => {
  const t = new CarrierJumpTracker();
  t.apply(REQUEST);
  t.apply(ARRIVE); // 11:46:10
  const saved = JSON.parse(JSON.stringify(t.toJSON()));

  // Restarted two minutes in: the clock the commander is watching carries over.
  const soon = new CarrierJumpTracker();
  soon.load(saved, T('11:48:10'));
  assert.equal(soon.phase(T('11:48:10')).kind, 'cooldown');

  // Restarted the next evening: a cooldown that expired while the app was shut
  // is not news. Restoring it made the card claim READY TO JUMP for a jump made
  // hours ago, with nothing plotted.
  const later = new CarrierJumpTracker();
  later.load(saved, T('19:00:00'));
  assert.equal(later.phase(T('19:00:00')).kind, 'idle');
  // It still knows where the carrier is, so the next real jump is spotted.
  later.apply(at('2026-08-08T19:05:00Z', { event: 'CarrierLocation', StarSystem: 'Dryio Flyuae ZH-E a30-0' }));
  assert.equal(later.phase(T('19:05:00')).kind, 'cooldown');
});

// ------------------------------------------------------------- the callouts

test('the commander is told once at a minute out, and once when clear', () => {
  const a = new CarrierJumpAnnouncer();
  const t = new CarrierJumpTracker();
  t.apply(REQUEST);
  assert.equal(a.next(t.phase(T('11:40:00'))), null); // 6 min out: quiet
  const warn = a.next(t.phase(T('11:45:30')));
  assert.match(warn!, /jumps to Dryooe Flyou OB-P b35-14 in about a minute/);
  // Never twice for the same jump.
  assert.equal(a.next(t.phase(T('11:45:35'))), null);

  t.apply(ARRIVE);
  assert.equal(a.next(t.phase(T('11:47:00'))), null); // cooling: quiet
  assert.match(a.next(t.phase(T('11:51:20')))!, /clear to jump again/);
  // ...and it does not nag every tick after that.
  assert.equal(a.next(t.phase(T('11:51:25'))), null);
});

test('the clear call is never repeated, however long the carrier sits ready', () => {
  const a = new CarrierJumpAnnouncer();
  const t = new CarrierJumpTracker();
  t.apply(REQUEST);
  t.apply(ARRIVE);
  a.next(t.phase(T('11:47:00'))); // watched the cooldown start
  assert.match(a.next(t.phase(T('11:51:20')))!, /clear to jump again/);
  // 'ready' is where the carrier RESTS — every 15 s heartbeat for the rest of
  // the evening sees it. The old timer gate re-fired this every five minutes.
  for (let m = 52; m < 90; m++) {
    assert.equal(a.next(t.phase(T(`${11 + Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:00`))), null);
  }
});

test('a carrier that never plotted anything is never told it is clear', () => {
  const a = new CarrierJumpAnnouncer();
  const t = new CarrierJumpTracker();
  // No jump plotted — just the periodic CarrierLocation refresh, which fires
  // for anyone who owns a carrier, sitting still in Tir.
  t.apply(at('2026-08-08T11:00:00Z', { event: 'CarrierLocation', StarSystem: 'Tir' }));
  assert.equal(t.phase(T('11:00:01')).kind, 'idle');
  t.apply(at('2026-08-08T11:20:00Z', { event: 'CarrierLocation', StarSystem: 'Tir' }));
  assert.equal(t.phase(T('11:25:00')).kind, 'idle');
  assert.equal(a.next(t.phase(T('11:25:00'))), null);
  assert.equal(a.next(t.phase(T('11:40:00'))), null);
});

test('each new jump re-arms both callouts', () => {
  const a = new CarrierJumpAnnouncer();
  const t = new CarrierJumpTracker();
  t.apply(REQUEST);
  a.next(t.phase(T('11:45:30')));
  t.apply(ARRIVE);
  a.next(t.phase(T('11:51:20')));
  // Second hop, a different destination: the minute warning must fire again.
  t.apply(at('2026-08-08T11:54:00Z', {
    event: 'CarrierJumpRequest', SystemName: 'Dryio Flyuae ZH-E a30-0', DepartureTime: '2026-08-08T12:10:10Z',
  }));
  assert.match(a.next(t.phase(T('12:09:30')))!, /Dryio Flyuae ZH-E a30-0/);
  // ...and so must the clear call, once, for that second hop.
  t.apply(at('2026-08-08T12:10:10Z', { event: 'CarrierLocation', StarSystem: 'Dryio Flyuae ZH-E a30-0' }));
  assert.equal(a.next(t.phase(T('12:12:00'))), null);
  assert.match(a.next(t.phase(T('12:15:20')))!, /clear to jump again/);
  assert.equal(a.next(t.phase(T('12:15:35'))), null);
});
