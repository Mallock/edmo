/** Exobiology tracker — signal discovery, sampling progress, lead ranking. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BioTracker } from '../src/engine/exobio.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent => o as unknown as JournalEvent;

function tracked(): BioTracker {
  const t = new BioTracker();
  t.apply(ev({ timestamp: '2026-07-19T10:00:00Z', event: 'FSDJump', StarSystem: 'Eol Prou PC-K c9-221', SystemAddress: 111 }));
  t.apply(
    ev({
      timestamp: '2026-07-19T10:01:00Z',
      event: 'FSSBodySignals',
      SystemAddress: 111,
      BodyID: 7,
      BodyName: 'Eol Prou PC-K c9-221 A 2',
      Signals: [
        { Type: '$SAA_SignalType_Biological;', Type_Localised: 'Biological', Count: 3 },
        { Type: '$SAA_SignalType_Geological;', Type_Localised: 'Geological', Count: 5 },
      ],
    }),
  );
  return t;
}

test('FSS bio signals create a lead; geological-only bodies are ignored', () => {
  const t = tracked();
  t.apply(
    ev({
      timestamp: '2026-07-19T10:02:00Z',
      event: 'FSSBodySignals',
      SystemAddress: 111,
      BodyID: 9,
      BodyName: 'Eol Prou PC-K c9-221 A 3',
      Signals: [{ Type: '$SAA_SignalType_Geological;', Type_Localised: 'Geological', Count: 2 }],
    }),
  );
  const leads = t.leads();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].body, 'Eol Prou PC-K c9-221 A 2');
  assert.equal(leads[0].remaining, 3);
  assert.ok(leads[0].inCurrentSystem);
});

test('DSS genera enrich; Analyse samples reduce remaining until done', () => {
  const t = tracked();
  t.apply(
    ev({
      timestamp: '2026-07-19T10:05:00Z',
      event: 'SAASignalsFound',
      SystemAddress: 111,
      BodyID: 7,
      BodyName: 'Eol Prou PC-K c9-221 A 2',
      Signals: [{ Type: '$SAA_SignalType_Biological;', Type_Localised: 'Biological', Count: 3 }],
      Genuses: [
        { Genus: '$Codex_Ent_Stratum_Genus_Name;', Genus_Localised: 'Stratum' },
        { Genus: '$Codex_Ent_Bacterial_Genus_Name;', Genus_Localised: 'Bacterium' },
        { Genus: '$Codex_Ent_Fungoids_Genus_Name;', Genus_Localised: 'Fungoida' },
      ],
    }),
  );
  const sample = (genus: string) =>
    t.apply(
      ev({
        timestamp: '2026-07-19T11:00:00Z',
        event: 'ScanOrganic',
        ScanType: 'Analyse',
        SystemAddress: 111,
        Body: 7,
        Genus_Localised: genus,
      }),
    );
  sample('Stratum');
  assert.equal(t.leads()[0].remaining, 2);
  assert.deepEqual(t.leads()[0].genuses, ['Stratum', 'Bacterium', 'Fungoida']);
  sample('Stratum'); // duplicate must not double-count
  assert.equal(t.leads()[0].remaining, 2);
  sample('Bacterium');
  sample('Fungoida');
  assert.equal(t.leads().length, 0, 'fully sampled body stops being a lead');
});

test('current system outranks newer discoveries elsewhere; exclusion works', () => {
  const t = tracked();
  t.apply(ev({ timestamp: '2026-07-19T12:00:00Z', event: 'FSDJump', StarSystem: 'Ratraii', SystemAddress: 222 }));
  t.apply(
    ev({
      timestamp: '2026-07-19T12:01:00Z',
      event: 'FSSBodySignals',
      SystemAddress: 222,
      BodyID: 4,
      BodyName: 'Ratraii B 1',
      Signals: [{ Type: '$SAA_SignalType_Biological;', Type_Localised: 'Biological', Count: 1 }],
    }),
  );
  const leads = t.leads();
  assert.equal(leads[0].body, 'Ratraii B 1', 'current-system lead first');
  assert.equal(leads[1].body, 'Eol Prou PC-K c9-221 A 2');
  const excluded = t.leads(new Set([leads[0].key]));
  assert.equal(excluded[0].body, 'Eol Prou PC-K c9-221 A 2');
});

test('Scan enriches landable/distance', () => {
  const t = tracked();
  t.apply(
    ev({
      timestamp: '2026-07-19T10:03:00Z',
      event: 'Scan',
      SystemAddress: 111,
      BodyID: 7,
      BodyName: 'Eol Prou PC-K c9-221 A 2',
      Landable: true,
      DistanceFromArrivalLS: 1234.7,
    }),
  );
  const [lead] = t.leads();
  assert.equal(lead.landable, true);
  assert.equal(lead.distanceLs, 1235);
});

// -------------------------------------- samples outlive the body record

/**
 * The real failure, from HIP 71120 2 e (SystemAddress 83986911994, BodyID 25).
 *
 * Four genera down there — Bacterium, Fungoida, Frutexa, Tussock. The commander
 * logged Tussock Cultro on 2025-08-27 and came back a year later. The app
 * replays one previous session, so that receipt was long out of reach, and it
 * reported all four still uncollected while they stood on the rock.
 */
const HIP = 83986911994;
const dss = (t: BioTracker) =>
  t.apply(
    ev({
      timestamp: '2026-08-12T19:02:40Z',
      event: 'SAASignalsFound',
      SystemAddress: HIP,
      BodyID: 25,
      BodyName: 'HIP 71120 2 e',
      Signals: [{ Type: '$SAA_SignalType_Biological;', Type_Localised: 'Biological', Count: 4 }],
      Genuses: [
        { Genus: '$Codex_Ent_Bacterial_Genus_Name;', Genus_Localised: 'Bacterium' },
        { Genus: '$Codex_Ent_Fungoids_Genus_Name;', Genus_Localised: 'Fungoida' },
        { Genus: '$Codex_Ent_Shrubs_Genus_Name;', Genus_Localised: 'Frutexa' },
        { Genus: '$Codex_Ent_Tussocks_Genus_Name;', Genus_Localised: 'Tussock' },
      ],
    }),
  );
const analyse = (t: BioTracker, genus: string, when: string) =>
  t.apply(
    ev({
      timestamp: when,
      event: 'ScanOrganic',
      ScanType: 'Analyse',
      Genus_Localised: genus,
      SystemAddress: HIP,
      Body: 25,
    }),
  );

test('a sample taken before the body was ever known still counts', () => {
  const t = new BioTracker();
  // The history sweep hands over the 2025 receipt first — no FSS/DSS event
  // from that session will ever be replayed, so the body is unknown here.
  analyse(t, 'Tussock', '2025-08-27T18:41:35Z');
  assert.deepEqual(t.leads(), []); // nothing known yet, so nothing to claim
  dss(t); // a year later, the DSS runs again
  const lead = t.leads()[0];
  assert.equal(lead.remaining, 3); // 4 genera less the Tussock already banked
  assert.deepEqual(t.uncollectedOn(HIP, 25), ['Bacterium', 'Fungoida', 'Frutexa']);
});

test('the whole real sequence lands on two remaining, not three', () => {
  const t = new BioTracker();
  analyse(t, 'Tussock', '2025-08-27T18:41:35Z'); // last year
  dss(t);
  analyse(t, 'Bacterium', '2026-08-12T19:11:22Z'); // today
  assert.deepEqual(t.uncollectedOn(HIP, 25), ['Fungoida', 'Frutexa']);
  assert.equal(t.leads()[0].remaining, 2);
});

test('receipts survive a restart, and the old array format upgrades', () => {
  const t = new BioTracker();
  analyse(t, 'Tussock', '2025-08-27T18:41:35Z');
  dss(t);
  const restored = new BioTracker();
  restored.load(JSON.parse(JSON.stringify(t.toJSON())));
  assert.deepEqual(restored.uncollectedOn(HIP, 25), ['Bacterium', 'Fungoida', 'Frutexa']);

  // Pre-history saves were a bare array with the receipt inside the body.
  const legacy = new BioTracker();
  legacy.load([
    {
      key: `${HIP}|25`,
      system: 'HIP 71120',
      body: 'HIP 71120 2 e',
      signals: 4,
      genuses: ['Bacterium', 'Fungoida', 'Frutexa', 'Tussock'],
      sampled: ['Tussock'],
      lastSeen: '2025-08-27T18:41:35Z',
    },
  ]);
  assert.deepEqual(legacy.uncollectedOn(HIP, 25), ['Bacterium', 'Fungoida', 'Frutexa']);
  // ...and the lifted receipt now survives the body being re-mapped.
  dss(legacy);
  assert.equal(legacy.leads()[0].remaining, 3);
});

test('a receipt for a genus this body does not have cannot mark it finished', () => {
  const t = new BioTracker();
  dss(t);
  for (const g of ['Bacterium', 'Fungoida', 'Frutexa', 'Osseus']) analyse(t, g, '2026-08-12T20:00:00Z');
  // Four receipts against four signals, but Osseus is not one of this body's
  // genera — counting receipts blindly would hide the Tussock still down there.
  assert.equal(t.leads()[0].remaining, 1);
  assert.deepEqual(t.uncollectedOn(HIP, 25), ['Tussock']);
});
