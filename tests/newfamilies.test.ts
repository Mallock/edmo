/** New mission families + BGS faction states + memory baselines. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCategory } from '../src/engine/detectType.ts';
import { synthesizeSteps } from '../src/engine/steps.ts';
import { ruleBasedAdvice } from '../src/engine/operator.ts';
import { MissionStateManager } from '../src/engine/state.ts';
import { CommanderMemory } from '../src/engine/memory.ts';
import type { JournalEvent, Mission } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

function mission(partial: Partial<Mission>): Mission {
  return {
    id: 1,
    internalName: 'Mission_X',
    title: 'X',
    category: 'Courier',
    reward: 1000,
    wing: false,
    expiry: null,
    acceptedAt: '2026-07-20T12:00:00Z',
    steps: [],
    state: 'ACTIVE',
    redirected: false,
    killProgress: 0,
    raw: { timestamp: '', event: 'MissionAccepted' },
    ...partial,
  } as Mission;
}

test('detectCategory maps the new families', () => {
  assert.equal(detectCategory('Mission_AltruismCredits'), 'Donation');
  assert.equal(detectCategory('Mission_Altruism'), 'Donation');
  assert.equal(detectCategory('Mission_Scan'), 'Scan');
  assert.equal(detectCategory('Mission_Hack'), 'Hack');
  assert.equal(detectCategory('Mission_Sabotage_Production'), 'Disable');
  assert.equal(detectCategory('Mission_Smuggle'), 'Smuggle');
  // On-foot variants win over their objective word.
  assert.equal(detectCategory('Mission_OnFoot_Salvage_MB'), 'OnFoot');
  assert.equal(detectCategory('Mission_OnFoot_Collect_Covert'), 'OnFoot');
});

test('steps synthesise for donation and on-foot missions', () => {
  const donation = mission({ category: 'Donation', faction: 'Colonia Council' });
  const dSteps = synthesizeSteps(donation);
  assert.equal(dSteps.length, 1);
  assert.match(dSteps[0].label, /Donate to Colonia Council/);

  const onfoot = mission({ category: 'OnFoot', destination: { system: 'Nervi', station: 'Base' } });
  const oSteps = synthesizeSteps(onfoot);
  assert.equal(oSteps.length, 3);
  assert.match(oSteps[1].label, /on foot/i);
});

test('ruleBasedAdvice covers the new families', () => {
  assert.match(ruleBasedAdvice(mission({ category: 'Smuggle', destination: { system: 'S' } }), '2026-07-20T12:00:00Z'), /illegal/);
  assert.match(ruleBasedAdvice(mission({ category: 'Donation', faction: 'Council' }), '2026-07-20T12:00:00Z'), /donation/i);
  assert.match(ruleBasedAdvice(mission({ category: 'OnFoot', destination: { system: 'S' } }), '2026-07-20T12:00:00Z'), /on-foot|suit/i);
});

test('on-foot accept sets the onFoot flag and OnFoot category', () => {
  const sm = new MissionStateManager();
  sm.apply(
    ev({
      timestamp: '2026-07-20T12:00:00Z',
      event: 'MissionAccepted',
      Name: 'Mission_OnFoot_Salvage_MB',
      LocalisedName: 'Recover the data',
      MissionID: 42,
      Faction: 'Colonia Council',
      DestinationSystem: 'Nervi',
    }),
  );
  const m = sm.activeMissions()[0];
  assert.equal(m.category, 'OnFoot');
  assert.equal(m.onFoot, true);
});

test('FSDJump Factions[] surface active BGS states in system intel', () => {
  const sm = new MissionStateManager();
  sm.apply(
    ev({
      timestamp: '2026-07-20T12:00:00Z',
      event: 'FSDJump',
      StarSystem: 'Ratraii',
      SystemSecurity: 'Low',
      Factions: [
        { Name: 'Ratraii Purple Council', FactionState: 'War' },
        { Name: 'Colonia Co-operative', FactionState: 'None' },
        { Name: 'Nervi Boom Inc', FactionState: 'Boom' },
      ],
    }),
  );
  const intel = sm.getState().system!;
  assert.deepEqual(intel.factionStates, [
    { name: 'Ratraii Purple Council', state: 'War' },
    { name: 'Nervi Boom Inc', state: 'Boom' },
  ]);
});

test('memory folds baseline Rank, Reputation and Statistics into the profile', () => {
  const mem = new CommanderMemory();
  mem.apply(ev({ timestamp: '2026-07-20T12:00:00Z', event: 'Rank', Combat: 6, Trade: 4, Explore: 3 }));
  mem.apply(ev({ timestamp: '2026-07-20T12:00:01Z', event: 'Reputation', Empire: 45.2, Federation: -10 }));
  mem.apply(
    ev({
      timestamp: '2026-07-20T12:00:02Z',
      event: 'Statistics',
      Bank_Account: { Current_Wealth: 1_250_000_000 },
      Exploration: { Total_Hyperspace_Distance: 84213 },
    }),
  );
  assert.equal(mem.ranks.Combat, 6);
  assert.equal(mem.reputations.Empire, 45.2);
  const profile = mem.profileLines().join('\n');
  assert.match(profile, /Dangerous \(Combat\)/);
  assert.match(profile, /lifetime wealth about 1,250,000,000 cr/);
  assert.match(profile, /84,213 ly travelled/);
});
