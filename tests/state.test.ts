import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionStateManager } from '../src/engine/state.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as JournalEvent;

test('assassinate lifecycle: accept -> redirect -> complete (real LazerFX data)', () => {
  const sm = new MissionStateManager();

  sm.apply(
    ev({
      timestamp: '2025-06-18T10:47:05Z',
      event: 'MissionAccepted',
      Faction: 'EG Union',
      Name: 'Mission_Assassinate',
      LocalisedName: 'Assassinate Known Pirate: LazerFX',
      TargetType: '$MissionUtil_FactionTag_PirateLord;',
      TargetType_Localised: 'Known Pirate',
      TargetFaction: 'Clan of Hors',
      DestinationSystem: 'Crucis Sector SO-R a4-0',
      DestinationStation: 'Ohm City',
      Target: 'LazerFX',
      Expiry: '2025-06-19T10:46:27Z',
      Reward: 1564280,
      MissionID: 1019940338,
    }),
  );

  let m = sm.activeMissions()[0];
  assert.equal(m.category, 'Assassinate');
  assert.equal(m.target?.name, 'LazerFX');
  assert.equal(m.target?.type, 'Known Pirate');
  assert.equal(m.destination?.station, 'Ohm City');
  assert.equal(m.state, 'ACTIVE');
  assert.equal(m.reward, 1564280);

  const changes = sm.apply(
    ev({
      timestamp: '2025-06-18T11:08:20Z',
      event: 'MissionRedirected',
      MissionID: 1019940338,
      Name: 'Mission_Assassinate',
      NewDestinationStation: 'Hyperion Monolith 001 - Sheparts Legacy',
      NewDestinationSystem: 'Aoesta',
      OldDestinationStation: '',
      OldDestinationSystem: 'Crucis Sector SO-R a4-0',
    }),
  );
  assert.equal(changes[0].kind, 'redirected');
  m = sm.activeMissions()[0];
  assert.equal(m.state, 'REDIRECTED');
  assert.equal(m.redirected, true);
  assert.equal(m.destination?.system, 'Aoesta');
  assert.ok(m.killProgress >= 1);
  // the "return / hand in" steps should now exist
  assert.ok(m.steps.some((s) => /hand in/i.test(s.label)));

  sm.apply(
    ev({
      timestamp: '2025-06-18T11:20:00Z',
      event: 'MissionCompleted',
      MissionID: 1019940338,
      Reward: 1564280,
    }),
  );
  assert.equal(sm.activeMissions().length, 0);
  assert.equal(sm.allMissions()[0].state, 'COMPLETE');
});

test('delivery cargo progress via CargoDepot (real 54-unit run)', () => {
  const sm = new MissionStateManager();
  sm.apply(
    ev({
      timestamp: '2025-07-05T18:05:38Z',
      event: 'MissionAccepted',
      Name: 'Mission_Delivery_Agriculture',
      LocalisedName: 'Agricultural supply run: 54 units of Insulating Membrane',
      Commodity: '$InsulatingMembrane_Name;',
      Commodity_Localised: 'Insulating Membrane',
      Count: 54,
      DestinationSystem: 'HIP 60648',
      DestinationStation: 'Descartes Ring',
      Expiry: '2025-07-06T18:04:09Z',
      Reward: 330506,
      MissionID: 1021618348,
    }),
  );
  let m = sm.activeMissions()[0];
  assert.equal(m.category, 'Delivery');
  assert.equal(m.cargo?.total, 54);
  assert.equal(m.steps[0].done, false); // not acquired yet

  sm.apply(
    ev({
      timestamp: '2025-07-05T18:06:13Z',
      event: 'CargoDepot',
      MissionID: 1021618348,
      UpdateType: 'Collect',
      Count: 54,
      ItemsCollected: 54,
      ItemsDelivered: 0,
      TotalItemsToDeliver: 54,
      Progress: 0.0,
    }),
  );
  m = sm.activeMissions()[0];
  assert.equal(m.cargo?.collected, 54);
  assert.equal(m.steps[0].done, true); // acquired
  assert.equal(m.steps[2].done, false); // not delivered

  sm.apply(
    ev({
      timestamp: '2025-07-05T18:44:40Z',
      event: 'CargoDepot',
      MissionID: 1021618348,
      UpdateType: 'Deliver',
      ItemsCollected: 54,
      ItemsDelivered: 54,
      TotalItemsToDeliver: 54,
      Progress: 1.0,
    }),
  );
  m = sm.activeMissions()[0];
  assert.equal(m.cargo?.delivered, 54);
  assert.equal(m.steps[2].done, true); // delivered
});

test('location tracking + arrival hand-in detection', () => {
  const sm = new MissionStateManager();
  sm.apply(
    ev({
      timestamp: '2025-07-05T18:04:39Z',
      event: 'MissionAccepted',
      Name: 'Mission_Courier_Expansion',
      LocalisedName: 'Expansion Data Couriering',
      DestinationSystem: 'HIP 71120',
      DestinationStation: 'Anders City',
      Expiry: '2025-07-06T18:04:09Z',
      Reward: 123542,
      MissionID: 1021618271,
    }),
  );
  sm.apply(ev({ timestamp: '2025-07-05T18:08:31Z', event: 'FSDJump', StarSystem: 'HIP 71120' }));
  assert.equal(sm.location.system, 'HIP 71120');
  assert.equal(sm.docked, false);

  const changes = sm.apply(
    ev({
      timestamp: '2025-07-05T18:15:19Z',
      event: 'Docked',
      StationName: 'Anders City',
      StarSystem: 'HIP 71120',
    }),
  );
  assert.equal(sm.docked, true);
  assert.ok(changes.some((c) => c.kind === 'arrivedAtDestination'));
});
