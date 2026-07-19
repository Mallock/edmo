import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeSteps } from '../src/engine/steps.ts';
import type { Mission, MissionCategory } from '../src/engine/types.ts';

function mission(partial: Partial<Mission> & { category: MissionCategory }): Mission {
  return {
    id: 1,
    internalName: 'Mission_Test',
    title: 'Test',
    reward: 1000,
    wing: false,
    expiry: null,
    acceptedAt: '2025-07-05T18:00:00Z',
    steps: [],
    state: 'ACTIVE',
    redirected: false,
    killProgress: 0,
    raw: { timestamp: '', event: 'MissionAccepted' },
    destination: { system: 'Sol', station: 'Abraham Lincoln' },
    ...partial,
  };
}

test('courier: travel step flips done when in the destination system', () => {
  const m = mission({ category: 'Courier' });
  const before = synthesizeSteps(m);
  assert.equal(before[0].done, false);
  const after = synthesizeSteps(m, { system: 'Sol', station: 'Abraham Lincoln' });
  assert.equal(after[0].done, true); // arrived
  assert.equal(after[1].done, false); // hand-in only true on completion
});

test('passenger: boarding is done at accept; drop-off waits for completion', () => {
  const m = mission({
    category: 'PassengerVIP',
    passengers: { count: 4, type: 'Tourist', vip: true, wanted: false },
  });
  const steps = synthesizeSteps(m);
  assert.match(steps[0].label, /Board 4 Tourist/);
  assert.equal(steps[0].done, true);
  assert.equal(steps[2].done, false);
});

test('assassinate before redirect shows a placeholder hand-in step', () => {
  const m = mission({
    category: 'Assassinate',
    target: { name: 'LazerFX', type: 'Known Pirate' },
  });
  const steps = synthesizeSteps(m);
  assert.match(steps[1].label, /Eliminate LazerFX/);
  assert.equal(steps.length, 3);
  assert.match(steps[2].label, /after the kill/i);
});

test('completed mission marks every step done', () => {
  const m = mission({ category: 'Delivery', state: 'COMPLETE', commodity: { name: 'x', localised: 'Liquor', count: 36 } });
  const steps = synthesizeSteps(m);
  assert.ok(steps.every((s) => s.done));
});
