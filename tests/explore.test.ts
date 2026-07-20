/** ExploreTracker — body classification, mapping leads, unsold value. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExploreTracker, classifyBody } from '../src/engine/explore.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent =>
  ({ event: 'Scan', timestamp: '2026-07-20T12:00:00Z', ...o } as unknown as JournalEvent);

test('classifyBody recognises the money bodies', () => {
  assert.deepEqual(classifyBody(ev({ PlanetClass: 'Earthlike body' })), { tier: 'earthlike', terraformable: false });
  assert.equal(classifyBody(ev({ PlanetClass: 'Water world' })).tier, 'water');
  assert.equal(classifyBody(ev({ PlanetClass: 'Ammonia world' })).tier, 'ammonia');
  assert.equal(
    classifyBody(ev({ PlanetClass: 'High metal content body', TerraformState: 'Terraformable' })).tier,
    'terraformable',
  );
  assert.equal(classifyBody(ev({ PlanetClass: 'Icy body' })).tier, 'other');
});

test('scans build leads in the current system and estimate value', () => {
  const t = new ExploreTracker();
  t.apply(ev({ event: 'Location', StarSystem: 'Nervi', SystemAddress: 111 }));
  t.apply(
    ev({
      StarSystem: 'Nervi',
      SystemAddress: 111,
      BodyName: 'Nervi 3',
      BodyID: 3,
      PlanetClass: 'Earthlike body',
      WasDiscovered: false,
      DistanceFromArrivalLS: 900,
    }),
  );
  // A low-value icy body should not become a lead.
  t.apply(ev({ StarSystem: 'Nervi', SystemAddress: 111, BodyName: 'Nervi 4', BodyID: 4, PlanetClass: 'Icy body' }));

  const leads = t.leads();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].body, 'Nervi 3');
  assert.equal(leads[0].inCurrentSystem, true);
  assert.ok(t.unsoldValue() >= 270000);
});

test('DSS mapping drops a body off the leads list', () => {
  const t = new ExploreTracker();
  t.apply(ev({ event: 'Location', StarSystem: 'Nervi', SystemAddress: 111 }));
  t.apply(ev({ StarSystem: 'Nervi', SystemAddress: 111, BodyName: 'Nervi 3', BodyID: 3, PlanetClass: 'Water world' }));
  assert.equal(t.leads().length, 1);
  t.apply(ev({ event: 'SAAScanComplete', SystemAddress: 111, BodyID: 3, BodyName: 'Nervi 3' }));
  assert.equal(t.leads().length, 0);
});

test('selling exploration data clears the unsold ledger', () => {
  const t = new ExploreTracker();
  t.apply(ev({ BodyName: 'X 1', BodyID: 1, PlanetClass: 'Earthlike body', SystemAddress: 5 }));
  assert.ok(t.unsoldValue() > 0);
  t.apply(ev({ event: 'MultiSellExplorationData' }));
  assert.equal(t.unsoldValue(), 0);
});

test('contextLine reports unsold value and worth-mapping bodies here', () => {
  const t = new ExploreTracker();
  t.apply(ev({ event: 'Location', StarSystem: 'Nervi', SystemAddress: 111 }));
  t.apply(
    ev({
      StarSystem: 'Nervi',
      SystemAddress: 111,
      BodyName: 'Nervi 3',
      BodyID: 3,
      PlanetClass: 'Earthlike body',
    }),
  );
  const line = t.contextLine()!;
  assert.match(line, /unsold cartographic data/);
  assert.match(line, /Worth mapping here: Nervi 3/);
});
