/** Death Clock — scan calibration, orbital phase, window schedule, alerts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeathClock,
  DeathClockAnnouncer,
  WOD_BODY,
  WOD_DEFAULTS,
  fmtDur,
  orbitXY,
  phaseOf,
  speakableDur,
  type DeathClockState,
} from '../src/engine/deathclock.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const SCAN_TS = '2026-08-05T12:00:00Z';
const SCAN_MS = Date.parse(SCAN_TS);

const scan = (o: Record<string, unknown> = {}): JournalEvent =>
  ({
    event: 'Scan',
    timestamp: SCAN_TS,
    BodyName: WOD_BODY,
    OrbitalPeriod: 5273,
    MeanAnomaly: 90,
    ...o,
  }) as unknown as JournalEvent;

/** A calibrated state with periapsis at ms 0 and the community timings. */
const atPeri: DeathClockState = {
  epochMs: 0,
  calibratedAt: 0,
  source: 'mark',
  ...WOD_DEFAULTS,
};

// --------------------------------------------------------------- calibration

test('a scan of A 1 calibrates the epoch from MeanAnomaly', () => {
  const dc = new DeathClock();
  assert.equal(dc.apply(scan()), true);
  // 90° of 360° → a quarter period past periapsis at the scan instant.
  const expected = SCAN_MS - (90 / 360) * 5273 * 1000;
  assert.equal(dc.state.epochMs, expected);
  assert.equal(dc.state.period, 5273);
  assert.equal(dc.state.source, 'scan');
  const p = phaseOf(dc.state, SCAN_MS)!;
  assert.ok(Math.abs(p.t - 5273 / 4) < 0.001);
  assert.equal(p.zone, 'clear'); // 1318 s is inside the 720–2213 s clear arc
});

test('scans of other bodies or without orbital elements are ignored', () => {
  const dc = new DeathClock();
  assert.equal(dc.apply(scan({ BodyName: 'Spoihaae XE-X d2-9 A 2' })), false);
  assert.equal(dc.apply(scan({ MeanAnomaly: undefined })), false);
  assert.equal(dc.apply(scan({ OrbitalPeriod: undefined })), false);
  assert.equal(dc.state.epochMs, null);
});

test('body-name match is case-insensitive and a later scan recalibrates', () => {
  const dc = new DeathClock();
  assert.equal(dc.apply(scan({ BodyName: WOD_BODY.toUpperCase() })), true);
  const later = new Date(SCAN_MS + 3600_000).toISOString();
  assert.equal(dc.apply(scan({ timestamp: later, MeanAnomaly: 0 })), true);
  assert.equal(dc.state.epochMs, SCAN_MS + 3600_000);
});

test('manual marks set the epoch by offset; clear wipes it', () => {
  const dc = new DeathClock();
  dc.mark('open', 1_000_000);
  assert.equal(dc.state.epochMs, 1_000_000 - WOD_DEFAULTS.open * 1000);
  assert.equal(phaseOf(dc.state, 1_000_000)!.zone, 'clear');
  dc.mark('peri', 2_000_000);
  assert.equal(dc.state.epochMs, 2_000_000);
  dc.mark('apo', 3_000_000);
  assert.equal(dc.state.epochMs, 3_000_000 - (WOD_DEFAULTS.period / 2) * 1000);
  dc.mark('clear', 4_000_000);
  assert.equal(dc.state.epochMs, null);
  assert.equal(phaseOf(dc.state, 4_000_000), null);
});

test('load/toJSON roundtrips; garbage and broken geometry fall to defaults', () => {
  const dc = new DeathClock();
  dc.mark('peri', 5_000);
  const dc2 = new DeathClock();
  dc2.load(JSON.parse(JSON.stringify(dc.toJSON())));
  assert.deepEqual(dc2.state, dc.state);
  const dc3 = new DeathClock();
  dc3.load(null);
  dc3.load('junk');
  dc3.load({ period: 5, open: 9999, close: 3 }); // nonsense timings
  assert.equal(dc3.state.period, WOD_DEFAULTS.period);
  assert.equal(dc3.state.open, WOD_DEFAULTS.open);
  assert.equal(dc3.state.epochMs, null);
});

// --------------------------------------------------------------------- phase

test('phase zones and countdowns across one orbit', () => {
  // Exclusion: 100 s past periapsis, window opens in 620 s.
  let p = phaseOf(atPeri, 100_000)!;
  assert.equal(p.zone, 'exclusion');
  assert.equal(p.inWindow, false);
  assert.ok(Math.abs(p.opensInS - 620) < 0.001);
  assert.equal(p.countdownS, p.opensInS);

  // Clear: counts down to leave-by (close − buffer = 2213 s).
  p = phaseOf(atPeri, 1_000_000)!;
  assert.equal(p.zone, 'clear');
  assert.equal(p.inWindow, true);
  assert.ok(Math.abs(p.countdownS - 1213) < 0.001);
  assert.ok(Math.abs(p.closesInS! - 1393) < 0.001);

  // Board: past leave-by, counts down to the hard close.
  p = phaseOf(atPeri, 2_300_000)!;
  assert.equal(p.zone, 'board');
  assert.ok(Math.abs(p.countdownS - 93) < 0.001);

  // Jet cone: next opening is through periapsis, P − t + open.
  p = phaseOf(atPeri, 3_000_000)!;
  assert.equal(p.zone, 'jet');
  assert.ok(Math.abs(p.opensInS - (5273 - 3000 + 720)) < 0.001);
  assert.ok(Math.abs(p.periInS - 2273) < 0.001);

  // Negative time (now before the epoch) still lands in [0, P).
  p = phaseOf(atPeri, -100_000)!;
  assert.ok(p.t >= 0 && p.t < 5273);
  assert.ok(Math.abs(p.t - (5273 - 100)) < 0.001);
});

test('window schedule: first row is the open window, then one per period', () => {
  const p = phaseOf(atPeri, 1_000_000)!; // in window, 280 s after it opened
  assert.equal(p.windows.length, 4);
  assert.equal(p.windows[0].startsInS, -280); // open right now
  assert.ok(Math.abs(p.windows[0].closesAtMs - 2_393_000) < 1);
  assert.ok(Math.abs(p.windows[0].leaveByMs - 2_213_000) < 1);
  assert.equal(p.windows[1].startsInS, -280 + 5273);
  // Held off the planet, the first row is the coming window.
  const hold = phaseOf(atPeri, 100_000)!;
  assert.equal(hold.windows[0].startsInS, 620);
  assert.ok(Math.abs(hold.windows[0].opensAtMs - 720_000) < 1);
});

test('orbitXY puts periapsis near the star and apoapsis far side', () => {
  const peri = orbitXY(0, 5273);
  assert.ok(Math.abs(peri.x - 0.06) < 0.001 && Math.abs(peri.y) < 0.001);
  const apo = orbitXY(5273 / 2, 5273);
  assert.ok(Math.abs(apo.x + 2.5) < 0.001 && Math.abs(apo.y) < 0.001);
});

// --------------------------------------------------------------- formatting

test('fmtDur and speakableDur', () => {
  assert.equal(fmtDur(0), '0:00');
  assert.equal(fmtDur(61), '1:01');
  assert.equal(fmtDur(3671), '1:01:11');
  assert.equal(speakableDur(45), '45 seconds');
  assert.equal(speakableDur(90), '90 seconds');
  assert.equal(speakableDur(120), '2 minutes');
  assert.equal(speakableDur(3600), '1 hour');
  assert.equal(speakableDur(5400), '1 hour 30 minutes');
});

// ------------------------------------------------------------------- alerts

const ph = (tSec: number) => phaseOf(atPeri, tSec * 1000)!;

test('announcer: silent outside the system, arrival status on entry', () => {
  const ann = new DeathClockAnnouncer();
  assert.deepEqual(ann.tick(ph(3000), false), []);
  const a = ann.tick(ph(3000), true);
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'arrival');
  assert.match(a[0].message, /hold off the planet/i);
  // Steady state: no repeats.
  assert.deepEqual(ann.tick(ph(3010), true), []);
});

test('announcer: arrival while uncalibrated suggests the scan', () => {
  const ann = new DeathClockAnnouncer();
  const a = ann.tick(null, true);
  assert.equal(a.length, 1);
  assert.match(a[0].message, /scan planet A 1/i);
  assert.deepEqual(ann.tick(null, true), []);
});

test('announcer: open → leave-by → closed transitions each fire once', () => {
  const ann = new DeathClockAnnouncer();
  ann.tick(ph(500), true); // arrival baseline (exclusion)
  let a = ann.tick(ph(730), true);
  assert.equal(a[0]?.kind, 'window-open');
  assert.equal(a[0]?.severity, 'warn');
  assert.deepEqual(ann.tick(ph(1500), true), []);
  a = ann.tick(ph(2250), true);
  assert.equal(a[0]?.kind, 'leave-by');
  assert.equal(a[0]?.severity, 'urgent');
  a = ann.tick(ph(2400), true);
  assert.equal(a[0]?.kind, 'window-closed');
  assert.deepEqual(ann.tick(ph(2500), true), []);
});

test('announcer: one opens-soon warning per cycle, none stacked on arrival', () => {
  const ann = new DeathClockAnnouncer();
  ann.tick(ph(3000), true); // arrival, opening far away
  assert.deepEqual(ann.tick(ph(4000), true), []); // still far (opensIn 1993)
  const a = ann.tick(ph(470), true); // wrapped into exclusion, opensIn 250
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'opens-soon');
  assert.deepEqual(ann.tick(ph(600), true), []); // no repeat
  // The window opening resets the pre-warning for the NEXT cycle.
  assert.equal(ann.tick(ph(730), true)[0]?.kind, 'window-open');
  ann.tick(ph(3000), true); // window-closed fires, opening far again
  const b = ann.tick(ph(470), true); // next cycle back inside the lead
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, 'opens-soon');
});

test('announcer: arrival inside a near-opening hold does not double up', () => {
  const ann = new DeathClockAnnouncer();
  const a = ann.tick(ph(500), true); // opensIn 220 — inside the warn lead
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'arrival');
  assert.deepEqual(ann.tick(ph(600), true), []); // opens-soon already spent
});

test('announcer: prime() suppresses the arrival repeat, keeps transitions', () => {
  const ann = new DeathClockAnnouncer();
  ann.prime(ph(1000), true); // a calibration line just spoke this picture
  assert.deepEqual(ann.tick(ph(1010), true), []); // no arrival repeat
  assert.equal(ann.tick(ph(2250), true)[0]?.kind, 'leave-by'); // edges still fire
  // Priming inside the pre-open lead also spends the opens-soon warning.
  const ann2 = new DeathClockAnnouncer();
  ann2.prime(ph(500), true); // exclusion, opens in 220 s
  assert.deepEqual(ann2.tick(ph(600), true), []);
});

test('announcer: leaving the system re-arms the arrival call', () => {
  const ann = new DeathClockAnnouncer();
  ann.tick(ph(1000), true);
  assert.deepEqual(ann.tick(ph(1010), false), []);
  const a = ann.tick(ph(1020), true);
  assert.equal(a[0]?.kind, 'arrival');
  assert.match(a[0].message, /window is open/i);
});
