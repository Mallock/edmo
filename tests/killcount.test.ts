/** Massacre kill accounting — ED's same-giver sequential stacking rule. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionStateManager } from '../src/engine/state.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

let t = 0;
const at = (): string => new Date(Date.parse('2026-07-19T10:00:00Z') + ++t * 30_000).toISOString();

function acceptMassacre(
  sm: MissionStateManager,
  id: number,
  killCount: number,
  faction = 'Tir Technology Services',
): void {
  sm.apply(
    ev({
      timestamp: at(),
      event: 'MissionAccepted',
      Faction: faction,
      Name: 'Mission_Massacre',
      LocalisedName: "Kill Brian's Thugs faction Pirates",
      TargetType_Localised: 'Pirates',
      TargetFaction: "Brian's Thugs",
      KillCount: killCount,
      DestinationSystem: 'Ratraii',
      Expiry: '2026-07-21T10:00:00Z',
      Reward: 100000 * killCount,
      MissionID: id,
    }),
  );
}

const bounty = (): JournalEvent =>
  ev({ timestamp: at(), event: 'Bounty', VictimFaction: "Brian's Thugs", TotalReward: 5000 });

const progressOf = (sm: MissionStateManager, id: number): number =>
  sm.allMissions().find((m) => m.id === id)!.killProgress;

test('same-giver massacres fill sequentially, oldest first (the 1/2/5 stack)', () => {
  const sm = new MissionStateManager();
  acceptMassacre(sm, 1, 1);
  acceptMassacre(sm, 2, 2);
  acceptMassacre(sm, 3, 5);

  sm.apply(bounty()); // kill #1 → M1 done
  assert.deepEqual([progressOf(sm, 1), progressOf(sm, 2), progressOf(sm, 3)], [1, 0, 0]);

  sm.apply(bounty()); // kill #2 → M2 1/2 (NOT M3)
  sm.apply(bounty()); // kill #3 → M2 2/2
  assert.deepEqual([progressOf(sm, 1), progressOf(sm, 2), progressOf(sm, 3)], [1, 2, 0]);

  sm.apply(bounty()); // kill #4 → M3 1/5
  assert.deepEqual([progressOf(sm, 1), progressOf(sm, 2), progressOf(sm, 3)], [1, 2, 1]);
});

test('different givers count the same kill in parallel', () => {
  const sm = new MissionStateManager();
  acceptMassacre(sm, 1, 5, 'Tir Technology Services');
  acceptMassacre(sm, 2, 5, 'Colonia Co-operative');
  sm.apply(bounty());
  assert.equal(progressOf(sm, 1), 1);
  assert.equal(progressOf(sm, 2), 1);
});

test('assassination redirect retracts the massacre tick its bounty caused', () => {
  const sm = new MissionStateManager();
  acceptMassacre(sm, 1, 5);
  sm.apply(
    ev({
      timestamp: at(),
      event: 'MissionAccepted',
      Faction: 'Colonia Co-operative',
      Name: 'Mission_Assassinate_Legal_War',
      LocalisedName: 'Assassinate Deserter: Ramtop',
      Target: 'Ramtop',
      TargetType_Localised: 'Deserter',
      TargetFaction: "Brian's Thugs",
      DestinationSystem: 'Ratraii',
      Expiry: '2026-07-21T10:00:00Z',
      Reward: 331255,
      MissionID: 9,
    }),
  );

  // The named target dies: Bounty lands first, redirect follows seconds later.
  const killTime = at();
  sm.apply(ev({ timestamp: killTime, event: 'Bounty', VictimFaction: "Brian's Thugs" }));
  assert.equal(progressOf(sm, 1), 1, 'bounty provisionally ticks the massacre');
  sm.apply(
    ev({
      timestamp: new Date(Date.parse(killTime) + 3000).toISOString(),
      event: 'MissionRedirected',
      MissionID: 9,
      NewDestinationSystem: 'Tir',
      NewDestinationStation: "Bolden's Enterprise",
    }),
  );
  assert.equal(progressOf(sm, 1), 0, 'retracted — the kill was the assassination target');
  assert.equal(progressOf(sm, 9), 1);
});

test('massacre redirect snaps progress to the full kill count', () => {
  const sm = new MissionStateManager();
  acceptMassacre(sm, 1, 2);
  sm.apply(
    ev({ timestamp: at(), event: 'MissionRedirected', MissionID: 1, NewDestinationSystem: 'Tir' }),
  );
  assert.equal(progressOf(sm, 1), 2);
});
