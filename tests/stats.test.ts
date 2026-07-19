/** SessionStats ledger + BGS summary + reduced-package + CG fold + seeds. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStats } from '../src/engine/stats.ts';
import { MissionStateManager, bgsSummary } from '../src/engine/state.ts';
import { completionNotice } from '../src/engine/operator.ts';
import { buildAfterglowChat, buildFlavorChat, planStory } from '../src/engine/flavor.ts';
import { mulberry32 } from '../src/engine/flavor.ts';
import type { JournalEvent, Mission, OperatorState } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

test('ledger accumulates a session and resets on LoadGame', () => {
  const s = new SessionStats();
  s.apply(ev({ event: 'LoadGame', Credits: 1_000_000 }));
  s.apply(ev({ event: 'MissionCompleted', Reward: 331255 }));
  s.apply(ev({ event: 'Bounty', TotalReward: 5000 }));
  s.apply(ev({ event: 'Bounty', TotalReward: 7000 }));
  s.apply(ev({ event: 'NpcCrewPaidWage', Amount: 2500 }));
  s.apply(ev({ event: 'FSDJump', JumpDist: 22.5, FuelUsed: 3 }));
  assert.equal(s.earnedTotal(), 343255);
  const ledger = s.ledgerSummary()!;
  assert.match(ledger, /1 mission\(s\) paid 331,255 cr/);
  assert.match(ledger, /2 bounties worth 12,000 cr/);
  assert.match(ledger, /crew took 2,500 cr/);
  // New game session wipes earnings but keeps unbanked data.
  s.apply(ev({ event: 'ScanOrganic', ScanType: 'Analyse' }));
  s.apply(ev({ event: 'LoadGame', Credits: 1_343_255 }));
  assert.equal(s.earnedTotal(), 0);
  assert.equal(s.unsoldBio, 1);
  s.apply(ev({ event: 'SellOrganicData', BioData: [] }));
  assert.equal(s.unsoldBio, 0);
});

test('risk note flags hull, bio cargo and rebuy', () => {
  const s = new SessionStats();
  assert.equal(s.riskNote(), null);
  s.apply(ev({ event: 'Loadout', Rebuy: 2_145_000, HullHealth: 0.82 }));
  s.apply(ev({ event: 'ScanOrganic', ScanType: 'Analyse' }));
  const note = s.riskNote()!;
  assert.match(note, /1 unbanked bio sample/);
  assert.match(note, /hull at 82%/);
  assert.match(note, /rebuy 2,145,000 cr/);
});

test('bgsSummary condenses real FactionEffects', () => {
  const text = bgsSummary(
    ev({
      event: 'MissionCompleted',
      FactionEffects: [
        {
          Faction: 'Tir Technology Services',
          Effects: [
            { Effect: '$MISSIONUTIL_Interaction_Summary_EP_up;', Trend: 'UpGood' },
          ],
          Influence: [{ SystemAddress: 1, Trend: 'UpGood', Influence: '+' }],
          ReputationTrend: 'UpGood',
          Reputation: '+',
        },
        {
          Faction: '',
          Effects: [
            { Effect: '$MISSIONUTIL_Interaction_Summary_SP_down;', Trend: 'DownBad' },
          ],
          Influence: [],
        },
      ],
    }),
    "Brian's Thugs",
  )!;
  assert.match(text, /Tir Technology Services: economy ↑, influence \+, reputation \+/);
  assert.match(text, /Brian's Thugs: security ↓/);
});

test('completionNotice calls out reduced reward packages', () => {
  const m = {
    title: 'Kill pirates',
    reward: 10_000,
    boardReward: 166_734,
  } as Mission;
  assert.match(completionNotice(m), /reduced package — 156,734 cr under the board price/);
  m.reward = 166_734;
  assert.doesNotMatch(completionNotice(m), /reduced/);
});

test('CommunityGoal event folds into state', () => {
  const sm = new MissionStateManager();
  sm.apply(
    ev({
      timestamp: '2026-07-18T15:59:17Z',
      event: 'CommunityGoal',
      CurrentGoals: [
        {
          CGID: 851,
          Title: 'Anniversary Celebrations Support',
          SystemName: 'Facece',
          MarketName: 'Peters Base',
          Expiry: '2026-07-23T10:00:00Z',
          IsComplete: false,
          NumContributors: 7412,
          Bonus: 30000000,
          PlayerContribution: 0,
        },
      ],
    }),
  );
  assert.equal(sm.communityGoals.length, 1);
  assert.equal(sm.communityGoals[0].title, 'Anniversary Celebrations Support');
  assert.equal(sm.communityGoals[0].bonus, 30000000);
});

const STATE: OperatorState = {
  now: '2026-07-19T12:00:00Z',
  location: { system: 'Ratraii' },
  docked: true,
  activeMissions: [],
  lastActivityAt: '2026-07-19T12:00:00Z',
};

test('story prompts carry true-event seeds; afterglow works with no missions', () => {
  const seeds = ['Eliminated Ramtop (Deserter) for Colonia Co-operative'];
  const after = buildAfterglowChat(seeds, STATE, mulberry32(5));
  assert.match(after[1].content, /Ramtop/);
  assert.match(after[1].content, /No active contracts/);

  const mission = { ...({} as Mission), id: 1, title: 'X', category: 'Courier', reward: 1, steps: [], state: 'ACTIVE', redirected: false, killProgress: 0, internalName: 'Mission_Courier', wing: false, expiry: null, acceptedAt: STATE.now, raw: { timestamp: '', event: 'MissionAccepted' } } as Mission;
  const plan = planStory([mission], mulberry32(5))!;
  const chat = buildFlavorChat(plan, STATE, seeds);
  assert.match(chat[1].content, /Recent true events/);
  assert.match(chat[1].content, /Ramtop/);
});
