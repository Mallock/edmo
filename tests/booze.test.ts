/**
 * The run to Rackham's Peak.
 *
 * The load-bearing decisions get pinned here: the holiday is read from the
 * PRICE and never from a date, "nobody has looked" stays distinct from "the
 * holiday is off", and the pace is the commander's own measured lap rather
 * than a number from a guide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLIDAY_PRICE,
  QUIET_PRICE,
  creditsPerHour,
  etaMs,
  isPeak,
  medianRoundTripMs,
  peakStateFromPrice,
  runEconomics,
  runsRemaining,
  tally,
  type Delivery,
} from '../src/engine/booze.ts';

test('the holiday is read from the price, and only from the price', () => {
  assert.equal(peakStateFromPrice(HOLIDAY_PRICE), 'holiday');
  assert.equal(peakStateFromPrice(QUIET_PRICE), 'quiet');
  // The gap is enormous; nothing plausible lands between them by accident.
  assert.equal(peakStateFromPrice(45_000), 'quiet');
  assert.equal(peakStateFromPrice(310_000), 'holiday');
});

test('never read is not the same as not on', () => {
  // The difference decides whether the panel says "quiet" (a fact) or "nobody
  // has looked" (the truth) — and one of those sends people 5,000 ly.
  assert.equal(peakStateFromPrice(null), 'unknown');
  assert.equal(peakStateFromPrice(undefined), 'unknown');
  assert.equal(peakStateFromPrice(0), 'unknown');
});

test('a run is worth what THIS ship earns at THESE prices', () => {
  // Type-8, 400 t, holiday rate, wine bought at 20k.
  const e = runEconomics(400, 275_000, 20_000);
  assert.equal(e.grossPerRun, 110_000_000);
  assert.equal(e.netPerRun, 110_000_000 - 8_000_000);
  // A carrier charging over the odds shows up as a smaller number — the
  // whole reason the buy price is read rather than assumed.
  const gouged = runEconomics(400, 275_000, 120_000);
  assert.ok(gouged.netPerRun! < e.netPerRun!);
  // Unknown purchase price stays unknown rather than pretending it is free.
  assert.equal(runEconomics(280, 275_000, null).netPerRun, null);
  assert.equal(runEconomics(280, 275_000, null).grossPerRun, 77_000_000);
});

test('the pace is measured, and one long break does not become the pace', () => {
  const d = (min: number): Delivery => ({ at: min * 60_000, tons: 400, credits: 1 });
  // Four laps of roughly 25 minutes, then a night's sleep, then two more.
  const runs = [d(0), d(25), d(51), d(75), d(600), d(626)];
  const pace = medianRoundTripMs(runs);
  assert.ok(pace !== null);
  assert.ok(pace! > 24 * 60_000 && pace! < 27 * 60_000, `pace was ${pace}`);
  // One delivery is not a pace.
  assert.equal(medianRoundTripMs([d(0)]), null);
  assert.equal(medianRoundTripMs([]), null);
});

test('runs remaining count part loads as a whole trip', () => {
  assert.equal(runsRemaining(1000, 400), 3);
  assert.equal(runsRemaining(800, 400), 2);
  assert.equal(runsRemaining(0, 400), 0);
  assert.equal(runsRemaining(null, 400), null);
  // A ship with no hold cannot be given an answer.
  assert.equal(runsRemaining(1000, 0), null);
});

test('the eta needs both a count and a measured pace', () => {
  assert.equal(etaMs(3, 1_500_000), 4_500_000);
  assert.equal(etaMs(3, null), null, 'no pace, no promise');
  assert.equal(etaMs(null, 1_500_000), null);
  assert.equal(etaMs(0, 1_500_000), null);
});

test('credits per hour reads the recent window, not the whole session', () => {
  const now = 10 * 3_600_000;
  const mk = (hoursAgo: number, credits: number): Delivery => ({
    at: now - hoursAgo * 3_600_000,
    tons: 400,
    credits,
  });
  // Two runs in the last hour, plus an old one that must not count.
  const rate = creditsPerHour([mk(5, 999), mk(1, 100_000_000), mk(0.1, 100_000_000)], now);
  assert.ok(rate !== null);
  assert.ok(rate! > 150_000_000 && rate! < 220_000_000, `rate was ${rate}`);
  // One delivery is not a rate.
  assert.equal(creditsPerHour([mk(0.5, 1)], now), null);
});

test('the tally adds up the run so far', () => {
  const t = tally([
    { at: 1, tons: 400, credits: 110_000_000 },
    { at: 2, tons: 280, credits: 77_000_000 },
  ]);
  assert.deepEqual(t, { tons: 680, credits: 187_000_000, runs: 2 });
});

test('the peak is recognised by name, and by system with no name at all', () => {
  assert.ok(isPeak("Rackham's Peak"));
  assert.ok(isPeak("rackham's peak"));
  assert.ok(isPeak('Rackham Terminal', 'HIP 58832'));
  // The station name is absent after a Location event — being in the system
  // has to be enough, or a sale after a relog goes uncounted.
  assert.ok(isPeak(null, 'HIP 58832'));
  assert.ok(isPeak(undefined, 'hip 58832'));
  assert.ok(!isPeak('Jameson Memorial', 'Shinrarta Dezhra'));
  assert.ok(!isPeak(null));
  assert.ok(!isPeak(null, 'Sol'));
});
