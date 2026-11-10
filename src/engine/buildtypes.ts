/**
 * What a build costs before you have committed to it.
 *
 * `architect.ts` is a tracker: it can tell the commander everything about a
 * depot that already exists, and nothing at all about one that does not. That
 * is the wrong way round for deep-space colonisation, where the expensive
 * decision — which facility goes in which slot, and in what order — is made
 * before a single ton is hauled. A Coriolis is 53,723 t; an Orbis is 209,122 t.
 * Finding that out by placing one is an expensive way to learn.
 *
 * Two things live here.
 *
 * THE CATALOGUE. Tonnage, tier points and system effects for every buildable
 * facility. The numbers are game facts, taken from DaftMav's community
 * spreadsheet "Colonization Construction v3" v3.4.1 (current as of the Dodec
 * Update and Trailblazers Update 3), whose "Total amount of Commodities"
 * column is what `tons` means here:
 *   https://docs.google.com/spreadsheets/d/1jsZOzNJSnPIWlU88puOc9gQXvsw-MGp8meoQ6k-Yj-Y
 *
 * THE FINGERPRINT. The far more useful half, and the reason the catalogue is
 * worth carrying at all: a depot's TOTAL required tonnage identifies what is
 * being built, exactly. The commander's own HIP 71120 site wants 21,835 t —
 * which is 18,988 t (an outpost) times the 1.1499 surcharge the game puts on a
 * system's first station. The game never tells you which facility a depot is;
 * the panel now says "primary Commercial Outpost" from a number the depot
 * event has been carrying all along.
 *
 * DELIBERATELY ABSENT: landing-pad size. It is not in the source data, and
 * `architect.ts` already carries a hard-won comment about what happens when
 * this panel guesses at pads. A missing field is a gap; a wrong one turns a
 * commander away from a pad they are standing on.
 *
 * Pure module — unit-tested in tests/buildtypes.test.ts.
 */

/** Orbital slot or planetary slot — they are not interchangeable. */
export type BuildSlot = 'space' | 'ground';

/**
 * Tier points, as a build spends and earns them.
 *
 * Positive earns, negative spends, and `'port'` means "this is a port, and its
 * point cost climbs with every port already standing in the system". That
 * escalation curve is NOT modelled here: the honest answer is that the panel
 * knows it grows and does not know by how much, which is what the label says.
 */
export type TierPoints = number | 'port';

/** What a facility does to the system once it is standing. */
export interface BuildEffects {
  initialPopulation: number;
  maxPopulation: number;
  security: number;
  techLevel: number;
  wealth: number;
  standardOfLiving: number;
  developmentLevel: number;
  /** The flat per-facility figure the weekly architect dividend pays on. */
  systemScore: number;
}

export interface BuildType {
  key: string;
  name: string;
  slot: BuildSlot;
  /** Total commodity tonnage for a non-primary build of this type. */
  tons: number;
  /**
   * Tonnage of the SAME facility built as a system's first station.
   *
   * Stated as tons rather than as the surcharge ratio, because the ratio loses
   * the answer. The ratio for an outpost rounds to 0.1499, and 18,988 × 1.1499
   * is 21,834.3 — while the commander's own panel at HIP 71120 reads 21,835.
   * One ton is the difference between identifying their build and shrugging at
   * it, so the integers are carried directly.
   *
   * Null means the facility cannot be a first station at all.
   */
  primaryTons: number | null;
  t2: TierPoints;
  t3: TierPoints;
  /** Facility keys that must already stand in the system before this one. */
  dependencies: string[];
  effects: BuildEffects;
}

interface Row {
  key: string;
  slot: BuildSlot;
  tons: number;
  ip?: number;
  mp?: number;
  sec?: number;
  tl?: number;
  w?: number;
  sol?: number;
  dl?: number;
  score?: number;
  t2?: TierPoints;
  t3?: TierPoints;
  deps?: string[];
  /** First-station tonnage. Omitted where the facility cannot be one. */
  primary?: number;
}

/** `Orbis_or_Ocellus` is a key; "Orbis / Ocellus" is what a commander reads. */
const label = (key: string): string => key.replace(/_or_/g, ' / ').replace(/_/g, ' ');

const build = (r: Row): [string, BuildType] => [
  r.key,
  {
    key: r.key,
    name: label(r.key),
    slot: r.slot,
    tons: r.tons,
    primaryTons: r.primary ?? null,
    t2: r.t2 ?? 0,
    t3: r.t3 ?? 0,
    dependencies: r.deps ?? [],
    effects: {
      initialPopulation: r.ip ?? 0,
      maxPopulation: r.mp ?? 0,
      security: r.sec ?? 0,
      techLevel: r.tl ?? 0,
      wealth: r.w ?? 0,
      standardOfLiving: r.sol ?? 0,
      developmentLevel: r.dl ?? 0,
      systemScore: r.score ?? 0,
    },
  },
];

export const BUILD_TYPES: Record<string, BuildType> = Object.fromEntries([
  // --- orbital ports: the ones that cost a fortune and change a system ---
  // Orbis and Dodecahedron primaries are the only two derived rather than read:
  // the sheet publishes their surcharge to four decimals and not the integer,
  // so these are good to about a ton. PRIMARY_TOLERANCE exists for them.
  build({ key: 'Orbis_or_Ocellus', slot: 'space', tons: 209122, ip: 5, mp: 1, sec: -3, tl: 7, w: 8, sol: 5, dl: 9, score: 15, t2: 0, t3: 'port', primary: 242749 }),
  build({ key: 'Dodecahedron', slot: 'space', tons: 236304, ip: 8, mp: 4, sec: -4, tl: 8, w: 9, sol: 7, dl: 10, score: 15, t2: 0, t3: 'port', primary: 269930 }),
  // 70,533 is the sheet's own primary row, not a computed figure.
  build({ key: 'Coriolis', slot: 'space', tons: 53723, ip: 1, mp: 1, sec: -2, tl: 2, w: 3, sol: 3, dl: 3, score: 8, t2: 'port', t3: 1, primary: 70533 }),
  build({ key: 'Asteroid_Base', slot: 'space', tons: 53723, ip: 1, mp: 1, sec: -1, tl: 3, w: 5, sol: -4, dl: 7, score: 8, t2: 'port', t3: 1, primary: 70533 }),

  // --- orbital outposts: the usual first station ---
  // 21,835 is first-hand: the commander's own primary outpost at HIP 71120
  // states exactly that on its contribution panel. The Industrial Outpost is
  // a ton cheaper at every size, so its primary is derived as one ton less.
  build({ key: 'Commercial_Outpost', slot: 'space', tons: 18988, ip: 1, mp: 1, sec: -1, w: 3, sol: 5, score: 3, t2: 1, primary: 21835 }),
  build({ key: 'Industrial_Outpost', slot: 'space', tons: 18987, ip: 1, mp: 1, tl: 3, dl: 3, score: 3, t2: 1, primary: 21834 }),
  build({ key: 'Criminal_Outpost', slot: 'space', tons: 18988, ip: 1, mp: 1, sec: -2, w: 3, score: 3, t2: 1, primary: 21835 }),
  build({ key: 'Civilian_Outpost', slot: 'space', tons: 18988, ip: 1, mp: 1, sec: -1, w: 1, sol: 2, dl: 1, score: 3, t2: 1, primary: 21835 }),
  build({ key: 'Scientific_Outpost', slot: 'space', tons: 18988, ip: 1, mp: 1, tl: 3, score: 3, t2: 1, primary: 21835 }),
  build({ key: 'Military_Outpost', slot: 'space', tons: 18988, ip: 1, mp: 1, sec: 2, score: 3, t2: 1, primary: 21835 }),

  // --- orbital installations: cheap tier-2 points ---
  build({ key: 'Satellite', slot: 'space', tons: 6721, sol: 1, dl: 2, score: 3, t2: 1 }),
  build({ key: 'Communication_Station', slot: 'space', tons: 6721, sec: 1, tl: 3, score: 3, t2: 1 }),
  build({ key: 'Space_Farm', slot: 'space', tons: 6722, sol: 5, dl: 1, score: 2, t2: 1 }),
  build({ key: 'Pirate_Base', slot: 'space', tons: 6721, sec: -4, w: 4, score: 3, t2: 1 }),
  build({ key: 'Mining_Outpost', slot: 'space', tons: 6723, w: 4, sol: -2, score: 2, t2: 1 }),
  build({ key: 'Relay_Station', slot: 'space', tons: 6721, sec: 1, dl: 1, score: 3, t2: 1 }),

  // --- orbital installations that SPEND a tier-2 point to earn a tier-3 ---
  build({ key: 'Military', slot: 'space', tons: 10080, sec: 7, score: 4, t2: -1, t3: 1, deps: ['Small_Military_Settlement', 'Medium_Military_Settlement', 'Large_Military_Settlement'] }),
  build({ key: 'Security_Station', slot: 'space', tons: 10082, sec: 9, sol: 3, dl: 3, score: 3, t2: -1, t3: 1, deps: ['Relay_Station'] }),
  build({ key: 'Government', slot: 'space', tons: 10077, sec: 2, sol: 7, dl: 3, score: 3, t2: -1, t3: 1 }),
  build({ key: 'Medical', slot: 'space', tons: 10081, tl: 3, sol: 5, score: 4, t2: -1, t3: 1 }),
  build({ key: 'Research_Station', slot: 'space', tons: 10083, tl: 8, dl: 3, score: 4, t2: -1, t3: 1, deps: ['Small_Scientific_Settlement', 'Medium_Scientific_Settlement', 'Large_Scientific_Settlement'] }),
  build({ key: 'Tourist', slot: 'space', tons: 10087, sec: -3, sol: 6, dl: 3, score: 3, t2: -1, t3: 1, deps: ['Small_Tourism_Settlement', 'Medium_Tourism_Settlement', 'Large_Tourism_Settlement'] }),
  build({ key: 'Space_Bar', slot: 'space', tons: 10076, sec: -2, sol: 3, score: 4, t2: -1, t3: 1 }),

  // --- planetary ports and outposts ---
  build({ key: 'Planetary_Port', slot: 'ground', tons: 216030, ip: 10, mp: 10, sec: -3, tl: 5, w: 5, sol: 7, dl: 10, score: 15, t2: 0, t3: 'port' }),
  build({ key: 'Civilian_Planetary_Outpost', slot: 'ground', tons: 36829, ip: 2, mp: 1, sec: -2, sol: 3, score: 4, t2: 1 }),
  build({ key: 'Industrial_Planetary_Outpost', slot: 'ground', tons: 36829, ip: 1, mp: 1, sec: -1, w: 3, score: 4, t2: 1 }),
  build({ key: 'Scientific_Planetary_Outpost', slot: 'ground', tons: 36829, ip: 1, mp: 1, sec: -1, tl: 5, dl: 1, score: 4, t2: 1 }),

  // --- surface hubs ---
  build({ key: 'Extraction_Hub', slot: 'ground', tons: 9893, ip: 1, mp: 1, w: 10, sol: -4, dl: 3, score: 5, t2: -1, t3: 1, deps: ['Small_Extraction_Settlement', 'Medium_Extraction_Settlement', 'Large_Extraction_Settlement'] }),
  build({ key: 'Civilian_Hub', slot: 'ground', tons: 9772, ip: 1, mp: 1, sec: -3, sol: 3, dl: 3, score: 5, t2: -1, t3: 1, deps: ['Small_Agricultural_Settlement', 'Medium_Agricultural_Settlement', 'Large_Agricultural_Settlement'] }),
  build({ key: 'Exploration_Hub', slot: 'ground', tons: 9923, ip: 1, mp: 1, sec: -1, tl: 7, dl: 3, score: 5, t2: -1, t3: 1, deps: ['Communication_Station'] }),
  build({ key: 'Outpost_Hub', slot: 'ground', tons: 9198, ip: 1, mp: 1, sec: -2, sol: 3, dl: 3, score: 5, t2: -1, t3: 1, deps: ['Space_Farm'] }),
  build({ key: 'Scientific_Hub', slot: 'ground', tons: 9924, ip: 1, mp: 1, tl: 10, score: 5, t2: -1, t3: 1 }),
  build({ key: 'Military_Hub', slot: 'ground', tons: 9922, ip: 1, mp: 1, sec: 10, score: 5, t2: -1, t3: 1, deps: ['Military'] }),
  build({ key: 'Refinery_Hub', slot: 'ground', tons: 9919, ip: 1, mp: 1, sec: -1, tl: 3, w: 5, sol: -2, dl: 7, score: 5, t2: -1, t3: 1 }),
  build({ key: 'High_Tech_Hub', slot: 'ground', tons: 9921, ip: 1, mp: 1, sec: -2, tl: 10, w: 3, score: 5, t2: -1, t3: 1 }),
  build({ key: 'Industrial_Hub', slot: 'ground', tons: 9753, ip: 1, mp: 1, tl: 3, w: 5, sol: -4, dl: 3, score: 5, t2: -1, t3: 1, deps: ['Mining_Outpost'] }),

  // --- surface settlements ---
  build({ key: 'Small_Agricultural_Settlement', slot: 'ground', tons: 2839, ip: 1, mp: 1, sol: 3, score: 1, t2: 1 }),
  build({ key: 'Medium_Agricultural_Settlement', slot: 'ground', tons: 5678, ip: 1, mp: 1, sol: 7, score: 2, t2: 1 }),
  build({ key: 'Large_Agricultural_Settlement', slot: 'ground', tons: 8517, ip: 1, mp: 1, sol: 10, score: 4, t2: -1, t3: 2 }),
  build({ key: 'Small_Extraction_Settlement', slot: 'ground', tons: 2845, ip: 1, mp: 1, w: 3, score: 1, t2: 1 }),
  build({ key: 'Medium_Extraction_Settlement', slot: 'ground', tons: 5690, ip: 1, mp: 1, w: 5, score: 2, t2: 1 }),
  build({ key: 'Large_Extraction_Settlement', slot: 'ground', tons: 8535, ip: 1, mp: 1, tl: 2, w: 8, sol: -2, score: 4, t2: -1, t3: 2 }),
  build({ key: 'Small_Industrial_Settlement', slot: 'ground', tons: 2845, ip: 1, mp: 1, dl: 3, score: 1, t2: 1 }),
  build({ key: 'Medium_Industrial_Settlement', slot: 'ground', tons: 5690, ip: 1, mp: 1, dl: 6, score: 2, t2: 1 }),
  build({ key: 'Large_Industrial_Settlement', slot: 'ground', tons: 8535, ip: 1, mp: 1, w: 3, dl: 9, score: 4, t2: -1, t3: 2 }),
  build({ key: 'Small_Military_Settlement', slot: 'ground', tons: 2842, ip: 1, mp: 1, sec: 2, score: 1, t2: 1 }),
  build({ key: 'Medium_Military_Settlement', slot: 'ground', tons: 5684, ip: 1, mp: 1, sec: 4, score: 2, t2: 1 }),
  build({ key: 'Large_Military_Settlement', slot: 'ground', tons: 8526, ip: 1, mp: 1, sec: 7, dl: 3, score: 4, t2: -1, t3: 2 }),
  build({ key: 'Small_Scientific_Settlement', slot: 'ground', tons: 2841, ip: 1, mp: 1, tl: 3, dl: 1, score: 2, t2: -1, t3: 1 }),
  build({ key: 'Medium_Scientific_Settlement', slot: 'ground', tons: 5682, ip: 1, mp: 1, tl: 7, dl: 1, score: 2, t2: -1, t3: 1 }),
  build({ key: 'Large_Scientific_Settlement', slot: 'ground', tons: 8523, ip: 1, mp: 1, tl: 10, dl: 3, score: 4, t2: -1, t3: 2 }),
  build({ key: 'Small_Tourism_Settlement', slot: 'ground', tons: 2846, ip: 1, mp: 1, sec: -1, w: 1, score: 1, t2: -1, t3: 1, deps: ['Satellite'] }),
  build({ key: 'Medium_Tourism_Settlement', slot: 'ground', tons: 5692, ip: 1, mp: 1, sec: -1, w: 3, score: 2, t2: -1, t3: 1, deps: ['Satellite'] }),
  build({ key: 'Large_Tourism_Settlement', slot: 'ground', tons: 8538, ip: 1, mp: 1, sec: -1, w: 5, score: 4, t2: -1, t3: 2, deps: ['Satellite'] }),
]);

export const ALL_BUILD_TYPES: BuildType[] = Object.values(BUILD_TYPES);

/** Tonnage of this facility as a system's first station, or null if it cannot be one. */
export function primaryTons(t: BuildType): number | null {
  return t.primaryTons;
}

/** What the depot's total tonnage says is being built. */
export interface BuildGuess {
  /** The tonnage that was matched. */
  tons: number;
  /** True when the match was against the first-station surcharge. */
  primary: boolean;
  /**
   * Every facility with this exact cost.
   *
   * Usually more than one and that is not a failure: the six orbital outposts
   * cost 18,988 t apiece, so 18,988 t genuinely means "an outpost" and nothing
   * finer. Saying "one of six outposts" is right; picking one at random is not.
   */
  types: BuildType[];
}

/**
 * Ordinary costs match EXACTLY. They have to.
 *
 * The hubs run 9,919 / 9,921 / 9,922 / 9,923 / 9,924 — five distinct builds
 * inside six tons. A tolerance of even one ton chains them together and turns
 * "you are building a High Tech Hub" into "you are building one of three
 * things", which is worse than the exact answer the data can actually give.
 */
const TOLERANCE = 0;

/**
 * First-station costs get two tons of slack, and only they do.
 *
 * Two of them (Orbis, Dodecahedron) are derived from a four-decimal surcharge
 * rather than read off an integer row, so they carry about a ton of doubt. The
 * primaries are thousands of tons apart, so the slack cannot blur anything.
 */
const PRIMARY_TOLERANCE = 2;

/**
 * Identify a build from the one number the depot always states.
 *
 * `ColonisationConstructionDepot` never names the facility. It does state every
 * commodity's RequiredAmount, and the sum of those is a fingerprint: 21,835 t
 * is a primary outpost, 53,723 t is a Coriolis or an asteroid base, 209,122 t
 * is an Orbis. The panel has been carrying this number since the first build
 * and calling it nothing more than a progress bar denominator.
 *
 * Pass the TOTAL REQUIRED tonnage, not what is outstanding — a half-built site
 * fingerprints as itself, a half-built site's remainder fingerprints as
 * nothing.
 */
export function identifyBuild(totalRequiredTons: number): BuildGuess | null {
  if (!Number.isFinite(totalRequiredTons) || totalRequiredTons <= 0) return null;
  const plain = ALL_BUILD_TYPES.filter((t) => Math.abs(t.tons - totalRequiredTons) <= TOLERANCE);
  if (plain.length) return { tons: totalRequiredTons, primary: false, types: plain };
  const first = ALL_BUILD_TYPES.filter(
    (t) => t.primaryTons != null && Math.abs(t.primaryTons - totalRequiredTons) <= PRIMARY_TOLERANCE,
  );
  if (first.length) return { tons: totalRequiredTons, primary: true, types: first };
  return null;
}

/** Tier points as a commander reads them: "+1 T2", "costs 1 T2, +1 T3". */
export function describePoints(t: BuildType): string {
  const bits: string[] = [];
  const say = (p: TierPoints, tier: string): void => {
    if (p === 'port') bits.push(`costs port points at tier ${tier}`);
    else if (p > 0) bits.push(`+${p} T${tier}`);
    else if (p < 0) bits.push(`−${Math.abs(p)} T${tier}`);
  };
  say(t.t2, '2');
  say(t.t3, '3');
  return bits.length ? bits.join(', ') : 'no tier points';
}

/** One line naming what a depot is building, or null when nothing matches. */
export function describeBuild(guess: BuildGuess | null): string | null {
  if (!guess) return null;
  const tons = Math.round(guess.tons).toLocaleString('en-US');
  const lead = guess.primary ? 'the system’s first station' : null;
  if (guess.types.length === 1) {
    const t = guess.types[0];
    return `${tons} t — ${lead ? `${lead}: a ` : ''}${t.name}${lead ? '' : ''} (${describePoints(t)}).`;
  }
  // A shared cost is a family, and the family name is the honest answer.
  const names = guess.types.map((t) => t.name);
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? `, or ${names.length - 3} more` : '';
  return `${tons} t — ${lead ? `${lead}, one of: ` : 'one of: '}${shown}${more} (${describePoints(
    guess.types[0],
  )} either way).`;
}

/**
 * What one facility's commodity list looked like last time, keyed by its cost.
 *
 * The catalogue knows a Coriolis is 53,723 t. It does NOT know that 4,398 t of
 * that is steel — nobody publishes the breakdown, and it differs by build type
 * rather than by system. But the commander reads exactly that breakdown off
 * the contribution panel every time they start one, and throwing it away means
 * the second Coriolis is planned as blindly as the first.
 *
 * So the library keys on the same fingerprint `identifyBuild` uses. A depot
 * seen once can be predicted the next time one of the same cost appears —
 * before the commander has flown to it, and from their own data rather than
 * anybody's table.
 */
export interface LearnedBuild {
  /** Total required tonnage — the fingerprint, and the key. */
  tons: number;
  /** Commodity key → tons required. */
  lines: Array<{ key: string; name: string; required: number }>;
  /** Where it was learned, so the panel can say whose list this is. */
  station: string | null;
  system: string | null;
  at: string;
}

export class BuildLibrary {
  private byTons = new Map<number, LearnedBuild>();

  /** Remember this requirement, replacing any older reading of the same cost. */
  learn(entry: LearnedBuild): boolean {
    if (!entry.tons || !entry.lines.length) return false;
    const held = this.byTons.get(entry.tons);
    // A later reading of the same build type wins: the game rebalances costs,
    // and a stale breakdown is worse than none precisely because it looks real.
    if (held && Date.parse(held.at) >= Date.parse(entry.at)) return false;
    this.byTons.set(entry.tons, entry);
    return true;
  }

  /** The predicted shopping list for a build of this total cost. */
  predict(tons: number): LearnedBuild | null {
    for (const [t, entry] of this.byTons) if (Math.abs(t - tons) <= TOLERANCE) return entry;
    return null;
  }

  get all(): LearnedBuild[] {
    return [...this.byTons.values()].sort((a, b) => b.tons - a.tons);
  }

  toJSON(): { builds: LearnedBuild[] } {
    return { builds: this.all };
  }

  load(d: { builds?: LearnedBuild[] } | null): void {
    if (!d || !Array.isArray(d.builds)) return;
    for (const b of d.builds) {
      if (!b || typeof b !== 'object' || !Array.isArray(b.lines)) continue;
      if (typeof b.tons !== 'number' || b.tons <= 0) continue;
      this.byTons.set(b.tons, b);
    }
  }
}
