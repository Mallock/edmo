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
