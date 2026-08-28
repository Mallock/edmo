import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionStateManager , rankCommunityGoals, type CommunityGoal } from '../src/engine/state.ts';
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

// --- community-goal ranking --------------------------------------------------
// Handed four goals and the rule "fewer pilots = bigger share", the model
// recommended the MOST contested one on 6 of 6 beats — a bigger number reads as
// better. Sorting four numbers is not a job for a language model, so the answer
// is computed here and the operator only voices it.

test('rankCommunityGoals picks the least and most contested goals', () => {
  const g = (system: string, contributors: number, over: Partial<CommunityGoal> = {}): CommunityGoal => ({
    id: contributors, title: `${system} Calls for Assistance`, system, market: `${system} Dock`,
    expiry: null, bonus: 0, contributors, playerContribution: 0, complete: false, ...over,
  });
  // The four from the live Colonia session.
  const r = rankCommunityGoals([g('Asura', 894), g('Randgnid', 795), g('Einheriar', 601), g('Carcosa', 825)])!;
  assert.equal(r.quietest.system, 'Einheriar'); // the one the model kept missing
  assert.equal(r.busiest?.system, 'Asura');
  assert.equal(r.count, 4);
});

test('completed goals never get recommended', () => {
  const g = (system: string, contributors: number, complete: boolean): CommunityGoal => ({
    id: contributors, title: system, system, market: 'Dock', expiry: null, bonus: 0,
    contributors, playerContribution: 0, complete,
  });
  // The quietest goal is finished — the answer must be the quietest LIVE one.
  const r = rankCommunityGoals([g('Done', 100, true), g('Einheriar', 601, false), g('Asura', 894, false)])!;
  assert.equal(r.quietest.system, 'Einheriar');
  assert.equal(r.count, 2);
  assert.equal(rankCommunityGoals([g('Done', 100, true)]), null);
  assert.equal(rankCommunityGoals([]), null);
});

test('a lone goal is the quietest and has no busiest counterpart', () => {
  const only: CommunityGoal = {
    id: 1, title: 'Only', system: 'Asura', market: 'Mizuno Dock', expiry: null,
    bonus: 0, contributors: 894, playerContribution: 0, complete: false,
  };
  const r = rankCommunityGoals([only])!;
  assert.equal(r.quietest.system, 'Asura');
  assert.equal(r.busiest, null); // nothing to contrast against — say nothing
  assert.equal(r.count, 1);
});

test('outposts are stations, whatever the journal flag says', () => {
  // Frontier sets IsStation only for the big orbitals. Counted over 40 real
  // journals: StationCoriolis, StationAsteroid, StationBernalSphere and
  // FleetCarrier all arrive true — and Outpost arrives FALSE, 604 times.
  // An outpost is a dockable port with pads, a market and people on it, so
  // trusting the flag alone filed eight of HIP 71120's nine ports next to the
  // nav beacon and left the comms briefing one station to name for ever.
  const sm = new MissionStateManager();
  const sig = (SignalName: string, SignalType: string, IsStation: boolean) => ({
    timestamp: '2026-08-27T12:00:00Z',
    event: 'FSSSignalDiscovered',
    SystemAddress: 1,
    SignalName,
    SignalType,
    IsStation,
  });
  sm.apply({ timestamp: '2026-08-27T11:59:00Z', event: 'Location', StarSystem: 'HIP 71120' });
  sm.apply(sig('Mikels Town', 'Outpost', false));
  sm.apply(sig('Benyovszky Gateway', 'StationCoriolis', true));
  sm.apply(sig('Rock Hall', 'StationAsteroid', true));
  sm.apply(sig('Resource Extraction Site [High]', 'ResourceExtraction', false));
  sm.apply(sig('Nav Beacon', 'NavBeacon', false));

  const byName = new Map(
    (sm.getState().system?.signals ?? []).map((s) => [s.name, s.isStation === true]),
  );
  assert.equal(byName.get('Mikels Town'), true, 'an outpost is somewhere you dock');
  assert.equal(byName.get('Benyovszky Gateway'), true);
  assert.equal(byName.get('Rock Hall'), true, 'asteroid stations too');
  // Scenery stays scenery.
  assert.equal(byName.get('Resource Extraction Site [High]'), false);
  assert.equal(byName.get('Nav Beacon'), false);
});
