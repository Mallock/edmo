/** The Saga — beat extraction, episode prompts, recap fallback. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SagaTracker, beatRecap, buildEpisodeChat } from '../src/engine/saga.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

function loadedTracker(): SagaTracker {
  const s = new SagaTracker();
  s.apply(ev({ timestamp: '2026-07-19T08:00:00Z', event: 'LoadGame', Commander: "M'Allock", ShipName: 'Grasshopper', Ship: 'mediumtransport01' }));
  s.apply(
    ev({
      timestamp: '2026-07-19T08:05:00Z',
      event: 'MissionAccepted',
      Faction: 'Ukraine Colonist Alliance',
      LocalisedName: '80 Aid Workers Seeking Transport',
      PassengerCount: 80,
      PassengerType: 'AidWorker',
      DestinationSystem: 'Kojeara',
      DestinationStation: "TolaGarf's Junkyard",
      Reward: 2553040,
      MissionID: 1,
    }),
  );
  s.apply(ev({ timestamp: '2026-07-19T08:20:00Z', event: 'Bounty', VictimFaction: "Brian's Thugs", TotalReward: 50000 }));
  s.apply(ev({ timestamp: '2026-07-19T08:22:00Z', event: 'Bounty', VictimFaction: "Brian's Thugs", TotalReward: 70000 }));
  s.apply(ev({ timestamp: '2026-07-19T08:30:00Z', event: 'Docked', StationName: "Bolden's Enterprise", StarSystem: 'Tir' }));
  s.apply(ev({ timestamp: '2026-07-19T08:31:00Z', event: 'MissionCompleted', LocalisedName: 'Kill pirates', Reward: 87501 }));
  return s;
}

test('beats capture accepts, aggregated bounties, dockings and hand-ins', () => {
  const s = loadedTracker();
  assert.equal(s.cmdr, "M'Allock");
  assert.match(s.ship, /Grasshopper/);
  const day = s.beatsForDay('2026-07-19');
  const texts = day.map((b) => b.text).join(' | ');
  assert.match(texts, /80 AidWorker/);
  assert.match(texts, /Destroyed 2 ship\(s\) of Brian's Thugs — bounties worth 120,000 cr/);
  assert.match(texts, /Docked at Bolden's Enterprise/);
  assert.match(texts, /paid 87,501 cr/);
  assert.equal(s.latestDay(), '2026-07-19');
});

test('ship changes become beats; re-stating the same ship does not', () => {
  const s = loadedTracker(); // logged in flying Grasshopper
  // Same ship re-stated (fresh Loadout after outfitting) — no beat.
  s.apply(ev({ timestamp: '2026-07-19T09:00:00Z', event: 'Loadout', ShipName: 'Grasshopper', Ship: 'mediumtransport01' }));
  // Swapping to the hauler IS a beat — multi-ship days must stay attributable.
  s.apply(ev({ timestamp: '2026-07-19T09:05:00Z', event: 'Loadout', ShipName: 'rahtari', Ship: 'type8' }));
  const texts = s.beatsForDay('2026-07-19').map((b) => b.text).join(' | ');
  assert.match(texts, /Took the helm of the rahtari \(type8\)/);
  assert.equal((texts.match(/Took the helm/g) ?? []).length, 1);
  assert.match(s.ship, /rahtari/);
});

test('failures and dramatic comms become beats; drama fires once per kind', () => {
  const s = loadedTracker();
  s.apply(ev({ timestamp: '2026-07-19T09:00:00Z', event: 'MissionFailed', LocalisedName: 'Late delivery', MissionID: 5 }));
  s.apply(
    ev({
      timestamp: '2026-07-19T09:01:00Z',
      event: 'ReceiveText',
      Channel: 'npc',
      From: '$ShipName_Military;',
      From_Localised: 'System Defence',
      Message: '$Military_UnderFire01;',
      Message_Localised: 'We are taking fire! Requesting support!',
    }),
  );
  s.apply(
    ev({
      timestamp: '2026-07-19T09:02:00Z',
      event: 'ReceiveText',
      Channel: 'npc',
      From_Localised: 'System Defence',
      Message: '$Military_UnderFire02;',
      Message_Localised: 'Still taking fire!',
    }),
  );
  const texts = s.beatsForDay('2026-07-19').map((b) => b.text).join(' | ');
  assert.match(texts, /Mission FAILED: "Late delivery"/);
  assert.match(texts, /System Defence: "We are taking fire!/);
  assert.doesNotMatch(texts, /Still taking fire/, 'same drama kind only once');
});

test('unflushed bounty streak still appears in beatsForDay', () => {
  const s = new SagaTracker();
  s.apply(ev({ timestamp: '2026-07-19T09:00:00Z', event: 'Bounty', VictimFaction: 'Pirates', TotalReward: 9000 }));
  const day = s.beatsForDay('2026-07-19');
  assert.equal(day.length, 1);
  assert.match(day[0].text, /Destroyed 1 ship\(s\)/);
});

test('episode prompt carries chronicle, continuity and episode number', () => {
  const s = loadedTracker();
  const chat = buildEpisodeChat({
    episodeNumber: 3,
    day: '2026-07-19',
    beats: s.beatsForDay('2026-07-19'),
    cmdr: s.cmdr,
    ship: s.ship,
    storySoFar: 'Previously, the Grasshopper cleared Ratraii of pirates.',
  });
  assert.match(chat[0].content, /space-opera serial/);
  assert.match(chat[0].content, /never invent events/);
  assert.match(chat[1].content, /The story so far:/);
  assert.match(chat[1].content, /Write Episode 3 now/);
  assert.match(chat[1].content, /80 AidWorker/);
});

test('beatRecap fallback produces a readable log', () => {
  const s = loadedTracker();
  const recap = beatRecap('2026-07-19', s.beatsForDay('2026-07-19'));
  assert.match(recap, /Chronicle of 2026-07-19/);
  assert.match(recap, /Bolden's Enterprise/);
});
