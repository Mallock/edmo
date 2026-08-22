/**
 * Chatter engine — bus arithmetic, the ambient queue, and the DOM-free canary.
 *
 * The canary matters: every module under src/engine/chatter/ must import in a
 * bare Node process, because that is how the test runner loads .ts. The moment
 * one of them reaches for `window` or `AudioContext` the whole suite stops
 * being able to see the decision logic, and the decisions are the part worth
 * testing. src/ui/radio.ts is the only file allowed to touch Web Audio.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AMBIENT_QUEUE_CAP,
  AmbientQueue,
  DEFAULT_TTL_MS,
  DUCK_ATTACK_MS,
  DUCK_DB,
  DUCK_RESTORE_MS,
  ambientGainDb,
  duckRampMs,
  type AmbientItem,
} from '../src/engine/chatter/bus.ts';
import { RADIO_PROFILE_NAMES } from '../src/engine/chatter/profiles.ts';

// ---------------------------------------------------------------------------
// Canary (task 1.4)
// ---------------------------------------------------------------------------

test('chatter engine modules import with no DOM', () => {
  // Reaching this line at all means the imports above resolved in bare Node.
  assert.ok(RADIO_PROFILE_NAMES.length > 0);
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof (globalThis as { AudioContext?: unknown }).AudioContext, 'undefined');
});

// ---------------------------------------------------------------------------
// Ducking
// ---------------------------------------------------------------------------

test('ambient ducks by the configured depth while priority sounds', () => {
  assert.equal(ambientGainDb(0, false), 0);
  assert.equal(ambientGainDb(0, true), DUCK_DB);
});

test('ducking is relative to the user volume, not an absolute target', () => {
  // Someone who set ambient to -20 dB must not get LOUDER when priority speaks.
  assert.equal(ambientGainDb(-20, true), -20 + DUCK_DB);
  assert.ok(ambientGainDb(-20, true) < ambientGainDb(-20, false));
});

test('duck attack is faster than the restore', () => {
  assert.equal(duckRampMs(true), DUCK_ATTACK_MS);
  assert.equal(duckRampMs(false), DUCK_RESTORE_MS);
  assert.ok(duckRampMs(true) < duckRampMs(false), 'must duck faster than it recovers');
});

// ---------------------------------------------------------------------------
// The ambient queue
// ---------------------------------------------------------------------------

const item = (id: string, over: Partial<AmbientItem<string>> = {}): AmbientItem<string> => ({
  id,
  channel: 'STATION',
  queuedAt: 1_000,
  ttlMs: DEFAULT_TTL_MS,
  payload: id,
  ...over,
});

test('queue holds up to the cap', () => {
  const q = new AmbientQueue<string>();
  for (let i = 0; i < AMBIENT_QUEUE_CAP; i++) q.push(item(`a${i}`));
  assert.equal(q.length, AMBIENT_QUEUE_CAP);
  assert.equal(q.takeDropped().length, 0);
});

test('a fourth transmission drops the oldest, not the newest', () => {
  const q = new AmbientQueue<string>(3);
  q.push(item('first'));
  q.push(item('second'));
  q.push(item('third'));
  q.push(item('fourth'));

  assert.equal(q.length, 3);
  const dropped = q.takeDropped();
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].item.id, 'first');
  assert.equal(dropped[0].reason, 'backlog');

  // The newest survives — it is the one that still describes the situation.
  assert.deepEqual(
    q.peek().map((i) => i.id),
    ['second', 'third', 'fourth'],
  );
});

test('a stale transmission is discarded rather than spoken late', () => {
  const q = new AmbientQueue<string>();
  q.push(item('arrival', { queuedAt: 1_000, ttlMs: 30_000 }));

  assert.equal(q.take(1_000 + 30_001), null, 'expired item must not be returned');
  const dropped = q.takeDropped();
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'stale');
});

test('take skips expired items and returns the first live one', () => {
  const q = new AmbientQueue<string>();
  q.push(item('old', { queuedAt: 0, ttlMs: 10 }));
  q.push(item('alsoOld', { queuedAt: 0, ttlMs: 10 }));
  q.push(item('fresh', { queuedAt: 5_000, ttlMs: 60_000 }));

  const got = q.take(6_000);
  assert.equal(got?.id, 'fresh');
  assert.equal(q.takeDropped().length, 2);
});

test('an item exactly at its ttl is expired', () => {
  const q = new AmbientQueue<string>();
  q.push(item('edge', { queuedAt: 0, ttlMs: 100 }));
  assert.equal(q.take(100), null);
});

test('take returns null on an empty queue without throwing', () => {
  assert.equal(new AmbientQueue<string>().take(0), null);
});

test('muting one channel drops only that channel', () => {
  const q = new AmbientQueue<string>(8);
  q.push(item('s1', { channel: 'STATION' }));
  q.push(item('c1', { channel: 'CONCOURSE' }));
  q.push(item('s2', { channel: 'STATION' }));

  q.muteChannel('CONCOURSE');

  assert.deepEqual(
    q.peek().map((i) => i.id),
    ['s1', 's2'],
  );
  const dropped = q.takeDropped();
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'muted');
});

test('clear empties the queue and logs why', () => {
  const q = new AmbientQueue<string>(8);
  q.push(item('a'));
  q.push(item('b'));
  q.clear();
  assert.equal(q.length, 0);
  assert.deepEqual(
    q.takeDropped().map((d) => d.reason),
    ['cleared', 'cleared'],
  );
});

test('takeDropped drains, so the panel never reports a drop twice', () => {
  const q = new AmbientQueue<string>(1);
  q.push(item('a'));
  q.push(item('b'));
  assert.equal(q.takeDropped().length, 1);
  assert.equal(q.takeDropped().length, 0);
});

test('a cap below one is clamped rather than wedging the queue', () => {
  const q = new AmbientQueue<string>(0);
  q.push(item('only'));
  assert.equal(q.length, 1);
  assert.equal(q.take(1_000)?.id, 'only');
});
