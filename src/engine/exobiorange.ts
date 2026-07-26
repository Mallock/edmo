/**
 * Exobiology sampling range — the "move 500 m before the next sample" helper.
 *
 * Odyssey requires three samples of the same species, and each genus has a
 * clonal-colony radius you must leave before the next one counts. Miss it and
 * the sample is rejected, which is the single most annoying way to lose time on
 * foot. The operator therefore states the distance the moment you take a
 * sample, and says when you have gone far enough.
 *
 * Pure module (no DOM/Tauri): ranges, great-circle distance on the body's own
 * radius, and a small state machine — unit-tested in tests/exobiorange.test.ts.
 */

/**
 * Clonal colony radius per genus, in metres. Keyed by the genus word as it
 * appears in the journal's localised names ("Bacterium Aurasus" → bacterium).
 */
const GENUS_RANGE_M: Record<string, number> = {
  aleoida: 150,
  amphora: 100,
  anemone: 100,
  bacterium: 500,
  brancae: 100,
  cactoida: 300,
  clypeus: 150,
  concha: 150,
  electricae: 1000,
  fonticulua: 500,
  frutexa: 150,
  fumerola: 100,
  fungoida: 300,
  osseus: 800,
  recepta: 150,
  stratum: 500,
  tubus: 800,
  tussock: 200,
};

/** Fallback when the genus is unknown — the largest common radius, so the
 *  operator never tells the commander to move *less* than the game requires. */
export const DEFAULT_RANGE_M = 1000;

/**
 * Base Vista Genomics payout per COMPLETED species set (three samples), in
 * credits. Ranges are the cheapest→dearest species within the genus, so the
 * operator can say what a landing is plausibly worth before committing to it.
 * A first-logged sample pays FIVE times these figures.
 *
 * Cross-checked against published community tables; treat as ballpark, not
 * gospel — Frontier has rebalanced these across Odyssey updates.
 */
const GENUS_VALUE: Record<string, { min: number; max: number }> = {
  aleoida: { min: 3_385_200, max: 7_252_500 },
  bacterium: { min: 1_000_000, max: 8_418_000 },
  cactoida: { min: 3_667_600, max: 16_202_800 },
  clypeus: { min: 8_418_000, max: 11_873_200 },
  concha: { min: 2_352_400, max: 4_572_400 },
  electricae: { min: 6_284_600, max: 6_284_600 },
  fonticulua: { min: 1_000_000, max: 3_111_000 },
  frutexa: { min: 1_632_500, max: 7_774_700 },
  fumerola: { min: 6_284_600, max: 16_202_800 },
  fungoida: { min: 1_670_100, max: 2_680_300 },
  osseus: { min: 3_156_300, max: 12_934_900 },
  recepta: { min: 12_934_900, max: 16_202_800 },
  stratum: { min: 1_362_000, max: 19_010_800 },
  tubus: { min: 5_727_600, max: 7_774_700 },
  tussock: { min: 1_766_600, max: 14_313_700 },
};

/** Payout range for a completed set of this genus, or null when unknown. */
export function genusValue(genusOrSpecies: string): { min: number; max: number } | null {
  const s = genusKey(genusOrSpecies);
  for (const [genus, v] of Object.entries(GENUS_VALUE)) if (s.includes(genus)) return v;
  return null;
}

/** "19.0M" / "3.2M" / "850k" — speakable, never a wall of digits. */
export function shortCredits(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`;
}

export interface BioHaulVerdict {
  /** One speakable line: what is down there, worth what, at what walk. */
  text: string;
  /** Best-case total across the listed genera, for the land/skip call. */
  bestTotal: number;
  /** The longest walk any of these genera will demand. */
  worstRangeM: number;
}

/**
 * Turn a DSS genus list into the decision the commander actually faces: is this
 * worth setting down for, and how much walking is it. `untouched` marks a body
 * nobody has scanned — a first log pays five times, which is the whole reason
 * to detour.
 */
export function describeBioHaul(genuses: readonly string[], untouched = false): BioHaulVerdict | null {
  const known = genuses.filter((g) => genusValue(g));
  if (!genuses.length) return null;
  const bestTotal = known.reduce((sum, g) => sum + (genusValue(g)?.max ?? 0), 0);
  const worstRangeM = genuses.reduce((m, g) => Math.max(m, requiredRangeM(g)), 0);
  const parts = genuses.map((g) => {
    const v = genusValue(g);
    const r = requiredRangeM(g);
    return v
      ? `${g} (${shortCredits(v.min)}–${shortCredits(v.max)}, ${r} m apart)`
      : `${g} (${r} m apart)`;
  });
  const head = `${genuses.length} species down there: ${parts.join(', ')}.`;
  const tail = untouched
    ? ` Nobody has scanned this one — a first log pays five times.`
    : bestTotal >= 10_000_000
      ? ` Up to about ${shortCredits(bestTotal)} for the full set.`
      : '';
  return { text: `${head}${tail}`, bestTotal, worstRangeM };
}

/**
 * The journal (and EDAstro) often give the codex SYMBOL rather than the pretty
 * name — `$Codex_Ent_Bacterial_Genus_Name;` for Bacterium, `Shrubs` for Frutexa.
 * Several of these do not contain their own genus word, so a naive substring
 * match silently falls through to the 1000 m default and sends the commander on
 * a walk twice as long as needed. Map the symbol stems explicitly.
 */
const SYMBOL_ALIASES: Array<[string, string]> = [
  ['bacterial', 'bacterium'],
  ['aleoids', 'aleoida'],
  ['cactoid', 'cactoida'],
  ['conchas', 'concha'],
  ['fonticulus', 'fonticulua'],
  ['shrubs', 'frutexa'],
  ['fungoids', 'fungoida'],
  ['fumerolas', 'fumerola'],
  ['tussocks', 'tussock'],
  ['stratum', 'stratum'],
  ['tubus', 'tubus'],
  ['osseus', 'osseus'],
  ['clypeus', 'clypeus'],
  ['recepta', 'recepta'],
  ['electricae', 'electricae'],
  // Non-Odyssey organics that still carry a 100 m colony spacing.
  ['brancae', 'brancae'],
  ['seed', 'brancae'], // Brain Tree species are $Codex_Ent_Seed_Name;
  ['tube', 'brancae'],
  ['sphere', 'anemone'],
];

/** Normalise a journal/EDAstro genus or species string to a table key. */
function genusKey(genusOrSpecies: string): string {
  const s = genusOrSpecies.toLowerCase();
  for (const [needle, key] of SYMBOL_ALIASES) if (s.includes(needle)) return key;
  return s;
}

/** Required separation for a species/genus string from the journal. */
export function requiredRangeM(genusOrSpecies: string): number {
  const s = genusKey(genusOrSpecies);
  for (const [genus, m] of Object.entries(GENUS_RANGE_M)) {
    if (s.includes(genus)) return m;
  }
  return DEFAULT_RANGE_M;
}

/** Great-circle distance across a body's surface, in metres. */
export function surfaceDistanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  radiusM: number,
): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Which of the three samples a ScanOrganic event actually is.
 *
 * The journal does not number them, and the obvious reading of ScanType is
 * wrong. For one species the real sequence is:
 *
 *   Log → Sample → Sample → Analyse
 *
 * The THIRD sample is another "Sample"; "Analyse" is the set completing a few
 * seconds later, not a fourth scan. So mapping the type straight to a number
 * can never reach three — it has to be counted per species.
 */
export class SampleCounter {
  private taken = new Map<string, number>();

  /**
   * Record a scan. Returns 1, 2 or 3 for a sample the commander just took, or
   * null for the closing Analyse (and for anything unrecognised).
   */
  note(species: string, scanType: string): number | null {
    if (scanType === 'Log') {
      this.taken.set(species, 1);
      return 1;
    }
    if (scanType === 'Sample') {
      const n = Math.min(3, (this.taken.get(species) ?? 1) + 1);
      this.taken.set(species, n);
      return n;
    }
    if (scanType === 'Analyse') this.taken.delete(species);
    return null;
  }

  /** How far along this species is, without recording anything. */
  progress(species: string): number {
    return this.taken.get(species) ?? 0;
  }

  /** New body or new session — partial progress no longer applies. */
  reset(): void {
    this.taken.clear();
  }
}

export interface SampleFix {
  species: string;
  requiredM: number;
  lat: number;
  lon: number;
  radiusM: number;
  /** Samples taken of this species so far (1 or 2 — the third completes it). */
  taken: number;
}

/** What the tracker wants said, if anything, after a position update. */
export interface RangeUpdate {
  kind: 'ready' | 'progress';
  species: string;
  distanceM: number;
  requiredM: number;
  remainingM: number;
}

/**
 * Tracks the walk away from the last sample. `sample()` arms it, `update()` is
 * fed live position; it announces "far enough" exactly once per sample, and
 * reports progress only when asked.
 */
export class SampleRangeTracker {
  private fix: SampleFix | null = null;
  private announced = false;

  /** A sample was taken here. `taken` is 1 or 2; the third completes the set. */
  sample(species: string, lat: number, lon: number, radiusM: number, taken: number): SampleFix {
    this.fix = { species, requiredM: requiredRangeM(species), lat, lon, radiusM, taken };
    this.announced = false;
    return this.fix;
  }

  /** The set is complete (or abandoned) — stop tracking. */
  clear(): void {
    this.fix = null;
    this.announced = false;
  }

  active(): SampleFix | null {
    return this.fix;
  }

  /**
   * Feed the current surface position. Returns a `ready` update the first time
   * the required distance is cleared, a `progress` update while short of it,
   * and null when nothing is being tracked.
   */
  update(lat: number, lon: number): RangeUpdate | null {
    if (!this.fix) return null;
    const distanceM = surfaceDistanceM(this.fix.lat, this.fix.lon, lat, lon, this.fix.radiusM);
    const remainingM = Math.max(0, this.fix.requiredM - distanceM);
    if (distanceM >= this.fix.requiredM) {
      if (this.announced) return null; // said once, never nag
      this.announced = true;
      return { kind: 'ready', species: this.fix.species, distanceM, requiredM: this.fix.requiredM, remainingM: 0 };
    }
    return { kind: 'progress', species: this.fix.species, distanceM, requiredM: this.fix.requiredM, remainingM };
  }
}

export interface BioSale {
  /** Credits banked, base value plus first-log bonus. */
  total: number;
  /** Base value alone — what the samples would pay with no first log. */
  base: number;
  /** The first-log bonus portion; four times base for every first-footfall. */
  bonus: number;
  /** Species sold, richest first, e.g. "Tubus Cavas". */
  species: string[];
  /** How many of them carried a first-log bonus. */
  firstLogs: number;
}

/**
 * Read a SellOrganicData event.
 *
 * The journal does NOT give a total here — unlike SellExplorationData there is
 * no TotalEarnings field, so the payout has to be summed out of BioData. And
 * the headline "five times" figure a commander sees at the counter is
 * Value + Bonus, not Value × 5: Bonus is already the extra four parts.
 */
export function parseBioSale(bioData: unknown): BioSale | null {
  if (!Array.isArray(bioData) || !bioData.length) return null;
  let base = 0;
  let bonus = 0;
  let firstLogs = 0;
  const rows: Array<{ name: string; worth: number }> = [];
  for (const raw of bioData) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const value = typeof r.Value === 'number' ? r.Value : 0;
    const b = typeof r.Bonus === 'number' ? r.Bonus : 0;
    base += value;
    bonus += b;
    if (b > 0) firstLogs += 1;
    const name =
      (typeof r.Species_Localised === 'string' && r.Species_Localised) ||
      (typeof r.Genus_Localised === 'string' && r.Genus_Localised) ||
      'an organism';
    rows.push({ name, worth: value + b });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => b.worth - a.worth);
  // The same species can be sold from several bodies; name each one once.
  const species = [...new Set(rows.map((r) => r.name))];
  return { total: base + bonus, base, bonus, species, firstLogs };
}

/** Speakable summary of a Vista Genomics hand-in. */
export function describeBioSale(s: BioSale): string {
  const head = `${shortCredits(s.total)} from Vista Genomics`;
  const what =
    s.species.length === 1
      ? ` for the ${s.species[0]}`
      : ` for ${s.species.length} species — ${s.species.slice(0, 3).join(', ')}${
          s.species.length > 3 ? ' and more' : ''
        }`;
  const first = s.firstLogs
    ? `. ${s.firstLogs === s.species.length ? 'Every one' : `${s.firstLogs} of them`} a first log, which is ${shortCredits(s.bonus)} of that.`
    : '.';
  return `${head}${what}${first}`;
}
