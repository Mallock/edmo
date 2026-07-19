/** System intel: journal fold → AI context, hunt-nudge aggregation, idle reset. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionStateManager } from '../src/engine/state.ts';
import { Heartbeat } from '../src/engine/heartbeat.ts';
import { describeSystemIntel, missionContext } from '../src/engine/operator.ts';
import type { JournalEvent, Mission } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

function foldBinguiIntel(sm: MissionStateManager): void {
  sm.apply(
    ev({
      timestamp: '2026-07-19T10:00:00Z',
      event: 'FSDJump',
      StarSystem: 'Bingui',
      SystemSecurity: '$SYSTEM_SECURITY_low;',
      SystemSecurity_Localised: 'Low Security',
      SystemAllegiance: 'Independent',
      SystemFaction: { Name: 'Clan of Hors' },
      Population: 85000,
    }),
  );
  sm.apply(
    ev({
      timestamp: '2026-07-19T10:00:05Z',
      event: 'FSSSignalDiscovered',
      SignalName: '$MULTIPLAYER_SCENARIO42_TITLE;',
      SignalName_Localised: 'Nav Beacon',
      SignalType: 'NavBeacon',
    }),
  );
  sm.apply(
    ev({
      timestamp: '2026-07-19T10:00:06Z',
      event: 'FSSSignalDiscovered',
      SignalName: '$MULTIPLAYER_SCENARIO79_TITLE;',
      SignalName_Localised: 'Resource Extraction Site [Hazardous]',
      SignalType: 'ResourceExtraction',
    }),
  );
  sm.apply(
    ev({
      timestamp: '2026-07-19T10:00:07Z',
      event: 'FSSSignalDiscovered',
      SignalName: 'Lambert Camp',
      IsStation: true,
      SignalType: 'Outpost',
    }),
  );
  // A transient USS must be ignored.
  sm.apply(
    ev({
      timestamp: '2026-07-19T10:00:08Z',
      event: 'FSSSignalDiscovered',
      SignalName: '$USS_Type_Salvage;',
      SignalName_Localised: 'Unidentified signal source',
    }),
  );
}

test('FSDJump + FSS signals fold into system intel and reach the AI context', () => {
  const sm = new MissionStateManager();
  foldBinguiIntel(sm);
  const st = sm.getState();
  assert.equal(st.system?.security, 'Low Security');
  assert.equal(st.system?.controllingFaction, 'Clan of Hors');
  assert.equal(st.system?.signals.length, 3, 'USS filtered out');

  const intel = describeSystemIntel(st);
  assert.ok(intel);
  assert.match(intel!, /Low Security/);
  assert.match(intel!, /Nav Beacon/);
  assert.match(intel!, /Hazardous/);
  assert.match(intel!, /Lambert Camp/);

  const mission = st.activeMissions[0] ?? fakeKill(1, 'LazerFX');
  assert.match(missionContext(mission, st), /Resource Extraction Site \[Hazardous\]/);
});

test('intel resets when jumping to a new system', () => {
  const sm = new MissionStateManager();
  foldBinguiIntel(sm);
  sm.apply(ev({ timestamp: '2026-07-19T11:00:00Z', event: 'FSDJump', StarSystem: 'Aoesta' }));
  assert.equal(sm.getState().system?.signals.length, 0);
  assert.equal(sm.getState().system?.security, undefined);
});

function fakeKill(id: number, target: string): Mission {
  return {
    id,
    internalName: 'Mission_Assassinate',
    title: `Kill ${target}`,
    category: 'Assassinate',
    reward: 100000,
    wing: false,
    expiry: '2026-07-20T10:00:00Z',
    acceptedAt: '2026-07-19T09:00:00Z',
    steps: [],
    state: 'ACTIVE',
    redirected: false,
    killProgress: 0,
    raw: { timestamp: '', event: 'MissionAccepted' },
    destination: { system: 'Bingui' },
    target: { name: target, type: 'Deserter' },
  };
}

test('stacked kill missions produce ONE aggregated hunt nudge naming real venues', () => {
  const sm = new MissionStateManager();
  foldBinguiIntel(sm);
  const st = {
    ...sm.getState(),
    docked: false,
    activeMissions: [fakeKill(1, 'Ramtop'), fakeKill(2, "Brian's Thugs"), fakeKill(3, "Brian's Thugs")],
    lastActivityAt: '2026-07-19T10:00:00Z',
  };
  const hb = new Heartbeat();
  const nudges = hb.evaluate(st, '2026-07-19T10:09:00Z');
  const hunts = nudges.filter((n) => n.rule === 'stuck-hunting');
  assert.equal(hunts.length, 1, 'aggregated into a single nudge');
  assert.match(hunts[0].message, /3 kill missions/);
  assert.match(hunts[0].message, /Ramtop/);
  assert.match(hunts[0].message, /Resource Extraction Site \[Hazardous\]/);
});

test('login "Missions" journal event restores placeholders when no accepts were replayed', () => {
  // Game closed → Missions.json deleted → the login event in the journal is
  // the only record of the active set. Regression: this used to yield zero.
  const sm = new MissionStateManager();
  sm.apply(
    ev({
      timestamp: '2026-07-19T07:49:12Z',
      event: 'Missions',
      Active: [
        { MissionID: 1061028196, Name: 'Mission_Assassinate_Legal_War_name', Expires: 39334 },
        { MissionID: 1061028205, Name: 'Mission_Massacre_name', Expires: 111911 },
      ],
      Failed: [],
      Complete: [],
    }),
  );
  const st = sm.getState();
  assert.equal(st.activeMissions.length, 2);
  const kill = st.activeMissions.find((m) => m.id === 1061028196)!;
  assert.equal(kill.category, 'Assassinate');
  assert.ok(kill.expiry && Date.parse(kill.expiry) > Date.parse('2026-07-19T07:49:12Z'));
});

test('session-start Location event resets the idle clock', () => {
  const sm = new MissionStateManager();
  sm.apply(ev({ timestamp: '2026-07-18T20:00:00Z', event: 'Docked', StationName: 'X', StarSystem: 'Y' }));
  // Next day the game starts: Location must count as fresh activity so the
  // heartbeat doesn't immediately report hours of idling.
  sm.apply(ev({ timestamp: '2026-07-19T09:00:00Z', event: 'Location', StarSystem: 'Y', Docked: true }));
  assert.equal(sm.getState().lastActivityAt, '2026-07-19T09:00:00Z');
});
