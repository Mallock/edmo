/**
 * Where the commander actually is, in words the operator can use.
 *
 * The persona used to state two things as immovable fact in EVERY prompt: that
 * the commander "operates in the COLONIA REGION", and that the operator works
 * "a cramped comms office on Jaques Station — twenty years flying these lanes".
 * Both were written when the app only ever ran in Colonia. They are the only
 * concrete place-nouns the model is ever handed, so it reaches for them
 * constantly — a commander watching it work described the result exactly:
 * it "just babbles about only one thing, station and lanes".
 *
 * Two fixes live here. The prompt gets REAL local material to talk about
 * instead, and the operator's own post follows the region rather than pinning
 * a Bubble run to a station 22,000 ly away.
 *
 * The operator does NOT teleport. They hold one post in inhabited space; when
 * the commander goes deep the post stays put and the distance becomes the
 * point, which is the right register for an expedition anyway.
 *
 * Coordinates come from the journal — FSDJump/Location/CarrierJump all carry
 * StarPos — and the app was throwing them away entirely.
 *
 * Pure module — unit-tested in tests/place.test.ts.
 */

export interface Coords {
  x: number;
  y: number;
  z: number;
}

export type RegionKey = 'bubble' | 'pleiades' | 'colonia' | 'deep' | 'unknown';

interface Anchor {
  key: Exclude<RegionKey, 'deep' | 'unknown'>;
  name: string;
  coords: Coords;
  /** Within this many ly counts as being IN the region. */
  radius: number;
}

/** Verified against live system coordinates rather than memory. */
export const SOL: Coords = { x: 0, y: 0, z: 0 };
export const COLONIA: Coords = { x: -9530.5, y: -910.28125, z: 19808.125 };
export const MAIA: Coords = { x: -81.78125, y: -149.4375, z: -343.375 };
export const SAG_A: Coords = { x: 25.21875, y: -20.90625, z: 25899.96875 };

const ANCHORS: readonly Anchor[] = [
  // Order matters only for ties; the Pleiades sit inside no other radius.
  { key: 'bubble', name: 'the core systems (the Bubble)', coords: SOL, radius: 200 },
  { key: 'pleiades', name: 'the Pleiades', coords: MAIA, radius: 100 },
  { key: 'colonia', name: 'the Colonia Region', coords: COLONIA, radius: 300 },
];

export interface Place {
  system: string;
  coords: Coords | null;
  region: RegionKey;
  /** Human name of the region, or of the nearest one when out in the black. */
  regionName: string;
  lyFromSol: number | null;
  lyFromColonia: number | null;
  /** Nearest inhabited anchor and the distance to it. */
  nearest: { key: Anchor['key']; name: string; ly: number } | null;
}

export function distanceLy(a: Coords, b: Coords): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const round = (n: number): number => Math.round(n);
const ly = (n: number): string => `${round(n).toLocaleString('en-US')} ly`;

/** Classify a position. Without coordinates the region is UNKNOWN, never assumed. */
export function placeOf(system: string, coords: Coords | null): Place {
  if (!coords) {
    return {
      system,
      coords: null,
      region: 'unknown',
      regionName: 'unknown space',
      lyFromSol: null,
      lyFromColonia: null,
      nearest: null,
    };
  }
  const ranked = ANCHORS.map((a) => ({ a, d: distanceLy(coords, a.coords) })).sort((p, q) => p.d - q.d);
  const closest = ranked[0];
  const inside = ranked.find(({ a, d }) => d <= a.radius);
  return {
    system,
    coords,
    region: inside ? inside.a.key : 'deep',
    // Deep space is its OWN place, not a distant suburb of the nearest anchor.
    // Falling back to the anchor's name announced Beagle Point as being "in the
    // Colonia Region" — 46,000 ly away from it.
    regionName: inside ? inside.a.name : 'deep space',
    lyFromSol: distanceLy(coords, SOL),
    lyFromColonia: distanceLy(coords, COLONIA),
    nearest: { key: closest.a.key, name: closest.a.name, ly: closest.d },
  };
}

/**
 * The setting sentence for the lore primer — what used to be a hardcoded claim
 * that the commander lives in Colonia.
 */
export function loreForPlace(place: Place): string {
  switch (place.region) {
    case 'bubble':
      return (
        'The commander is operating in the CORE SYSTEMS — the Bubble, the old inhabited sphere ' +
        'around Sol: dense traffic, Federation, Empire and Alliance politics everywhere, a station ' +
        'in every second system.'
      );
    case 'colonia':
      return (
        'The commander is operating in the COLONIA REGION — a frontier colony cluster 22,000 ' +
        'light-years from the core human Bubble, grown around Jaques Station since 3302: ' +
        'independent, remote, self-reliant; Federation, Empire and Alliance politics are distant ' +
        'rumors out here.'
      );
    case 'pleiades':
      return (
        'The commander is operating in the PLEIADES — the nebula systems beyond the Bubble\'s edge, ' +
        'Thargoid country: barnacles, alert traffic, and stations that have all seen an attack.'
      );
    case 'deep':
      return (
        `The commander is in DEEP SPACE, ${ly(place.lyFromSol ?? 0)} from Sol and ` +
        `${ly(place.nearest?.ly ?? 0)} from ${place.nearest?.name ?? 'anywhere inhabited'}. ` +
        'No stations, no factions, no traffic — unexplored systems, whatever they scoop, and the ' +
        'long way home. Nothing out here is anyone\'s territory.'
      );
    default:
      return (
        'Where the commander is has not been established yet — do not assume a region, and do not ' +
        'name one until the log says so.'
      );
  }
}

/**
 * The operator's own post, phrased for how far away the commander is.
 *
 * Only real, well-known places are ever named — Jaques Station is a genuine
 * landmark of Colonia — because the grounding rules forbid inventing stations
 * and the fabrication guard will drop a beat that names one. Everywhere else is
 * described rather than named.
 */
export function operatorPost(place: Place): string {
  const life =
    'You flew these routes yourself for twenty years before a bad interdiction retired you to the ' +
    'mic, which is why other people\'s runs are your runs now.';
  switch (place.region) {
    case 'bubble':
      return `You work the long watch from a cramped comms office on a station in the core systems. ${life}`;
    case 'colonia':
      return `You work the long watch from a cramped comms office on Jaques Station, at the heart of Colonia. ${life}`;
    case 'pleiades':
      return `You work the long watch from a comms office out on the Pleiades frontier, where half the traffic is warships. ${life}`;
    case 'deep':
      return (
        `You work the long watch from your post back in ${place.nearest?.name ?? 'inhabited space'}, ` +
        `and the commander is ${ly(place.nearest?.ly ?? 0)} beyond it — far outside anyone else's ` +
        `board. Yours is the only voice reaching them out there, and you both know it. ${life}`
      );
    default:
      return `You work the long watch from a cramped comms office on a station in inhabited space. ${life}`;
  }
}

/**
 * Concrete local material for the per-beat context.
 *
 * The actual cure for the one-note problem: the model repeated the post and the
 * lanes because they were the only specific things it had. Distances and a
 * named region are true, cheap, and change as the commander flies.
 */
export function placeFacts(place: Place): string | null {
  if (place.region === 'unknown' || !place.coords) return null;
  const bits = [`WHERE THIS RUN IS: ${place.system}, in ${place.regionName}`];
  if (place.lyFromSol != null) bits.push(`${ly(place.lyFromSol)} from Sol`);
  // Skip the Colonia distance when the "nearest inhabited space" line below is
  // about to state the same number, and when they are standing in it.
  const nearestIsColonia = place.nearest?.key === 'colonia';
  if (
    place.region !== 'colonia' &&
    place.lyFromColonia != null &&
    place.lyFromColonia < 50_000 &&
    !(place.region === 'deep' && nearestIsColonia)
  ) {
    bits.push(`${ly(place.lyFromColonia)} from Colonia`);
  }
  if (place.region === 'deep' && place.nearest) {
    bits.push(`nearest inhabited space is ${place.nearest.name}, ${ly(place.nearest.ly)} away`);
  }
  return `${bits.join(' · ')}.`;
}

/**
 * Whether two places are different enough to warrant rebuilding the system
 * prompt. Crossing a region boundary does; another jump inside one does not,
 * and rebuilding on every jump would throw away the running conversation.
 */
export function regionChanged(a: Place | null, b: Place): boolean {
  return a?.region !== b.region;
}

/** Real landmarks the persona itself names, so the fabrication guard allows them. */
export function postPlaces(place: Place): string[] {
  return place.region === 'colonia' ? ['Jaques Station'] : [];
}
