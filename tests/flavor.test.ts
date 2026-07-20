/** Flavor generator — story planning, prompts, and the offline templates. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFlavorChat,
  mulberry32,
  planStory,
  ruleBasedFlavor,
} from '../src/engine/flavor.ts';
import type { Mission, OperatorState } from '../src/engine/types.ts';

function mission(id: number, over: Partial<Mission> = {}): Mission {
  return {
    id,
    internalName: 'Mission_Assassinate',
    title: `Contract ${id}`,
    category: 'Assassinate',
    reward: 250000,
    wing: false,
    expiry: '2026-07-20T10:00:00Z',
    acceptedAt: '2026-07-19T09:00:00Z',
    steps: [],
    state: 'ACTIVE',
    redirected: false,
    killProgress: 0,
    raw: { timestamp: '', event: 'MissionAccepted' },
    destination: { system: 'Ratraii', station: 'Exodus Reach' },
    target: { name: 'Ramtop', type: 'Deserter' },
    faction: 'Colonia Co-operative',
    targetFaction: "Brian's Thugs",
    ...over,
  };
}

const STATE: OperatorState = {
  now: '2026-07-19T10:00:00Z',
  location: { system: 'Ratraii' },
  docked: false,
  activeMissions: [],
  lastActivityAt: '2026-07-19T09:00:00Z',
};

test('mulberry32 is deterministic per seed', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test('planStory: focus mission wins; combos need 2+ missions', () => {
  const rng = mulberry32(7);
  const m1 = mission(1);
  const focus = planStory([m1, mission(2)], rng, m1);
  assert.equal(focus?.subjects.length, 1);
  assert.equal(focus?.subjects[0].id, 1);

  assert.equal(planStory([], rng), null);

  const combo = planStory([m1, mission(2), mission(3)], () => 0);
  assert.ok(combo && combo.subjects.length >= 2, 'rng 0 forces the combo branch');
});

test('buildFlavorChat grounds the prompt in mission facts + angle', () => {
  const plan = planStory([mission(1)], mulberry32(1))!;
  const msgs = buildFlavorChat(plan, STATE);
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /Never give instructions/);
  assert.match(msgs[1].content, /Contract 1/);
  assert.match(msgs[1].content, /Ramtop/);
  assert.match(msgs[1].content, /Angle: /);
});

test('offline templates: kill story names the target, no empty output', () => {
  // rng 0 selects the first kill template, which names the target.
  const text = ruleBasedFlavor([mission(1)], STATE, () => 0);
  assert.ok(text && text.length > 40);
  assert.match(text!, /Ramtop/);
});

test('buildFlavorChat avoid-ring lists recent stories; string still accepted', () => {
  const plan = planStory([mission(1)], mulberry32(1))!;
  const ring = ['The dockhands at Berman Market are jumpy.', 'Word is the Council pays double.', 'Pad three again, commander.'];
  const msgs = buildFlavorChat(plan, STATE, [], ring);
  assert.match(msgs[1].content, /Your recent stories were:/);
  assert.match(msgs[1].content, /1\. "The dockhands/);
  assert.match(msgs[1].content, /3\. "Pad three/);
  assert.match(msgs[1].content, /do not repeat these themes/);
  // Back-compat: a single string still produces the block.
  const single = buildFlavorChat(plan, STATE, [], 'One old story.');
  assert.match(single[1].content, /1\. "One old story\."/);
  // No avoid → no block.
  const none = buildFlavorChat(plan, STATE, []);
  assert.doesNotMatch(none[1].content, /Your recent stories/);
});

test('offline combo weaves two mission titles together', () => {
  const text = ruleBasedFlavor([mission(1), mission(2)], STATE, () => 0);
  assert.ok(text);
  assert.match(text!, /Contract 1/);
  assert.match(text!, /Contract 2/);
});

test('every category produces a story', () => {
  const cats = ['Courier', 'Delivery', 'PassengerBulk', 'Mining', 'Other'] as const;
  for (const category of cats) {
    const m = mission(9, { category, internalName: `Mission_${category}`, target: undefined });
    const text = ruleBasedFlavor([m], STATE, mulberry32(3));
    assert.ok(text && text.length > 20, `no story for ${category}`);
  }
});
