/**
 * The oracle commands — routing and seeding contracts.
 *
 * The phrase must LEAD the ask (a question that merely mentions a threat is a
 * question), `reveal` must seed from real facts and carry its licence,
 * `advance` narrates from the thread it just escalated (or honestly says
 * nothing is close), and `flashback` seeds ONLY from real chronicle entries —
 * an empty log must never grow a fabricated episode in the prompt. The clock
 * mechanics behind `advance` (one segment, capped at 5/6, no-op with nothing
 * elected) are pinned in campaign.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oracleCommandOf, planOracle } from '../src/engine/oracle.ts';
import type { SpineThread } from '../src/engine/campaign.ts';

// ------------------------------------------------------------------ routing

test('the three phrases route, ordinary questions do not', () => {
  assert.equal(oracleCommandOf('reveal a detail'), 'reveal');
  assert.equal(oracleCommandOf('Reveal a detail about this place'), 'reveal');
  assert.equal(oracleCommandOf('advance a threat'), 'advance');
  assert.equal(oracleCommandOf('flashback'), 'flashback');
  assert.equal(oracleCommandOf('  FLASHBACK  '), 'flashback');
  assert.equal(oracleCommandOf('what should I do right now?'), null);
  assert.equal(oracleCommandOf('is there a threat nearby?'), null);
  assert.equal(oracleCommandOf('can you reveal a detail?'), null);
  assert.equal(oracleCommandOf('tell me about the flashback scene'), null);
});

// ------------------------------------------------------------------- reveal

test('reveal seeds from the real dossier and carries its licence', () => {
  const plan = planOracle('reveal', { dossier: 'SYSTEM: T — High Tech economy.' });
  const all = plan.knowledge.join('\n');
  assert.match(all, /SYSTEM: T — High Tech economy\./);
  assert.match(all, /ORACLE'S SEED/);
  assert.match(all, /real fragment/i);
  assert.notEqual(plan.question, 'reveal a detail');
});

test('reveal with no intel still plans, just without a seed block', () => {
  const plan = planOracle('reveal', { dossier: null });
  assert.ok(!plan.knowledge.join('\n').includes("ORACLE'S SEED"));
  assert.ok(plan.knowledge.length > 0); // the licence still rides
});

// ------------------------------------------------------------------ advance

const thread = (over: Partial<SpineThread> = {}): SpineThread => ({
  role: 'pursuer',
  faction: 'Sirius Corp',
  clock: 4,
  clockMovedAt: '2026-08-01T12:00:00Z',
  cooldownUntil: '',
  beats: [{ at: '2026-08-01T12:00:00Z', text: 'interdicted by Kowalczyk — submitted' }],
  onAir: [],
  electedAt: '2026-08-01T11:00:00Z',
  ...over,
});

test('advance narrates from the escalated thread', () => {
  const plan = planOracle('advance', { thread: thread() });
  const all = plan.knowledge.join('\n');
  assert.match(all, /Sirius Corp/);
  assert.match(all, /4 of 6/);
  assert.match(all, /interdicted by Kowalczyk/);
  assert.match(plan.question, /Sirius Corp/);
});

test('advance with nothing elected asks for an honest all-clear, no state implied', () => {
  const plan = planOracle('advance', { thread: null });
  assert.deepEqual(plan.knowledge, []);
  assert.ok(!/Sirius|faction/i.test(plan.question));
});

// ---------------------------------------------------------------- flashback

test('flashback seeds from a real chronicle entry, rotated', () => {
  const episodes = [
    { n: 1, day: 'Day 1', text: 'The rings gave up their first ton.' },
    { n: 2, day: 'Day 2', text: 'A pirate found the wrong hauler.' },
  ];
  const p0 = planOracle('flashback', { episodes, rotate: 0 });
  const p1 = planOracle('flashback', { episodes, rotate: 1 });
  assert.match(p0.knowledge.join('\n'), /episode 1.*Day 1/s);
  assert.match(p0.knowledge.join('\n'), /rings gave up/);
  assert.match(p1.knowledge.join('\n'), /episode 2/);
});

test('an empty chronicle never grows a fabricated episode', () => {
  const plan = planOracle('flashback', { episodes: [] });
  assert.deepEqual(plan.knowledge, []);
  assert.ok(!/episode \d/i.test(plan.question));
});
