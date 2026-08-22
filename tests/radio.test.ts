/**
 * Radio profiles and the bus arithmetic.
 *
 * Everything here runs with no DOM and no audio device — that is the point of
 * keeping the profile table and the bus/queue decisions in src/engine. The
 * Web Audio graph itself (src/ui/radio.ts) is exercised by the app, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RADIO_PROFILES,
  RADIO_PROFILE_NAMES,
  dbToGain,
  isBypass,
  radioProfile,
  validateProfile,
  type RadioProfile,
} from '../src/engine/chatter/profiles.ts';
import { LruCache, synthKey } from '../src/engine/chatter/wavcache.ts';

test('every profile in the table validates', () => {
  for (const name of RADIO_PROFILE_NAMES) {
    const why = validateProfile(RADIO_PROFILES[name]);
    assert.equal(why, null, `${name}: ${why}`);
  }
});

test('the table covers every channel character the design names', () => {
  for (const name of [
    'clean',
    'station',
    'local',
    'crew',
    'deep',
    'emergency',
    'carrier',
    'concourse',
  ]) {
    assert.ok(RADIO_PROFILE_NAMES.includes(name as never), `missing profile: ${name}`);
  }
});

test('station reads as radio: high-passed and bracketed by a tone', () => {
  const p = RADIO_PROFILES.station;
  assert.ok(p.hpfHz >= 300, 'station must be high-passed into the telephone band');
  assert.notEqual(p.beep, 'none', 'station must bracket its transmissions');
});

test('unknown profile name falls back to clean without throwing', () => {
  assert.equal(radioProfile('no-such-profile'), RADIO_PROFILES.clean);
  assert.equal(radioProfile(''), RADIO_PROFILES.clean);
  assert.equal(radioProfile(null), RADIO_PROFILES.clean);
  assert.equal(radioProfile(undefined), RADIO_PROFILES.clean);
});

test('known profile name resolves to its own entry', () => {
  assert.equal(radioProfile('deep'), RADIO_PROFILES.deep);
  assert.equal(radioProfile('emergency'), RADIO_PROFILES.emergency);
});

test('clean is a true bypass and nothing else is', () => {
  assert.ok(isBypass(RADIO_PROFILES.clean));
  for (const name of RADIO_PROFILE_NAMES) {
    if (name === 'clean') continue;
    assert.ok(!isBypass(RADIO_PROFILES[name]), `${name} must not be a bypass`);
  }
});

test('emergency is the only profile that pushes louder than unity', () => {
  const loud = RADIO_PROFILE_NAMES.filter((n) => RADIO_PROFILES[n].gainDb > 0);
  assert.deepEqual(loud, ['emergency']);
});

test('deep sounds further away than station', () => {
  const deep = RADIO_PROFILES.deep;
  const station = RADIO_PROFILES.station;
  assert.ok(deep.drive > station.drive, 'deep should be more saturated');
  assert.ok(deep.lpfHz < station.lpfHz, 'deep should be narrower');
  assert.ok((deep.hissDb ?? -999) > (station.hissDb ?? -999), 'deep should be hissier');
  assert.ok(deep.popsPerMin > station.popsPerMin, 'deep should break up more');
});

test('crew is the shelter: least processed of the live channels', () => {
  const crew = RADIO_PROFILES.crew;
  for (const name of ['station', 'local', 'deep', 'emergency'] as const) {
    assert.ok(crew.drive < RADIO_PROFILES[name].drive, `crew should be cleaner than ${name}`);
    assert.ok(crew.lpfHz > RADIO_PROFILES[name].lpfHz, `crew should be wider than ${name}`);
  }
});

test('concourse is not radio: no squelch, no beeps, pushed back', () => {
  const p = RADIO_PROFILES.concourse;
  assert.equal(p.squelchMs, 0);
  assert.equal(p.beep, 'none');
  assert.ok(p.gainDb < 0);
});

test('validateProfile rejects malformed profiles', () => {
  const base: RadioProfile = RADIO_PROFILES.station;
  const bad = (over: Partial<RadioProfile>): string | null =>
    validateProfile({ ...base, ...over } as RadioProfile);

  assert.match(bad({ drive: 1.5 }) ?? '', /drive/);
  assert.match(bad({ drive: -0.1 }) ?? '', /drive/);
  assert.match(bad({ hpfHz: -1 }) ?? '', /hpfHz/);
  assert.match(bad({ hpfHz: 9000, lpfHz: 3400 }) ?? '', /below/);
  assert.match(bad({ hissDb: 6 }) ?? '', /hissDb/);
  assert.match(bad({ popsPerMin: -1 }) ?? '', /popsPerMin/);
  assert.match(bad({ squelchMs: -5 }) ?? '', /squelchMs/);
  assert.match(bad({ beep: 'squawk' as never }) ?? '', /beep/);
  assert.match(bad({ gainDb: Number.NaN }) ?? '', /gainDb/);
});

test('validateProfile accepts a null hiss bed', () => {
  assert.equal(validateProfile({ ...RADIO_PROFILES.station, hissDb: null }), null);
});

test('dbToGain matches the decibel definition', () => {
  assert.ok(Math.abs(dbToGain(0) - 1) < 1e-9);
  assert.ok(Math.abs(dbToGain(-6) - 0.5012) < 1e-3);
  assert.ok(Math.abs(dbToGain(-14) - 0.1995) < 1e-3);
  assert.ok(dbToGain(2) > 1);
});

// ---------------------------------------------------------------------------
// Synthesis cache (task 3.7 / 3.9)
// ---------------------------------------------------------------------------

test('cache key is exactly the three synthesis inputs', () => {
  assert.equal(synthKey('hello', 'alba', 1), synthKey('hello', 'alba', 1));
  assert.notEqual(synthKey('hello', 'alba', 1), synthKey('hello', 'joe', 1));
  assert.notEqual(synthKey('hello', 'alba', 1), synthKey('goodbye', 'alba', 1));
  assert.notEqual(synthKey('hello', 'alba', 1), synthKey('hello', 'alba', 1.06));
});

test('cache key tolerates float noise from persona multiplication', () => {
  // Personas derive lengthScale by multiplying (design D7a), so the same
  // logical voice must not become a thousand distinct keys.
  const a = synthKey('x', 'alba', 0.9400000000000001);
  const b = synthKey('x', 'alba', 0.94);
  assert.equal(a, b);
});

test('a null voice is a stable key, not a random one', () => {
  assert.equal(synthKey('x', null, 1), synthKey('x', undefined, 1));
});

test('cache returns the stored value and counts the hit', () => {
  const c = new LruCache<string>(4);
  assert.equal(c.get('a'), undefined);
  c.set('a', 'wav-a');
  assert.equal(c.get('a'), 'wav-a');
  const s = c.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
});

test('cache evicts least-recently-used first', () => {
  const c = new LruCache<string>(3);
  c.set('a', '1');
  c.set('b', '2');
  c.set('c', '3');
  c.get('a'); // 'a' is now the youngest, 'b' the oldest
  c.set('d', '4');

  assert.equal(c.size, 3);
  assert.equal(c.has('b'), false, 'oldest untouched entry should go');
  assert.deepEqual(c.keys(), ['c', 'a', 'd']);
});

test('re-setting an existing key refreshes rather than duplicating', () => {
  const c = new LruCache<string>(2);
  c.set('a', '1');
  c.set('b', '2');
  c.set('a', '1b');
  assert.equal(c.size, 2);
  assert.deepEqual(c.keys(), ['b', 'a']);
  assert.equal(c.get('a'), '1b');
});

test('a cache miss never throws', () => {
  const c = new LruCache<string>(1);
  assert.doesNotThrow(() => c.get('nothing'));
  assert.equal(c.get('nothing'), undefined);
});

test('cache capacity below one is clamped', () => {
  const c = new LruCache<string>(0);
  c.set('a', '1');
  assert.equal(c.size, 1);
  assert.equal(c.get('a'), '1');
});
