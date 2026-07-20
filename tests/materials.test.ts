/** MaterialsTracker — inventory fold + engineering + context line. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MaterialsTracker } from '../src/engine/materials.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

test('Materials baseline replaces the whole grid', () => {
  const m = new MaterialsTracker();
  m.apply(
    ev({
      event: 'Materials',
      Raw: [{ Name: 'iron', Name_Localised: 'Iron', Count: 100 }],
      Manufactured: [{ Name: 'shieldemitters', Name_Localised: 'Shield Emitters', Count: 30 }],
      Encoded: [{ Name: 'shielddensityreports', Name_Localised: 'Shield Density Reports', Count: 12 }],
    }),
  );
  assert.equal(m.count('iron'), 100);
  const t = m.totalByCategory();
  assert.equal(t.Raw, 100);
  assert.equal(t.Manufactured, 30);
  assert.equal(t.Encoded, 12);
});

test('collect, discard and trade adjust counts', () => {
  const m = new MaterialsTracker();
  m.apply(ev({ event: 'MaterialCollected', Category: 'Raw', Name: 'nickel', Name_Localised: 'Nickel', Count: 3 }));
  assert.equal(m.count('nickel'), 3);
  m.apply(ev({ event: 'MaterialDiscarded', Category: 'Raw', Name: 'nickel', Count: 1 }));
  assert.equal(m.count('nickel'), 2);
  m.apply(
    ev({
      event: 'MaterialTrade',
      Paid: { Material: 'nickel', Category: 'Raw', Quantity: 2 },
      Received: { Material: 'tungsten', Category: 'Raw', Quantity: 1 },
    }),
  );
  assert.equal(m.count('nickel'), 0);
  assert.equal(m.count('tungsten'), 1);
});

test('EngineerCraft consumes ingredients and marks the engineer unlocked', () => {
  const m = new MaterialsTracker();
  m.apply(ev({ event: 'MaterialCollected', Category: 'Raw', Name: 'iron', Count: 10 }));
  m.apply(
    ev({
      event: 'EngineerCraft',
      Engineer: 'Felicity Farseer',
      Blueprint: 'FSD_LongRange',
      Level: 3,
      Ingredients: [{ Name: 'iron', Count: 4 }],
    }),
  );
  assert.equal(m.count('iron'), 6);
  assert.deepEqual(m.unlockedEngineers(), ['Felicity Farseer']);
});

test('EngineerProgress folds the login roster', () => {
  const m = new MaterialsTracker();
  m.apply(
    ev({
      event: 'EngineerProgress',
      Engineers: [
        { Engineer: 'Elvira Martuuk', Progress: 'Unlocked', Rank: 5 },
        { Engineer: 'The Dweller', Progress: 'Known', Rank: 0 },
      ],
    }),
  );
  assert.deepEqual(m.unlockedEngineers(), ['Elvira Martuuk']);
});

test('mission material rewards are added', () => {
  const m = new MaterialsTracker();
  m.apply(
    ev({
      event: 'MissionCompleted',
      MaterialsReward: [{ Name: 'chromium', Name_Localised: 'Chromium', Category: 'Raw', Count: 4 }],
    }),
  );
  assert.equal(m.count('chromium'), 4);
});

test('contextLine summarises inventory and engineers', () => {
  const m = new MaterialsTracker();
  assert.equal(m.contextLine(), null);
  m.apply(ev({ event: 'MaterialCollected', Category: 'Raw', Name: 'iron', Count: 10 }));
  m.apply(ev({ event: 'EngineerProgress', Engineer: 'Felicity Farseer', Progress: 'Unlocked', Rank: 5 }));
  const line = m.contextLine()!;
  assert.match(line, /10 raw/);
  assert.match(line, /1 engineers unlocked/);
});

test('inventory round-trips through toJSON/load', () => {
  const m = new MaterialsTracker();
  m.apply(ev({ event: 'MaterialCollected', Category: 'Manufactured', Name: 'wornshieldemitters', Name_Localised: 'Worn Shield Emitters', Count: 7 }));
  const m2 = new MaterialsTracker();
  m2.load(m.toJSON());
  assert.equal(m2.count('wornshieldemitters'), 7);
});
