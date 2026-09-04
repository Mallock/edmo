/**
 * The `Passengers` journal event → the carried manifest.
 *
 * The event is written at login while passengers are aboard, splits one
 * mission across several cabin rows, and is the ONLY source that says who is
 * in the cabins after a restart — `MissionAccepted` does not replay, and the
 * `Missions` snapshot names missions without their passenger blocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionStateManager } from '../src/engine/state.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

let t = 0;
const at = (): string => new Date(Date.parse('2026-08-30T10:00:00Z') + ++t * 30_000).toISOString();

interface Row {
  MissionID: number;
  Type?: string;
  VIP?: boolean;
  Wanted?: boolean;
  Count: number;
}

const passengers = (rows: Row[]): JournalEvent =>
  ev({ timestamp: at(), event: 'Passengers', Manifest: rows });

function acceptBulk(sm: MissionStateManager, id: number, count: number): void {
  sm.apply(
    ev({
      timestamp: at(),
      event: 'MissionAccepted',
      Faction: 'Explorer on Tour',
      Name: 'Mission_PassengerBulk',
      LocalisedName: `${count} Tourists Seeking Transport`,
      DestinationSystem: 'HIP 71120',
      DestinationStation: "Wood's Pride",
      Expiry: '2026-08-31T10:00:00Z',
      Reward: 1_837_840,
      PassengerCount: count,
      PassengerVIPs: false,
      PassengerWanted: false,
      PassengerType: 'Tourist',
      MissionID: id,
    }),
  );
}

test('a single manifest row is recorded as one entry', () => {
  const sm = new MissionStateManager();
  sm.apply(passengers([{ MissionID: 1020733231, Type: 'Tourist', VIP: true, Wanted: false, Count: 9 }]));
  const carried = sm.getState().carriedPassengers;
  assert.equal(carried.length, 1);
  assert.deepEqual(carried[0], {
    missionId: 1020733231,
    count: 9,
    type: 'Tourist',
    vip: true,
    wanted: false,
  });
});

test('split cabin rows for one mission are summed', () => {
  const sm = new MissionStateManager();
  sm.apply(
    passengers([
      { MissionID: 1057669242, Type: 'Tourist', Count: 48 },
      { MissionID: 1057668922, Type: 'Tourist', Count: 28 },
      { MissionID: 1057669242, Type: 'Tourist', Count: 31 },
    ]),
  );
  const carried = sm.getState().carriedPassengers;
  assert.equal(carried.length, 2);
  assert.equal(carried.find((e) => e.missionId === 1057669242)?.count, 79);
  assert.equal(carried.find((e) => e.missionId === 1057668922)?.count, 28);
});

test('a later manifest replaces the earlier one wholesale', () => {
  const sm = new MissionStateManager();
  sm.apply(passengers([{ MissionID: 1, Type: 'Tourist', Count: 16 }]));
  sm.apply(passengers([{ MissionID: 2, Type: 'Refugee', Count: 4 }]));
  const carried = sm.getState().carriedPassengers;
  assert.equal(carried.length, 1);
  assert.equal(carried[0].missionId, 2);
  assert.equal(carried[0].type, 'Refugee');
});

test('restart: manifest detail lands on a Missions-snapshot mission', () => {
  const sm = new MissionStateManager();
  // The login snapshot knows the mission's id and internal name — nothing else.
  sm.apply(
    ev({
      timestamp: at(),
      event: 'Missions',
      Active: [{ MissionID: 1057668922, Name: 'Mission_PassengerBulk', Expires: 86_400 }],
      Failed: [],
      Complete: [],
    }),
  );
  sm.apply(passengers([{ MissionID: 1057668922, Type: 'Tourist', VIP: false, Wanted: false, Count: 28 }]));
  const m = sm.activeMissions().find((x) => x.id === 1057668922)!;
  assert.deepEqual(m.passengers, { count: 28, type: 'Tourist', vip: false, wanted: false });
});

test('MissionAccepted stays authoritative over the manifest', () => {
  const sm = new MissionStateManager();
  acceptBulk(sm, 42, 80);
  const before = sm.activeMissions()[0].passengers;
  sm.apply(passengers([{ MissionID: 42, Type: 'Tourist', Count: 80 }]));
  const after = sm.activeMissions()[0].passengers;
  assert.equal(after, before); // same object — not rebuilt from the manifest
});

test('a row for an unknown mission stays in the manifest but decorates nothing', () => {
  const sm = new MissionStateManager();
  sm.apply(passengers([{ MissionID: 999, Type: 'Tourist', Count: 6 }]));
  assert.equal(sm.getState().carriedPassengers.length, 1);
  assert.equal(sm.activeMissions().length, 0);
});

test('terminal mission events empty the cabins', () => {
  for (const event of ['MissionCompleted', 'MissionFailed', 'MissionAbandoned']) {
    const sm = new MissionStateManager();
    acceptBulk(sm, 7, 80);
    sm.apply(passengers([{ MissionID: 7, Type: 'Tourist', Count: 80 }]));
    assert.equal(sm.getState().carriedPassengers.length, 1);
    sm.apply(ev({ timestamp: at(), event, MissionID: 7 }));
    assert.equal(sm.getState().carriedPassengers.length, 0, `${event} should clear the manifest`);
  }
});

test('completion clears the manifest even for a mission never seen accepted', () => {
  const sm = new MissionStateManager();
  sm.apply(passengers([{ MissionID: 500, Type: 'Tourist', Count: 12 }]));
  sm.apply(ev({ timestamp: at(), event: 'MissionCompleted', MissionID: 500 }));
  assert.equal(sm.getState().carriedPassengers.length, 0);
});

test('replaying the same events reconstructs an identical manifest', () => {
  const events = [
    passengers([
      { MissionID: 1, Type: 'Tourist', Count: 20 },
      { MissionID: 1, Type: 'Tourist', Count: 15 },
      { MissionID: 2, Type: 'Refugee', Wanted: true, Count: 4 },
    ]),
  ];
  const run = (): unknown => {
    const sm = new MissionStateManager();
    for (const e of events) sm.apply(e);
    return sm.getState().carriedPassengers;
  };
  assert.deepEqual(run(), run());
});
