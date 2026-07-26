/** Exobiology sampling range — genus distances, surface geometry, announce-once. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requiredRangeM,
  surfaceDistanceM,
  SampleRangeTracker,
  DEFAULT_RANGE_M,
  describeBioHaul,
  genusValue,
} from '../src/engine/exobiorange.ts';

test('genus ranges are read from the localised species name', () => {
  assert.equal(requiredRangeM('Bacterium Aurasus'), 500);
  assert.equal(requiredRangeM('Stratum Tectonicas'), 500);
  assert.equal(requiredRangeM('Osseus Fractus'), 800);
  assert.equal(requiredRangeM('Tubus Conifer'), 800);
  assert.equal(requiredRangeM('Electricae Radialem'), 1000);
  assert.equal(requiredRangeM('Tussock Pennata'), 200);
  assert.equal(requiredRangeM('Fumerola Carbosis'), 100);
  assert.equal(requiredRangeM('frutexa flabellum'), 150); // case-insensitive
  // Unknown genus errs LARGE: never tell the commander to move less than the
  // game demands, or the sample is rejected and the walk was wasted.
  assert.equal(requiredRangeM('Whatsit Novum'), DEFAULT_RANGE_M);
});

test('surface distance is a great circle on the body radius', () => {
  const R = 1_000_000; // 1000 km body
  assert.equal(Math.round(surfaceDistanceM(10, 20, 10, 20, R)), 0);
  // One degree of latitude on this body = R * pi/180 ≈ 17 453 m.
  assert.ok(Math.abs(surfaceDistanceM(0, 0, 1, 0, R) - 17453) < 5);
  // Longitude degrees shrink toward the poles.
  const atEquator = surfaceDistanceM(0, 0, 0, 1, R);
  const atSixty = surfaceDistanceM(60, 0, 60, 1, R);
  assert.ok(atSixty < atEquator * 0.55 && atSixty > atEquator * 0.45, 'cos(60°) ≈ 0.5');
});

test('tracker announces "far enough" exactly once, then stays quiet', () => {
  const R = 2_000_000;
  const t = new SampleRangeTracker();
  const fix = t.sample('Bacterium Aurasus', 0, 0, R, 1);
  assert.equal(fix.requiredM, 500);
  assert.equal(t.active()?.taken, 1);

  // Still short: reports progress with what is left to walk.
  const near = t.update(0.005, 0); // ≈175 m
  assert.equal(near?.kind, 'progress');
  assert.ok(near!.distanceM > 100 && near!.distanceM < 250);
  assert.ok(near!.remainingM > 0);

  // Past the colony radius: ready, once.
  const far = t.update(0.02, 0); // ≈700 m
  assert.equal(far?.kind, 'ready');
  assert.ok(far!.distanceM >= 500);
  assert.equal(far!.remainingM, 0);
  assert.equal(t.update(0.03, 0), null, 'never repeats the all-clear');

  // A fresh sample re-arms it.
  t.sample('Bacterium Aurasus', 0.03, 0, R, 2);
  assert.equal(t.update(0.031, 0)?.kind, 'progress');

  t.clear();
  assert.equal(t.active(), null);
  assert.equal(t.update(1, 1), null);
});

test('a DSS genus list becomes a land-or-skip verdict', () => {
  // The big one: Stratum tops out near 19M and wants a 500 m walk.
  const rich = describeBioHaul(['Stratum', 'Bacterium'])!;
  assert.match(rich.text, /2 species/);
  assert.match(rich.text, /Stratum \(1\.4M–19\.0M, 500 m apart\)/);
  assert.match(rich.text, /Bacterium/);
  assert.equal(rich.worstRangeM, 500);
  assert.ok(rich.bestTotal > 25_000_000);
  assert.match(rich.text, /Up to about/); // worth the detour, so say so

  // Untouched bodies lead with the 5x hook instead of the total.
  const virgin = describeBioHaul(['Tussock'], true)!;
  assert.match(virgin.text, /first log pays five times/);

  // A modest single find states itself without overselling.
  const small = describeBioHaul(['Fonticulua'])!;
  assert.match(small.text, /Fonticulua \(1\.0M–3\.1M, 500 m apart\)/);
  assert.doesNotMatch(small.text, /Up to about/);

  // Unknown genus still gets its (conservative) walking distance.
  const odd = describeBioHaul(['Whatsit'])!;
  assert.match(odd.text, /Whatsit \(1000 m apart\)/);
  assert.equal(describeBioHaul([]), null);
});

test('codex symbol names resolve — the journal does not always send pretty names', () => {
  // Real strings seen from EDAstro/the journal. Several do not contain their
  // own genus word, so a naive substring match would fall to the 1000 m default
  // and send the commander on twice the walk.
  assert.equal(requiredRangeM('$Codex_Ent_Bacterial_Genus_Name;'), 500);
  assert.equal(requiredRangeM('$Codex_Ent_Bacterial_06_Name;'), 500); // Bacterium Alcyoneum
  assert.equal(requiredRangeM('$Codex_Ent_Tussocks_Genus_Name;'), 200);
  assert.equal(requiredRangeM('$Codex_Ent_Shrubs_Genus_Name;'), 150); // Frutexa
  assert.equal(requiredRangeM('$Codex_Ent_Aleoids_Genus_Name;'), 150);
  assert.equal(requiredRangeM('$Codex_Ent_Cactoid_Genus_Name;'), 300);
  assert.equal(requiredRangeM('$Codex_Ent_Fonticulus_Genus_Name;'), 500);
  assert.equal(requiredRangeM('$Codex_Ent_Fungoids_Genus_Name;'), 300);
  assert.equal(requiredRangeM('$Codex_Ent_Conchas_Genus_Name;'), 150);
  assert.equal(requiredRangeM('$Codex_Ent_Osseus_Genus_Name;'), 800);
  // Pretty names must keep working.
  assert.equal(requiredRangeM('Bacterium Alcyoneum'), 500);
  // Values resolve through the same normalisation.
  assert.equal(genusValue('$Codex_Ent_Stratum_Genus_Name;')?.max, 19_010_800);
  assert.equal(genusValue('$Codex_Ent_Bacterial_Genus_Name;')?.min, 1_000_000);
});
