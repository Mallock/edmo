/** Lively acceptance briefings — template layer + LLM prompt + name capture. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionStateManager } from '../src/engine/state.ts';
import { buildBriefingChat, livelyBriefing } from '../src/engine/operator.ts';
import { mulberry32 } from '../src/engine/flavor.ts';
import type { JournalEvent, Mission, MissionCategory } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

function mission(category: MissionCategory, over: Partial<Mission> = {}): Mission {
  return {
    id: 1,
    internalName: `Mission_${category}`,
    title: '80 Aid Workers Seeking Transport',
    category,
    reward: 2_553_040,
    wing: false,
    expiry: '2026-07-19T13:15:00Z',
    acceptedAt: '2026-07-19T09:50:00Z',
    steps: [],
    state: 'ACTIVE',
    redirected: false,
    killProgress: 0,
    raw: { timestamp: '', event: 'MissionAccepted' },
    destination: { system: 'Kojeara', station: "TolaGarf's Junkyard" },
    passengers: { count: 80, type: 'AidWorker', vip: false, wanted: false },
    ...over,
  };
}

test('lively briefings stay factual across categories and use the name', () => {
  const now = '2026-07-19T09:52:00Z';
  const cats: MissionCategory[] = [
    'PassengerBulk',
    'PassengerVIP',
    'Courier',
    'Delivery',
    'Mining',
    'Assassinate',
    'Massacre',
    'Other',
  ];
  for (const cat of cats) {
    const text = livelyBriefing(mission(cat), now, "M'Allock", mulberry32(3));
    assert.ok(text.length > 40, `${cat} briefing too short`);
    assert.match(text, /2,553,040 cr/, `${cat} briefing must state the pay`);
    assert.doesNotMatch(text, /undefined|\{|\}/, `${cat} briefing has holes`);
  }
  // Tight timer surfaces; name lands in at least the bulk-passenger variant.
  const bulk = livelyBriefing(mission('PassengerBulk'), now, "M'Allock", () => 0);
  assert.match(bulk, /M'Allock/);
  assert.match(bulk, /Timer's tight/);
  assert.match(bulk, /Kojeara|TolaGarf/);
});

test('VIP gift commodity rides into the briefing', () => {
  const vip = mission('PassengerVIP', {
    commodity: { name: '$Clothing_Name;', localised: 'Clothing', count: 1 },
  });
  const text = livelyBriefing(vip, '2026-07-19T09:52:00Z', undefined, () => 0);
  assert.match(text, /1 Clothing/);
});

test('buildBriefingChat carries persona, name and mission facts', () => {
  const sm = new MissionStateManager();
  sm.apply(ev({ timestamp: '2026-07-19T09:00:00Z', event: 'LoadGame', Commander: "M'Allock", Credits: 1 }));
  const st = { ...sm.getState(), activeMissions: [mission('PassengerBulk')], now: '2026-07-19T09:52:00Z' };
  const chat = buildBriefingChat(st.activeMissions[0], st);
  assert.match(chat[0].content, /Commander M'Allock/);
  assert.match(chat[0].content, /two to three spoken sentences/i);
  assert.match(chat[1].content, /80 AidWorker/);
  assert.match(chat[1].content, /Kojeara/);
});

test('commander name folds from LoadGame and Commander events', () => {
  const sm = new MissionStateManager();
  sm.apply(ev({ timestamp: '2026-07-19T09:00:00Z', event: 'Commander', Name: "M'Allock" }));
  assert.equal(sm.getState().cmdr, "M'Allock");
});
