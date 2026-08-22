/**
 * Acts, arcs and anti-repetition.
 *
 * The CRISIS assertions are the ones that matter most: the act is defined by
 * what it removes, and a bug that lets one cheerful line about the dock league
 * through while the commander is at twenty percent hull would undo the whole
 * effect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AFTERMATH_MS,
  ActMachine,
  BUILDING_AT,
  QUIET_AT,
  RepetitionGuard,
  chooseFunction,
  nextBeatFor,
  pickBrief,
  scoreBrief,
} from '../src/engine/chatter/director.ts';
import { functionsForAct, validateScene, type Scene } from '../src/engine/chatter/scenes.ts';
import { textureBrief, type Brief } from '../src/engine/chatter/brief.ts';
import { ACTS, type DramaticFunction } from '../src/engine/chatter/types.ts';

const T = 1_000_000;

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1',
  channel: 'LOCAL',
  func: 'texture',
  turns: [
    { speakerRef: 'a', text: 'Somebody has moved the loading schedule again.' },
    { speakerRef: 'b', text: 'You are not alone in that.' },
  ],
  brief: textureBrief('subject:one'),
  ttlMs: 60_000,
  tier: 'grammar',
  ...over,
});

// ---------------------------------------------------------------------------
// The act machine
// ---------------------------------------------------------------------------

test('a fresh session starts QUIET', () => {
  assert.equal(new ActMachine().current, 'QUIET');
});

test('rising pressure enters BUILDING', () => {
  const m = new ActMachine();
  assert.equal(m.update({ nowMs: T, pressure: BUILDING_AT, inCrisis: false }), 'BUILDING');
});

test('BUILDING holds through the hysteresis band rather than flapping', () => {
  const m = new ActMachine();
  m.update({ nowMs: T, pressure: BUILDING_AT, inCrisis: false });
  // Between QUIET_AT and BUILDING_AT it must stay put — a single threshold
  // would toggle the act on every tick around the boundary.
  const mid = (QUIET_AT + BUILDING_AT) / 2;
  assert.equal(m.update({ nowMs: T + 1000, pressure: mid, inCrisis: false }), 'BUILDING');
  assert.equal(m.update({ nowMs: T + 2000, pressure: QUIET_AT - 0.01, inCrisis: false }), 'QUIET');
});

test('combat enters CRISIS from any act', () => {
  for (const start of [0, BUILDING_AT]) {
    const m = new ActMachine();
    m.update({ nowMs: T, pressure: start, inCrisis: false });
    assert.equal(m.update({ nowMs: T + 1, pressure: start, inCrisis: true }), 'CRISIS');
  }
});

test('leaving crisis enters AFTERMATH', () => {
  const m = new ActMachine();
  m.update({ nowMs: T, pressure: 0.9, inCrisis: true });
  assert.equal(m.update({ nowMs: T + 1000, pressure: 0.9, inCrisis: false }), 'AFTERMATH');
});

test('AFTERMATH holds for its window then decays', () => {
  const m = new ActMachine();
  m.update({ nowMs: T, pressure: 0.9, inCrisis: true });
  m.update({ nowMs: T + 1000, pressure: 0.9, inCrisis: false });

  assert.equal(m.update({ nowMs: T + 2000, pressure: 0, inCrisis: false }), 'AFTERMATH');
  assert.equal(
    m.update({ nowMs: T + 1000 + AFTERMATH_MS + 1, pressure: 0, inCrisis: false }),
    'QUIET',
  );
});

test('aftermath decays into BUILDING when pressure is still up', () => {
  const m = new ActMachine();
  m.update({ nowMs: T, pressure: 0.9, inCrisis: true });
  m.update({ nowMs: T + 1000, pressure: 0.9, inCrisis: false });
  assert.equal(
    m.update({ nowMs: T + 1000 + AFTERMATH_MS + 1, pressure: 0.9, inCrisis: false }),
    'BUILDING',
  );
});

test('a resolved combat streak can trigger AFTERMATH directly', () => {
  const m = new ActMachine();
  assert.equal(
    m.update({ nowMs: T, pressure: 0.1, inCrisis: false, crisisResolvedAt: T - 100 }),
    'AFTERMATH',
  );
});

test('transitions are observable', () => {
  const m = new ActMachine();
  m.update({ nowMs: T, pressure: 0.9, inCrisis: true });
  m.update({ nowMs: T + 1, pressure: 0.9, inCrisis: false });
  const log = m.drainTransitions();
  assert.deepEqual(
    log.map((t) => `${t.from}->${t.to}`),
    ['QUIET->CRISIS', 'CRISIS->AFTERMATH'],
  );
  assert.deepEqual(m.drainTransitions(), [], 'draining must clear');
});

test('staying in an act records no transition', () => {
  const m = new ActMachine();
  m.update({ nowMs: T, pressure: 0, inCrisis: false });
  m.update({ nowMs: T + 1, pressure: 0, inCrisis: false });
  assert.deepEqual(m.drainTransitions(), []);
});

// ---------------------------------------------------------------------------
// Silence as an instrument
// ---------------------------------------------------------------------------

test('CRISIS allows no dramatic function at all', () => {
  assert.deepEqual(functionsForAct('CRISIS'), []);
});

test('no function means no scene can be chosen in CRISIS', () => {
  assert.equal(chooseFunction('CRISIS', [], () => 0.5), null);
  assert.equal(
    chooseFunction('CRISIS', [{ id: 'a', beats: [{ func: 'establish' }] }], () => 0.1),
    null,
  );
});

test('every other act can still produce something', () => {
  for (const act of ACTS) {
    if (act === 'CRISIS') continue;
    assert.ok(chooseFunction(act, [], () => 0.9), `${act} produced nothing`);
  }
});

test('BUILDING drops idle texture — that absence is the tell', () => {
  assert.ok(!functionsForAct('BUILDING').includes('texture'));
  assert.ok(functionsForAct('QUIET').includes('texture'));
});

test('aftermath beats are only allowed after something happened', () => {
  assert.ok(functionsForAct('AFTERMATH').includes('aftermath'));
  for (const act of ['QUIET', 'BUILDING'] as const) {
    assert.ok(!functionsForAct(act).includes('aftermath'), `${act} should not allow aftermath`);
  }
});

// ---------------------------------------------------------------------------
// Arcs
// ---------------------------------------------------------------------------

test('a thread starts by establishing', () => {
  assert.equal(nextBeatFor([]), 'establish');
});

test('an established thread gets complicated', () => {
  assert.equal(nextBeatFor(['establish']), 'complicate');
});

test('a thread that has been complicated twice must turn', () => {
  assert.equal(nextBeatFor(['establish', 'complicate', 'complicate']), 'reverse');
});

test('an open arc is often continued rather than starting fresh', () => {
  const arcs = [{ id: 'arc1', beats: [{ func: 'establish' as DramaticFunction }] }];
  let continued = 0;
  for (let i = 0; i < 100; i++) {
    const r = chooseFunction('BUILDING', arcs, () => (i % 100) / 100);
    if (r?.arcId === 'arc1') continued += 1;
  }
  assert.ok(continued > 20, `arcs were continued only ${continued}/100 times`);
});

test('an arc is not continued into a beat the act forbids', () => {
  // QUIET allows only texture and establish. An arc wanting 'complicate'
  // must not drag a forbidden beat into a quiet stretch.
  const arcs = [{ id: 'arc1', beats: [{ func: 'establish' as DramaticFunction }] }];
  for (let i = 0; i < 50; i++) {
    const r = chooseFunction('QUIET', arcs, () => i / 50);
    assert.ok(r);
    assert.ok(functionsForAct('QUIET').includes(r.func), `${r.func} is not allowed in QUIET`);
  }
});

// ---------------------------------------------------------------------------
// Anti-repetition
// ---------------------------------------------------------------------------

test('a fresh scene passes', () => {
  assert.equal(new RepetitionGuard().check(scene()), null);
});

test('a near-duplicate of a recent scene is rejected', () => {
  const g = new RepetitionGuard();
  g.remember(scene());
  assert.equal(g.check(scene()), 'near-duplicate');
});

test('the same subject twice in a row on a channel is rejected', () => {
  const g = new RepetitionGuard();
  g.remember(scene({ brief: textureBrief('price:bertrandite') }));
  const next = scene({
    id: 's2',
    brief: textureBrief('price:bertrandite'),
    turns: [
      { speakerRef: 'a', text: 'Completely different wording about that commodity.' },
      { speakerRef: 'b', text: 'Nothing whatsoever alike phrasing here friend.' },
    ],
  });
  assert.equal(g.check(next), 'same-subject');
});

test('the same subject on a DIFFERENT channel is allowed', () => {
  const g = new RepetitionGuard();
  g.remember(scene({ channel: 'LOCAL', brief: textureBrief('price:bertrandite') }));
  const other = scene({
    id: 's2',
    channel: 'CONCOURSE',
    brief: textureBrief('price:bertrandite'),
    turns: [{ speakerRef: 'pa', text: 'Trader advisory, pricing revised on the concourse.' }],
  });
  assert.equal(g.check(other), null);
});

test('subject heat decays as other subjects are used', () => {
  const g = new RepetitionGuard();
  g.remember(scene({ brief: textureBrief('hot') }));
  const hotNow = g.subjectHeat('LOCAL', 'hot');
  for (let i = 0; i < 5; i++) {
    g.remember(scene({ id: `x${i}`, brief: textureBrief(`other${i}`) }));
  }
  assert.ok(g.subjectHeat('LOCAL', 'hot') < hotNow, 'heat should fall as it recedes');
  assert.equal(g.subjectHeat('LOCAL', 'never-used'), 0);
});

test('the repetition ring survives a restart', () => {
  const a = new RepetitionGuard();
  a.remember(scene());
  const b = new RepetitionGuard();
  b.load(JSON.parse(JSON.stringify(a.toJSON())));
  assert.equal(b.check(scene()), 'near-duplicate', 'anti-repetition must persist');
});

test('loading garbage into the guard is survivable', () => {
  const g = new RepetitionGuard();
  assert.doesNotThrow(() => g.load(null));
  assert.doesNotThrow(() => g.load({ texts: 'nope' }));
  assert.equal(g.check(scene()), null);
});

// ---------------------------------------------------------------------------
// Choosing what to talk about
// ---------------------------------------------------------------------------

const b = (kind: Brief['kind'], subjectKey: string, ageMs?: number): Brief => ({
  ...textureBrief(subjectKey),
  kind,
  ageMs,
});

test('a repeated subject scores below a duller fresh one', () => {
  const g = new RepetitionGuard();
  g.remember(scene({ brief: b('market', 'price:hot') }));
  const hot = scoreBrief(b('market', 'price:hot'), 'LOCAL', g);
  const cold = scoreBrief(b('faction', 'faction:cold'), 'LOCAL', g);
  assert.ok(cold > hot, 'a fresh dull subject should beat a worn-out interesting one');
});

test('events outrank atmosphere', () => {
  const g = new RepetitionGuard();
  assert.ok(scoreBrief(b('event', 'e'), 'LOCAL', g) > scoreBrief(b('texture', 't'), 'LOCAL', g));
});

test('older observations score lower, but not decisively', () => {
  const g = new RepetitionGuard();
  const fresh = scoreBrief(b('market', 'a', 0), 'LOCAL', g);
  const old = scoreBrief(b('market', 'a', 24 * 3_600_000), 'LOCAL', g);
  assert.ok(old < fresh);
  assert.ok(old > scoreBrief(b('texture', 'z'), 'LOCAL', g), 'a day-old price still beats filler');
});

test('pickBrief returns the best available and null on none', () => {
  const g = new RepetitionGuard();
  const chosen = pickBrief([b('texture', 't'), b('event', 'e')], 'LOCAL', g);
  assert.equal(chosen?.subjectKey, 'e');
  assert.equal(pickBrief([], 'LOCAL', g), null);
});

// ---------------------------------------------------------------------------
// Structural validity
// ---------------------------------------------------------------------------

test('a well-formed scene validates', () => {
  assert.equal(validateScene(scene()), null);
});

test('a scene with a leftover token never validates', () => {
  const bad = scene({ turns: [{ speakerRef: 'a', text: 'Welcome to <station>.' }] });
  assert.equal(validateScene(bad), 'unbound-token');
});

test('a multi-turn scene with one speaker is invalid', () => {
  const bad = scene({
    turns: [
      { speakerRef: 'a', text: 'One.' },
      { speakerRef: 'a', text: 'Two.' },
    ],
  });
  assert.equal(validateScene(bad), 'one-speaker-many-turns');
});

test('empty and oversized scenes are invalid', () => {
  assert.equal(validateScene(scene({ turns: [] })), 'no-turns');
  assert.equal(
    validateScene(scene({ turns: [{ speakerRef: 'a', text: '  ' }] })),
    'empty-turn',
  );
  assert.equal(
    validateScene(
      scene({
        turns: Array.from({ length: 5 }, (_, i) => ({ speakerRef: `s${i}`, text: `t${i}` })),
      }),
    ),
    'too-many-turns',
  );
});
