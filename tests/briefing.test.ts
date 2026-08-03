/** Lively acceptance briefings — template layer + LLM prompt + name capture. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionStateManager } from '../src/engine/state.ts';
import { buildBriefingChat, buildChat, idleAskSystem, livelyBriefing, systemPromptFor } from '../src/engine/operator.ts';
import { askPersona } from '../src/engine/lore.ts';
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
// --- the operator is one person ---------------------------------------------
// A live sweep against the bundled model caught this path saying "we have a
// transport run for six passengers" — the operator climbing into a cockpit it
// is not in, which is the exact voice rule the ambient copilot is held to.
// Both paths now share it.

test('no briefing path ever speaks in the first person plural', () => {
  const now = '2026-07-19T09:52:00Z';
  const cats: MissionCategory[] = [
    'PassengerBulk', 'PassengerVIP', 'Courier', 'Delivery',
    'Mining', 'Assassinate', 'Massacre', 'Other',
  ];
  const banned = /\b(we|we're|we've|our|ours|us|let's)\b/i;
  for (const cat of cats) {
    // Every template variant, not a lucky seed.
    for (let seed = 0; seed < 24; seed++) {
      const line = livelyBriefing(mission(cat), now, "M'Allock", mulberry32(seed));
      assert.doesNotMatch(line, banned, `${cat} seed ${seed}: ${line}`);
    }
  }
  const sys = buildBriefingChat(mission('PassengerVIP'), {
    ...new MissionStateManager().getState(),
    activeMissions: [mission('PassengerVIP')],
    now,
  }).map((m) => m.content).join(' ');
  assert.match(sys, /NEVER "we", "our" or "us"/);
  assert.match(sys, /They fly the ship; you run the comms/);
});

test('a briefing hears the session, so a repeat run is not introduced cold', () => {
  const st = {
    ...new MissionStateManager().getState(),
    activeMissions: [mission('Courier')],
    now: '2026-07-19T09:52:00Z',
  };
  const msgs = buildBriefingChat(st.activeMissions[0], st, [
    'EVENT: Mission complete: Expansion Data Couriering. 195,681 cr paid.',
    'EVENT: FSD jump to HIP 71120.',
  ]);
  assert.match(msgs[1].content, /already happened this session/);
  assert.match(msgs[1].content, /195,681 cr paid/);
  assert.doesNotMatch(msgs[1].content, /- EVENT:/); // prefix stripped for reading
  assert.match(msgs[0].content, /echoes the session so far/);
});

test('a briefing with no session yet reads exactly as it always did', () => {
  const st = {
    ...new MissionStateManager().getState(),
    activeMissions: [mission('Courier')],
    now: '2026-07-19T09:52:00Z',
  };
  assert.doesNotMatch(buildBriefingChat(st.activeMissions[0], st)[1].content, /already happened this session/);
});

// --- the ask path knows who it is talking to ---------------------------------
// Reported live: GLM greeted the commander by name and gemma did not. The cause
// was neither model — the copilot's system prompt has always said "Commander
// <name>", but the ask path only received it as a parenthetical context line
// among market data, so "hello" got a docking report. With the name in the
// persona, both models greet: gemma 5/5, GLM 4/5, up from 1/5 each.

test('the ask persona introduces the commander by name', () => {
  const named = askPersona('Hadfield');
  assert.match(named, /You are Commander Hadfield's Mission Operator/);
  assert.match(named, /Their name is Hadfield; use it the way an old colleague does/);
  // Naturally, not as a tic — every line opening "Hadfield," reads like a bot.
  assert.match(named, /naturally, not in every line/);
  // No name known: no dangling instruction about one.
  const anon = askPersona();
  assert.match(anon, /You are the commander's Mission Operator/);
  assert.doesNotMatch(anon, /Their name is/);
});

test('a greeting is answered socially, not with telemetry', () => {
  const p = askPersona('Hadfield');
  assert.match(p, /"hello", "how are you", "still there\?"/);
  assert.match(p, /greet them back/);
  assert.match(p, /leave the telemetry alone unless they ask for it/);
  // GLM ended three of five replies on "What's next?" — a rhetorical close the
  // prompt already banned in spirit, now in letter.
  assert.match(p, /never end on a bare "What's next\?"/);
});

test('both ask prompts carry the name through to the model', () => {
  assert.match(idleAskSystem('Hadfield'), /Commander Hadfield/);
  assert.match(String(systemPromptFor('Courier', 'Hadfield').content), /Commander Hadfield/);
  // ...and still work anonymously.
  assert.match(idleAskSystem(), /the commander's Mission Operator/);
  assert.match(String(systemPromptFor('Courier').content), /the commander's Mission Operator/);
});

test('buildChat threads the commander name from live state', () => {
  const st = {
    ...new MissionStateManager().getState(),
    activeMissions: [mission('Courier')],
    now: '2026-07-19T09:52:00Z',
    cmdr: 'Hadfield',
  };
  assert.match(String(buildChat(st.activeMissions[0], st, 'hello')[0].content), /Commander Hadfield/);
});
