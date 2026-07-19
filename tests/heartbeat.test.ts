import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Heartbeat } from '../src/engine/heartbeat.ts';
import type { Mission, MissionCategory, OperatorState } from '../src/engine/types.ts';

const BASE = Date.parse('2025-07-05T19:00:00Z');
const at = (min: number): string => new Date(BASE + min * 60000).toISOString();

function mission(p: Partial<Mission> & { category: MissionCategory }): Mission {
  return {
    id: 1,
    internalName: 'Mission_Test',
    title: 'Test Mission',
    reward: 100000,
    wing: false,
    expiry: at(24 * 60), // far away by default
    acceptedAt: at(0),
    steps: [],
    state: 'ACTIVE',
    redirected: false,
    killProgress: 0,
    raw: { timestamp: '', event: 'MissionAccepted' },
    destination: { system: 'RP', station: 'The Forge Of Vulcan' },
    ...p,
  };
}

function state(p: Partial<OperatorState>): OperatorState {
  return {
    now: at(0),
    location: { system: 'NJ', station: 'Caro Depot' },
    docked: true,
    activeMissions: [],
    lastActivityAt: at(0),
    ...p,
  };
}

test('idle-docked: nudges when docked at a non-destination station with hand-ins waiting', () => {
  const hb = new Heartbeat();
  const st = state({ activeMissions: [mission({ category: 'Courier' })], lastActivityAt: at(0) });

  assert.equal(hb.evaluate(st, at(3)).length, 0, 'no nudge before threshold');

  const first = hb.evaluate(st, at(6));
  assert.equal(first.length, 1);
  assert.equal(first[0].rule, 'idle-docked');
  assert.match(first[0].message, /docked at Caro Depot/);
  assert.match(first[0].message, /The Forge Of Vulcan/);

  assert.equal(hb.evaluate(st, at(7)).length, 0, 'cooldown suppresses repeat');
  assert.equal(hb.evaluate(st, at(12)).length, 1, 'fires again after cooldown');
});

test('idle-docked stays silent when the only mission is handed in here', () => {
  const hb = new Heartbeat();
  const here = mission({ category: 'Courier', destination: { system: 'NJ', station: 'Caro Depot' } });
  const st = state({ activeMissions: [here], lastActivityAt: at(0) });
  assert.equal(hb.evaluate(st, at(10)).length, 0);
});

test('stuck-hunting: nudges when idling in the assassination target system', () => {
  const hb = new Heartbeat();
  const kill = mission({
    category: 'Assassinate',
    target: { name: 'LazerFX', type: 'Known Pirate' },
    targetFaction: 'Clan of Hors',
    destination: { system: 'Bingui', station: 'Lambert Camp' },
  });
  const st = state({
    docked: false,
    location: { system: 'Bingui' },
    activeMissions: [kill],
    lastActivityAt: at(0),
  });

  assert.equal(hb.evaluate(st, at(5)).length, 0, 'below hunt threshold');
  const n = hb.evaluate(st, at(9));
  assert.equal(n.length, 1);
  assert.equal(n[0].rule, 'stuck-hunting');
  assert.match(n[0].message, /LazerFX/);
  assert.match(n[0].message, /Nav Beacon|Resource Extraction/);

  // Once a kill lands, the hunt nudge stops.
  kill.killProgress = 1;
  assert.equal(hb.evaluate(st, at(20)).some((x) => x.rule === 'stuck-hunting'), false);
});

test('expiry: warn then escalate to urgent, bypassing cooldown', () => {
  const hb = new Heartbeat();
  const m = mission({ category: 'Courier', expiry: at(28) }); // 28 min out
  const st = state({ activeMissions: [m], lastActivityAt: at(0) });

  const warn = hb.evaluate(st, at(0)).find((n) => n.rule === 'expiry');
  assert.ok(warn && warn.severity === 'warn');

  // 2 minutes later (within cooldown) but now urgent -> should still emit.
  m.expiry = at(10); // expires in 8 min at t=2
  const urgent = hb.evaluate(st, at(2)).find((n) => n.rule === 'expiry');
  assert.ok(urgent && urgent.severity === 'urgent', 'escalation bypasses cooldown');
  assert.match(urgent!.message, /URGENT/);

  // Next minute: still urgent, within cooldown, no escalation -> suppressed.
  assert.equal(hb.evaluate(st, at(3)).some((n) => n.rule === 'expiry'), false);
});

test('idle-space: nudges when drifting with no jumps and no hunt in progress', () => {
  const hb = new Heartbeat();
  const st = state({
    docked: false,
    location: { system: 'Somewhere' },
    activeMissions: [mission({ category: 'Delivery' })],
    lastActivityAt: at(0),
  });
  const n = hb.evaluate(st, at(7));
  assert.equal(n.length, 1);
  assert.equal(n[0].rule, 'idle-space');
  assert.match(n[0].message, /priority/i);
});
