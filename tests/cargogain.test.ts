/** Cargo acquisition estimates (mining/buying/scooping) + combination context. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionStateManager, normalizeCommodity } from '../src/engine/state.ts';
import { missionContext } from '../src/engine/operator.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

let t = 0;
const at = (): string => new Date(Date.parse('2026-07-19T10:00:00Z') + ++t * 20_000).toISOString();

function acceptCargo(
  sm: MissionStateManager,
  id: number,
  name: string,
  commodity: string,
  count: number,
): void {
  sm.apply(
    ev({
      timestamp: at(),
      event: 'MissionAccepted',
      Faction: 'Testers',
      Name: name,
      LocalisedName: `${name} job`,
      Commodity: `$${commodity}_Name;`,
      Commodity_Localised: commodity,
      Count: count,
      DestinationSystem: 'Ratraii',
      Expiry: '2026-07-21T10:00:00Z',
      Reward: 100000,
      MissionID: id,
    }),
  );
}

test('commodity name normalization bridges journal spellings', () => {
  assert.equal(normalizeCommodity('$tritium_name;'), 'tritium');
  assert.equal(normalizeCommodity('Tritium'), 'tritium');
  assert.equal(normalizeCommodity('tritium'), 'tritium');
  assert.equal(normalizeCommodity('Domestic Appliances'), 'domesticappliances');
});

test('MiningRefined ticks a mining mission toward its tonnage', () => {
  const sm = new MissionStateManager();
  acceptCargo(sm, 1, 'Mission_Mining', 'Tritium', 3);
  sm.apply(ev({ timestamp: at(), event: 'MiningRefined', Type: '$tritium_name;', Type_Localised: 'Tritium' }));
  sm.apply(ev({ timestamp: at(), event: 'MiningRefined', Type: '$tritium_name;', Type_Localised: 'Tritium' }));
  const m = sm.activeMissions()[0];
  assert.equal(m.cargo?.collected, 2);
  // Wrong ore does nothing.
  sm.apply(ev({ timestamp: at(), event: 'MiningRefined', Type: '$gold_name;', Type_Localised: 'Gold' }));
  assert.equal(m.cargo?.collected, 2);
  // Acquire step flips only at the full tonnage.
  assert.equal(m.steps[0].done, false);
  sm.apply(ev({ timestamp: at(), event: 'MiningRefined', Type: '$tritium_name;', Type_Localised: 'Tritium' }));
  assert.equal(m.cargo?.collected, 3);
  assert.equal(sm.activeMissions()[0].steps[0].done, true);
});

test('MarketBuy fills delivery missions sequentially, oldest first, capped', () => {
  const sm = new MissionStateManager();
  acceptCargo(sm, 1, 'Mission_Delivery', 'Osmium', 2);
  acceptCargo(sm, 2, 'Mission_Delivery', 'Osmium', 5);
  sm.apply(ev({ timestamp: at(), event: 'MarketBuy', Type: 'osmium', Count: 4, BuyPrice: 100 }));
  const [m1, m2] = sm.activeMissions();
  assert.equal(m1.cargo?.collected, 2, 'first mission fills to its cap');
  assert.equal(m2.cargo?.collected, 2, 'overflow spills to the next');
});

test('missionContext lists the rest of the board for combination advice', () => {
  const sm = new MissionStateManager();
  acceptCargo(sm, 1, 'Mission_Delivery', 'Osmium', 2);
  acceptCargo(sm, 2, 'Mission_Mining', 'Tritium', 5);
  const st = sm.getState();
  const ctx = missionContext(st.activeMissions[0], st);
  assert.match(ctx, /Other active missions \(1\)/);
  assert.match(ctx, /Mission_Mining job/);
  assert.match(ctx, /needs 5 Tritium/);
});
