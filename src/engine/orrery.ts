/**
 * The orrery — where every body in this system is, right now.
 *
 * Since game v4.0 update 14 a `Scan` carries the body's whole Keplerian element
 * set relative to its immediate parent: `SemiMajorAxis`, `Eccentricity`,
 * `OrbitalInclination`, `Periapsis` (the argument of periapsis, not the
 * distance), `AscendingNode`, `MeanAnomaly` and `OrbitalPeriod`, with the scan
 * timestamp as the epoch. That is everything needed to place the body at any
 * instant, forwards or backwards, for as long as the game keeps its two-body
 * assumption — which it does.
 *
 * So this is a closed form, not a simulation. Warping time evaluates the same
 * equations at a different `t`; nothing integrates, so nothing drifts. The
 * positions are exactly as accurate as Frontier's own published elements.
 *
 * The system map already draws this. It is also a full-screen mode you cannot
 * open while flying, which is the whole reason this tab exists — the same
 * argument as the route plotter and the architect list.
 *
 * The awkward parts are not the mathematics, which is textbook. They are the
 * five ways Elite's `Parents` chains do not mean what they appear to:
 *
 *  1. Ring pseudo-bodies. A belt cluster's parent is `{"Ring":1}`, and Ring 1
 *     never receives a Scan of its own — it is not a body, it is a band around
 *     one. 66 of the 129 scans in the test fixture are these. Collapsed to the
 *     first real ancestor.
 *  2. `BodyID:0` is a real star with NO `Parents` field in single-star systems,
 *     which is most systems. It is only synthesised as a placeholder root when
 *     no scan claims it.
 *  3. Barycentres arrive as `{"Null":n}` links in other bodies' chains, and
 *     `ScanBaryCentre` gives elements without saying what they orbit. Their
 *     parentage is recovered by unioning consecutive pairs out of every chain
 *     that passes through them: `[{Null:12},{Planet:5},{Star:0}]` proves 12
 *     orbits 5 and 5 orbits 0, whoever happened to emit it.
 *  4. Chains nest — the fixture has `[{Null:7},{Null:1},{Null:0}]` — so parent
 *     recovery has to walk the whole array, not just its head.
 *  5. A body can be scanned before its parent is. It is not dropped; it is held
 *     until the parent turns up, which is usually seconds later.
 *
 * Inclination and ascending node are already expressed in a system-wide
 * reference frame, so a child's offset from its parent needs no extra rotation
 * at each level: walk up the chain and add the vectors. (Credit where due —
 * that simplification, and the four traps above, are documented in TerjeRu's
 * MIT-licensed Orrery, https://github.com/TerjeRu/orrery. The implementation
 * here is this codebase's own.)
 */
import type { JournalEvent } from './types.ts';

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const DEG = Math.PI / 180;
/** Metres per light-second. Every distance the HUD shows is in ls. */
export const M_PER_LS = 299_792_458;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One body's orbit about its immediate parent, straight off the Scan. */
export interface OrbitElements {
  /** metres */
  semiMajorAxis: number;
  eccentricity: number;
  /** degrees */
  inclination: number;
  /** degrees — argument of periapsis */
  periapsis: number;
  /** degrees */
  ascendingNode: number;
  /** degrees past periapsis at `epochMs` */
  meanAnomaly: number;
  /** seconds */
  period: number;
  /** the scan timestamp: the epoch `meanAnomaly` is measured at */
  epochMs: number;
}

/**
 * `belt` is not a body the game gives elements for.
 *
 * A belt cluster's scan has a `{"Ring":n}` parent and no orbital elements
 * whatsoever — 66 of the fixture's 129 scans look like this. Re-parented onto
 * the ring's owner they would all pile up on top of it at offset zero, three
 * identical dots reading as one. They are drawn as a band instead, at the
 * radius the game reports, which is what they are.
 */
export type BodyKind = 'star' | 'planet' | 'barycentre' | 'belt';

/** One material on a landable surface, as the Scan reports it. */
export interface MaterialShare {
  /** Journal's lowercase key, e.g. "tellurium". */
  name: string;
  percent: number;
}

/**
 * Raw material rarity, 1 (everywhere) to 4 (worth landing for).
 *
 * The percentage on its own is misleading: iron at 21% is the least
 * interesting line on a scan and tellurium at 1.2% is why you would go. Grade
 * is what turns a list of numbers into a reason to fly somewhere.
 */
export type MatGrade = 1 | 2 | 3 | 4;

const GRADE: Readonly<Record<string, MatGrade>> = {
  carbon: 1, iron: 1, nickel: 1, phosphorus: 1, sulphur: 1, lead: 1, rhenium: 1,
  chromium: 2, germanium: 2, manganese: 2, vanadium: 2, zinc: 2, zirconium: 2, arsenic: 2,
  cadmium: 3, mercury: 3, molybdenum: 3, niobium: 3, tin: 3, tungsten: 3, boron: 3,
  selenium: 4, yttrium: 4, technetium: 4, tellurium: 4, polonium: 4, antimony: 4, ruthenium: 4,
};

export function materialGrade(name: string): MatGrade {
  return GRADE[name.trim().toLowerCase()] ?? 2;
}

export interface OrreryBody {
  id: number;
  /** Full journal BodyName, e.g. "Col 285 Sector MJ-F c12-10 A". */
  name: string;
  /** The part that is not the system name — "A", "5 a". Falls back to name. */
  label: string;
  kind: BodyKind;
  /** null only for the root. */
  parentId: number | null;
  /** metres — absent on barycentres, which have no surface. */
  radius?: number;
  starType?: string;
  planetClass?: string;
  landable?: boolean;
  /** Rings, so a ringed giant reads as one at a glance. */
  ringed?: boolean;
  /** ls from the entry point, as the game reports it. */
  distanceLs?: number;
  /** m/s². Divide by 9.80665 for G — the number a lander actually cares about. */
  gravity?: number;
  /** Kelvin. */
  temperature?: number;
  /** Pascals. Zero on the airless bodies you can land on. */
  pressure?: number;
  atmosphere?: string;
  volcanism?: string;
  /** Earth masses. */
  massEm?: number;
  tidalLock?: boolean;
  terraform?: string;
  /** Surface material spread, richest first. Landable bodies only. */
  materials?: MaterialShare[];
  /** Already claimed by someone else, so the payout is not a discovery bonus. */
  wasDiscovered?: boolean;
  wasMapped?: boolean;
  wasFootfalled?: boolean;
  /** Absent on the root, which does not orbit anything. */
  elements?: OrbitElements;
  /** False while this body is only known from another body's parent chain. */
  scanned: boolean;
}

/**
 * A place you can dock: an orbital station, an outpost, a surface port, a
 * settlement, a construction depot.
 *
 * Ports are not bodies and never receive a `Scan`, so they carry no orbit and
 * cannot be placed the way a planet is. What the journal does give:
 *
 *   Location (BodyType "Station")  the port's own BodyID, its name, and
 *                                  DistFromStarLS
 *   Location (docked, BodyType     the PLANET's BodyID — a surface port, whose
 *   "Planet")                      parent is stated outright
 *   ApproachSettlement             BodyID of the world plus latitude/longitude
 *   Docked                         name and DistFromStarLS, but NO BodyID
 *   SupercruiseExit (BodyType      the port's BodyID as you drop at it
 *   "Station")
 *
 * So a surface port knows its world exactly, and an orbital one has to be
 * matched to the body it orbits by distance from the arrival star — both
 * measure the same thing, so they agree to a fraction of a light-second.
 */
export interface OrreryPort {
  /** The port's own BodyID, which is never a scanned body. */
  id: number;
  name: string;
  /** Station type as the journal words it: Coriolis, Outpost, Settlement… */
  type?: string;
  /** ls from the arrival star — the only positional fact a station reports. */
  distanceLs?: number;
  /** The body it belongs to: stated for surface ports, inferred for orbitals. */
  parentId?: number;
  /** True when `parentId` came from the journal rather than a distance match. */
  parentKnown?: boolean;
  /** Surface ports only. */
  latitude?: number;
  longitude?: number;
}

export interface OrrerySystem {
  address: string;
  name: string;
  bodies: Map<number, OrreryBody>;
  /** Docks, keyed by their own BodyID. */
  ports: Map<number, OrreryPort>;
  /** Newest scan timestamp folded, so a stale system can be labelled. */
  lastScanMs: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ---------------------------------------------------------------------------
// Reading the journal
// ---------------------------------------------------------------------------

/**
 * The element set, or undefined if this body does not orbit anything.
 *
 * All seven fields are required together. A partial set is not a slow orbit,
 * it is a body the game did not describe — the primary star of a single-star
 * system carries none of them — and placing it from defaults would put a star
 * in a circular orbit around itself.
 */
export function readElements(ev: JournalEvent): OrbitElements | undefined {
  const semiMajorAxis = num(ev.SemiMajorAxis);
  const period = num(ev.OrbitalPeriod);
  if (semiMajorAxis === undefined || !period) return undefined;
  const eccentricity = num(ev.Eccentricity) ?? 0;
  const epochMs = Date.parse(ev.timestamp);
  if (!Number.isFinite(epochMs)) return undefined;
  return {
    semiMajorAxis,
    eccentricity,
    inclination: num(ev.OrbitalInclination) ?? 0,
    periapsis: num(ev.Periapsis) ?? 0,
    ascendingNode: num(ev.AscendingNode) ?? 0,
    // Absent before v4.0 U14. Zero means "at periapsis", which is a guess, but
    // it is the same guess the body's own orbit makes once per period.
    meanAnomaly: num(ev.MeanAnomaly) ?? 0,
    period,
    epochMs,
  };
}

/**
 * The surface material spread, richest first.
 *
 * Only landable bodies carry it, and the order the game writes it in is not
 * the order it is read in: sorting by share puts the reason you would land at
 * the top of the list instead of somewhere in the middle of eleven lines.
 */
export function readMaterials(ev: JournalEvent): MaterialShare[] | undefined {
  const raw = ev.Materials;
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out: MaterialShare[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const name = str((m as Record<string, unknown>).Name);
    const percent = num((m as Record<string, unknown>).Percent);
    if (name && percent !== undefined) out.push({ name: name.toLowerCase(), percent });
  }
  return out.length ? out.sort((a, b) => b.percent - a.percent) : undefined;
}

/** One `{"Planet":5}` link. */
interface ParentLink {
  kind: string;
  id: number;
}

/** The `Parents` array, nearest first, as typed links. */
export function parentChain(ev: JournalEvent): ParentLink[] {
  const raw = ev.Parents;
  if (!Array.isArray(raw)) return [];
  const out: ParentLink[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    for (const [kind, id] of Object.entries(entry as Record<string, unknown>)) {
      const n = num(id);
      if (n !== undefined) out.push({ kind, id: n });
    }
  }
  return out;
}

/**
 * The first ancestor that is an actual body.
 *
 * A `Ring` is a band around something, not something in orbit — it never gets
 * its own Scan and has no elements, so a belt cluster claiming `{"Ring":1}`
 * has to be re-parented onto whatever Ring 1 belongs to or it can never be
 * placed at all. Two thirds of the scans in the fixture take this path.
 */
function firstRealParent(chain: readonly ParentLink[]): ParentLink | null {
  for (const link of chain) {
    if (link.kind !== 'Ring') return link;
  }
  return null;
}

/** "Col 285 Sector MJ-F c12-10 A" in that system is just "A". */
export function shortLabel(bodyName: string, systemName: string): string {
  if (!systemName) return bodyName;
  if (bodyName === systemName) return bodyName;
  const prefix = `${systemName} `;
  return bodyName.startsWith(prefix) ? bodyName.slice(prefix.length) : bodyName;
}

/**
 * What kind of thing did this Scan describe?
 *
 * A `Scan` with neither `StarType` nor `PlanetClass` is not a body at all — it
 * is a band. Two shapes arrive that way and both were being mistaken for
 * barycentres and drawn as points on top of their parent:
 *
 *   belt cluster  Parents:[{"Ring":1},{"Star":0}]   — no elements at all
 *   ring          Parents:[{"Planet":32},{"Star":0}] — full elements, and its
 *                 own BodyID, e.g. "HIP 71120 3 A Ring"
 *
 * A real barycentre only ever arrives on a `ScanBaryCentre`, which the caller
 * handles before asking — so nothing that reaches here is one.
 */
const kindOf = (ev: JournalEvent): BodyKind => {
  if (str(ev.StarType)) return 'star';
  if (str(ev.PlanetClass)) return 'planet';
  return 'belt';
};

// ---------------------------------------------------------------------------
// Kepler
// ---------------------------------------------------------------------------

/**
 * Solve `E − e·sin E = M` for the eccentric anomaly.
 *
 * Newton–Raphson off a first-order seed. Six rounds converges below 1e-10 for
 * everything the game produces; the World of Death, at e≈0.95, is the worst
 * case in the wild and settles in four.
 */
export function solveKepler(M: number, e: number): number {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 6; i++) {
    const f = E - e * Math.sin(E) - M;
    if (Math.abs(f) < 1e-10) break;
    E -= f / (1 - e * Math.cos(E));
  }
  return E;
}

/**
 * Where this orbit is at `tMs`, relative to its parent, in metres.
 *
 * Perifocal position rotated into the system frame by the standard
 * argument-of-periapsis / inclination / ascending-node composition.
 */
export function orbitAt(el: OrbitElements, tMs: number): Vec3 {
  const M0 = el.meanAnomaly * DEG;
  const M = M0 + (2 * Math.PI * (tMs - el.epochMs)) / (el.period * 1000);
  const e = el.eccentricity;
  const E = solveKepler(M, e);

  // True anomaly from the eccentric anomaly, via the half-angle form — stable
  // at high eccentricity where the naive arccos loses its sign.
  const nu =
    2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
  const r = el.semiMajorAxis * (1 - e * Math.cos(E));

  const w = el.periapsis * DEG;
  const O = el.ascendingNode * DEG;
  const i = el.inclination * DEG;
  const u = w + nu; // argument of latitude
  const cosU = Math.cos(u);
  const sinU = Math.sin(u);
  const cosO = Math.cos(O);
  const sinO = Math.sin(O);
  const cosI = Math.cos(i);

  return {
    x: r * (cosO * cosU - sinO * sinU * cosI),
    y: r * (sinO * cosU + cosO * sinU * cosI),
    z: r * (sinU * Math.sin(i)),
  };
}

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

export interface ScaleOptions {
  /** 'compressed' keeps a moon visible around a distant planet; 'true' does not. */
  mode: 'compressed' | 'true';
  /** Compressed: floor in ls, so a hugging moon is still off its planet. */
  min: number;
  /** Compressed: ls added per decade of real distance. */
  gain: number;
  /** Compressed: the distance, in ls, where the log starts to bite. */
  scale: number;
}

export const DEFAULT_SCALE: ScaleOptions = {
  mode: 'compressed',
  min: 0.6,
  gain: 5.2,
  scale: 0.35,
};

/**
 * Squash one orbital radius for display.
 *
 * `d′ = min + gain·log₁₀(1 + d/scale)`, applied to each level's own offset
 * BEFORE the chain is summed. Compressing the summed vector instead would
 * flatten a moon onto its planet, because by then the moon's 0.002 ls is
 * rounding error against the planet's 400 — per-level is the whole trick, and
 * ordering survives it since log is monotonic.
 */
export function compressLs(ls: number, opts: ScaleOptions): number {
  if (opts.mode === 'true' || ls <= 0) return ls;
  return opts.min + opts.gain * Math.log10(1 + ls / opts.scale);
}

/**
 * Body radii, log-compressed and clamped.
 *
 * A star is ~700,000 km and a moon ~1,700; drawn to scale the moon is a
 * fraction of a pixel. Planetarium convention: exaggerate sizes, keep the
 * distances honest, and say so on screen. Stars and planets get separate
 * curves or every planet in a system with a star vanishes.
 */
export function bodyRadiusPx(body: OrreryBody, zoom = 1): number {
  const km = (body.radius ?? 0) / 1000;
  const base = !km
    ? 2.2 // barycentre marker
    : body.kind === 'star'
      ? Math.max(5, Math.min(13, 3.2 * Math.log10(km)))
      : Math.max(2.4, Math.min(7.5, 1.9 * Math.log10(km)));
  // Grow with zoom, but SUB-linearly. Zooming spread the bodies apart and left
  // them the same three pixels, so there was never anything to move closer to;
  // scaling them linearly instead would fill the panel with two planets. At
  // ^0.55 a 5 px world is 21 px at maximum zoom — enough to have a surface —
  // while separation still wins, because distance grows faster than radius.
  return base * Math.pow(Math.max(1, zoom), 0.55);
}

/**
 * What a body should look like, from what the journal actually said it is.
 *
 * Elite gives no surface maps, so anything drawn on a planet is invention. It
 * is kept to the one thing the journal DOES state — the class — so an icy body
 * reads as ice and a gas giant reads as banded, and nothing claims to be a
 * photograph of that particular world.
 */
export type Surface = 'star' | 'icy' | 'rock' | 'metal' | 'ocean' | 'gas' | 'ammonia' | 'none';

export function surfaceOf(body: OrreryBody): Surface {
  if (body.kind === 'star') return 'star';
  if (body.kind !== 'planet') return 'none';
  const c = (body.planetClass ?? '').toLowerCase();
  if (!c) return 'rock';
  if (c.includes('gas giant') || c.includes('class i') || c.includes('class v')) return 'gas';
  if (c.includes('water giant')) return 'ocean';
  if (c.includes('ammonia')) return 'ammonia';
  if (c.includes('earthlike') || c.includes('water world')) return 'ocean';
  if (c.includes('icy')) return 'icy';
  if (c.includes('metal rich') || c.includes('metal-rich')) return 'metal';
  if (c.includes('high metal')) return 'metal';
  return 'rock';
}

/**
 * Which star lights this body, as an index into the placed list.
 *
 * The terminator is the one part of a drawn planet that is NOT invention: the
 * star's position comes from the same elements as everything else, so the lit
 * limb genuinely faces the light. Nearest star wins, which is right in a binary
 * and irrelevant anywhere else.
 */
export function lightSource(
  placed: readonly PlacedBody[],
  target: PlacedBody,
): PlacedBody | null {
  let best: PlacedBody | null = null;
  let bestD = Infinity;
  for (const p of placed) {
    if (p.body.kind !== 'star' || p.body.id === target.body.id) continue;
    const d = Math.hypot(p.x - target.x, p.y - target.y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/** Bound a session's memory: a long expedition touches a lot of systems. */
const MAX_SYSTEMS = 12;

/**
 * Surface ports are keyed by their world's BodyID plus this, so they never
 * collide with the body itself or with an orbital station's own id.
 */
const PORT_ID_OFFSET = 1_000_000;

/**
 * How close a station's distance must be to a body's before we call it its
 * parent, in light-seconds.
 *
 * Both are measured from the arrival star, so a station and the body it
 * orbits agree to a fraction of an ls: Anders City reports 970.04 and its
 * world 970.0. Moons of one planet sit within a couple of ls of each other,
 * though, so a match inside a cluster can pick the neighbour — which is why
 * `parentKnown` exists, and why nothing claims exactness it has not got.
 */
const PORT_MATCH_LS = 6;

/**
 * Turn any BodyID the journal hands us into one the map can actually draw.
 *
 * Half the ids in a session are not bodies. `SupercruiseExit` reported
 * `BodyType:"Station"` 36 times in one commander's journals, `Docked` gives no
 * id whatsoever, and the nav target in Status.json is nearly always a station —
 * so both ends of a supercruise leg routinely arrive as dock ids that no
 * `Scan` will ever describe. Each resolves to the body it belongs to.
 *
 * Null when it cannot be resolved, which is the honest outcome: better to draw
 * no leg than one anchored to a guess.
 */
export function resolveBodyId(sys: OrrerySystem, id: number | null | undefined): number | null {
  if (id == null) return null;
  if (sys.bodies.has(id)) return id;
  const port = sys.ports.get(id);
  if (port?.parentId != null && sys.bodies.has(port.parentId)) return port.parentId;
  return null;
}

/**
 * Attach orbital stations to the body they orbit, by distance from the star.
 *
 * Surface ports already know their world and are left alone. Anything that
 * cannot be matched keeps `parentId` undefined and simply is not drawn —
 * better an absent dock than one floating beside the wrong planet.
 */
export function resolvePorts(sys: OrrerySystem): void {
  const candidates = [...sys.bodies.values()].filter(
    (b) => b.kind !== 'belt' && b.scanned && b.distanceLs != null,
  );
  if (!candidates.length) return;
  for (const port of sys.ports.values()) {
    if (port.parentKnown || port.distanceLs == null) continue;
    let best: OrreryBody | null = null;
    let bestD = Infinity;
    for (const b of candidates) {
      const d = Math.abs((b.distanceLs ?? 0) - port.distanceLs);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    port.parentId = best && bestD <= PORT_MATCH_LS ? best.id : undefined;
  }
}

/**
 * Folds Scan events into per-system body tables.
 *
 * Systems are kept whole. A partial system is the normal state of affairs —
 * you honk, you get some of it, you scan the rest as you fly — so the tab has
 * to render what is known and stay quiet about what is not.
 */
export class OrreryTracker {
  private systems = new Map<string, OrrerySystem>();
  currentAddress = '';
  currentSystem = '';
  /**
   * The body the commander is at, so the map can say "you are here".
   *
   * Cleared on leaving, because a stale marker on a moon you left an hour ago
   * is worse than no marker: it is the one thing on the map you would not
   * think to doubt.
   */
  currentBodyId: number | null = null;
  /**
   * The supercruise leg under way, or null when parked somewhere known.
   *
   * `SupercruiseEntry` carries no body, so where the ship left from is
   * whatever the tracker last established — the exit, docking or approach
   * before it. Not persisted: a leg is only meaningful inside the session that
   * is flying it, and restoring one would draw a ship in transit that landed
   * hours ago.
   */
  leg: ShipLeg | null = null;
  /** Set after a fold that changed persistable state. */
  dirty = false;

  apply(ev: JournalEvent): void {
    switch (ev.event) {
      case 'FSDJump':
      case 'CarrierJump':
        this.currentBodyId = null;
        this.leg = null;
      // falls through — a jump sets the system exactly like a Location does
      case 'Location':
        this.currentSystem = str(ev.StarSystem) ?? this.currentSystem;
        if (ev.SystemAddress != null) this.currentAddress = String(ev.SystemAddress);
        if (ev.event === 'Location') this.currentBodyId = num(ev.BodyID) ?? null;
        break;
      case 'ApproachBody':
      case 'SupercruiseExit':
      case 'Touchdown':
      case 'Docked':
        // Arrival is the one moment the position is certain. Any estimate in
        // flight is discarded here rather than allowed to disagree with it.
        this.currentBodyId = num(ev.BodyID) ?? this.currentBodyId;
        this.leg = null;
        break;
      case 'SupercruiseEntry': {
        // Dropping into supercruise starts a leg from wherever we last knew
        // the ship to be. Destination is filled in by the caller, live, since
        // retargeting mid-flight is normal.
        const at = Date.parse(ev.timestamp);
        this.leg =
          this.currentBodyId != null && Number.isFinite(at)
            ? { fromId: this.currentBodyId, toId: this.currentBodyId, departedMs: at }
            : null;
        this.currentBodyId = null;
        break;
      }
      case 'LeaveBody':
        this.currentBodyId = null;
        break;
      case 'Scan':
      case 'ScanBaryCentre':
        this.onScan(ev);
        break;
      default:
        break;
    }
    // Ports are learned from several of the same events, so this runs
    // alongside rather than inside the switch.
    this.notePort(ev);
  }

  /**
   * Fold a line from the PAST: learn its bodies and its docks, touch nothing
   * else.
   *
   * The history sweep replays old Location and SupercruiseExit lines to find
   * stations, and `apply` reads those same events as navigation — so sweeping
   * mid-flight would teleport the tracker into last week: the live leg nulled
   * by a year-old arrival, `currentBodyId` pointing at a body the commander
   * left in March. Knowledge accretes; state must not.
   */
  applyHistoric(ev: JournalEvent): void {
    switch (ev.event) {
      case 'Scan':
      case 'ScanBaryCentre':
        this.onScan(ev);
        break;
      default:
        break;
    }
    this.notePort(ev);
  }

  /**
   * Record a dock wherever the journal happens to mention one.
   *
   * Five different events each know a different part of it, and none knows all
   * of it, so they are merged by the port's own BodyID — or by name for
   * `Docked`, which is the one that gives a distance but no id at all.
   *
   * Creates the system entry if none exists yet. It used to require one, which
   * was a race: at boot the live journal replays immediately while the history
   * sweep that creates the system runs async — so every port mentioned in the
   * current session was dropped on the floor whenever the sweep lost the race,
   * and the ship's leg had nothing to resolve against.
   */
  private notePort(ev: JournalEvent): void {
    const PORT_EVENTS = ['Location', 'SupercruiseExit', 'ApproachSettlement', 'Docked'];
    if (!PORT_EVENTS.includes(ev.event)) return;
    const address =
      ev.SystemAddress != null ? String(ev.SystemAddress) : this.currentAddress;
    if (!address) return;
    // Created only at the moment a port is actually recorded — a plain
    // Location with no station in it must not cost a slot in the LRU cap.
    const merge = (id: number, patch: Partial<OrreryPort> & { name: string }): void => {
      const sys = this.system(address, str(ev.StarSystem) ?? this.currentSystem);
      // Fleet carriers are not infrastructure — they jump. Pinning one beside
      // the world it happened to be parked at would draw it there for ever,
      // and this table is persisted.
      if ((patch.type ?? sys.ports.get(id)?.type) === 'FleetCarrier') return;
      const prev = sys.ports.get(id);
      sys.ports.set(id, { ...prev, ...patch, id });
      this.dirty = true;
    };

    switch (ev.event) {
      case 'Location':
      case 'SupercruiseExit': {
        const id = num(ev.BodyID);
        const type = str(ev.BodyType);
        const name = str(ev.StationName) ?? str(ev.Body);
        if (id === undefined || !name) break;
        if (type === 'Station') {
          merge(id, {
            name,
            type: str(ev.StationType),
            distanceLs: num(ev.DistFromStarLS),
          });
        } else if (ev.Docked === true && (type === 'Planet' || type === 'PlanetaryRing')) {
          // Docked on a surface: the body under it is stated, not guessed.
          const station = str(ev.StationName);
          if (station) {
            merge(id + PORT_ID_OFFSET, {
              name: station,
              type: str(ev.StationType),
              distanceLs: num(ev.DistFromStarLS),
              parentId: id,
              parentKnown: true,
            });
          }
        }
        break;
      }
      case 'ApproachSettlement': {
        const bodyId = num(ev.BodyID);
        const name = str(ev.Name);
        if (bodyId === undefined || !name) break;
        // Settlements share their world's BodyID, so they are keyed off it —
        // several can sit on one body, and the offset keeps them apart.
        merge(bodyId + PORT_ID_OFFSET, {
          name,
          type: 'Settlement',
          parentId: bodyId,
          parentKnown: true,
          latitude: num(ev.Latitude),
          longitude: num(ev.Longitude),
        });
        break;
      }
      case 'Docked': {
        // No BodyID here at all. Match on the name we may already hold, so a
        // station learned from a drop gains its distance on docking.
        const name = str(ev.StationName);
        const ls = num(ev.DistFromStarLS);
        if (!name) break;
        for (const p of this.systems.get(address)?.ports.values() ?? []) {
          if (p.name === name) {
            merge(p.id, { name, type: str(ev.StationType) ?? p.type, distanceLs: ls ?? p.distanceLs });
            return;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private onScan(ev: JournalEvent): void {
    const address =
      ev.SystemAddress != null ? String(ev.SystemAddress) : this.currentAddress;
    if (!address) return;
    const id = num(ev.BodyID);
    if (id === undefined) return;
    const systemName = str(ev.StarSystem) ?? this.currentSystem;
    const sys = this.system(address, systemName);
    const at = Date.parse(ev.timestamp);
    if (Number.isFinite(at)) sys.lastScanMs = Math.max(sys.lastScanMs, at);

    const chain = parentChain(ev);
    // Every consecutive pair in the chain is a fact about parentage, including
    // pairs describing bodies this event is not about. ScanBaryCentre carries
    // no Parents at all, so this is the ONLY way its own parent is ever
    // learned — from some moon three levels down that mentioned it in passing.
    this.learnChain(sys, chain);

    // ScanBaryCentre says nothing about a body; it describes a point. It still
    // has elements, and children hang off it, so it is kept as a barycentre.
    const kind: BodyKind = ev.event === 'ScanBaryCentre' ? 'barycentre' : kindOf(ev);
    const name = str(ev.BodyName) ?? (kind === 'barycentre' ? `Barycentre ${id}` : `Body ${id}`);
    const known = sys.bodies.get(id);
    const parent = firstRealParent(chain);

    sys.bodies.set(id, {
      id,
      name,
      label: shortLabel(name, systemName),
      kind,
      // A chain of nothing but Rings, or no chain at all, means this is the
      // root — the common case, since most systems have one star.
      parentId: parent ? parent.id : null,
      radius: num(ev.Radius) ?? known?.radius,
      starType: str(ev.StarType) ?? known?.starType,
      planetClass: str(ev.PlanetClass) ?? known?.planetClass,
      landable: typeof ev.Landable === 'boolean' ? ev.Landable : known?.landable,
      ringed: Array.isArray(ev.Rings) ? ev.Rings.length > 0 : known?.ringed,
      distanceLs: num(ev.DistanceFromArrivalLS) ?? known?.distanceLs,
      elements: readElements(ev) ?? known?.elements,
      gravity: num(ev.SurfaceGravity) ?? known?.gravity,
      temperature: num(ev.SurfaceTemperature) ?? known?.temperature,
      pressure: num(ev.SurfacePressure) ?? known?.pressure,
      atmosphere: str(ev.Atmosphere) || str(ev.AtmosphereType) || known?.atmosphere,
      volcanism: str(ev.Volcanism) || known?.volcanism,
      massEm: num(ev.MassEM) ?? known?.massEm,
      tidalLock: typeof ev.TidalLock === 'boolean' ? ev.TidalLock : known?.tidalLock,
      terraform: str(ev.TerraformState) || known?.terraform,
      materials: readMaterials(ev) ?? known?.materials,
      wasDiscovered:
        typeof ev.WasDiscovered === 'boolean' ? ev.WasDiscovered : known?.wasDiscovered,
      wasMapped: typeof ev.WasMapped === 'boolean' ? ev.WasMapped : known?.wasMapped,
      wasFootfalled:
        typeof ev.WasFootfalled === 'boolean' ? ev.WasFootfalled : known?.wasFootfalled,
      scanned: true,
    });
    this.dirty = true;
  }

  /**
   * Record what a parent chain proves, without overwriting real scans.
   *
   * Placeholders are how a barycentre exists at all before anything scans it,
   * and how a moon scanned before its planet still has somewhere to hang. They
   * carry no elements, so they are unplaceable until the real scan lands —
   * which is correct: an unplaced body is not drawn, rather than drawn wrong.
   */
  private learnChain(sys: OrrerySystem, chain: readonly ParentLink[]): void {
    const real = chain.filter((l) => l.kind !== 'Ring');
    for (let i = 0; i < real.length; i++) {
      const link = real[i];
      const up = real[i + 1] ?? null;
      const existing = sys.bodies.get(link.id);
      if (existing) {
        // A scanned body knows its own parent. Only fill a gap.
        if (existing.parentId === null && up && !existing.scanned) {
          sys.bodies.set(link.id, { ...existing, parentId: up.id });
        }
        continue;
      }
      sys.bodies.set(link.id, {
        id: link.id,
        name: link.kind === 'Null' ? `Barycentre ${link.id}` : `Body ${link.id}`,
        label: link.kind === 'Null' ? `⊕${link.id}` : `#${link.id}`,
        kind: link.kind === 'Null' ? 'barycentre' : link.kind === 'Star' ? 'star' : 'planet',
        parentId: up ? up.id : null,
        scanned: false,
      });
      this.dirty = true;
    }
  }

  private system(address: string, name: string): OrrerySystem {
    let sys = this.systems.get(address);
    if (!sys) {
      sys = { address, name, bodies: new Map(), ports: new Map(), lastScanMs: 0 };
      this.systems.set(address, sys);
      // Oldest out. Insertion order is Map order, and the current system is
      // re-inserted on arrival, so the one dropped is the least recently seen.
      while (this.systems.size > MAX_SYSTEMS) {
        const oldest = this.systems.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === address) break;
        this.systems.delete(oldest);
      }
    } else if (name && !sys.name) {
      sys.name = name;
    }
    return sys;
  }

  /** The system the commander is standing in, if anything has been scanned. */
  current(): OrrerySystem | null {
    return this.systems.get(this.currentAddress) ?? null;
  }

  get(address: string): OrrerySystem | null {
    return this.systems.get(address) ?? null;
  }

  toJSON(): unknown {
    return {
      v: 1,
      systems: [...this.systems.values()].map((s) => ({
        address: s.address,
        name: s.name,
        lastScanMs: s.lastScanMs,
        bodies: [...s.bodies.values()],
        ports: [...s.ports.values()],
      })),
    };
  }

  static fromJSON(raw: unknown): OrreryTracker {
    const t = new OrreryTracker();
    const data = raw as {
      systems?: Array<{
        address?: string;
        name?: string;
        lastScanMs?: number;
        bodies?: OrreryBody[];
        ports?: OrreryPort[];
      }>;
    };
    for (const s of data?.systems ?? []) {
      if (!s?.address) continue;
      t.systems.set(s.address, {
        address: s.address,
        name: s.name ?? '',
        lastScanMs: s.lastScanMs ?? 0,
        bodies: new Map((s.bodies ?? []).map((b) => [b.id, b])),
        ports: new Map((s.ports ?? []).map((p) => [p.id, p])),
      });
    }
    return t;
  }
}

// ---------------------------------------------------------------------------
// Placing bodies
// ---------------------------------------------------------------------------

/** A body placed for drawing: system-frame ls, already scaled. */
export interface PlacedBody {
  body: OrreryBody;
  /** Display-space light-seconds, top-down. z is kept for depth ordering. */
  x: number;
  y: number;
  z: number;
  /** True separation from the parent, in ls, for the detail line. */
  trueLs: number;
}

/** Walk to the root, nearest first. Empty if the chain is broken or cyclic. */
function ancestry(sys: OrrerySystem, id: number): OrreryBody[] {
  const out: OrreryBody[] = [];
  const seen = new Set<number>();
  let cur = sys.bodies.get(id);
  while (cur) {
    if (seen.has(cur.id)) return []; // cycle: refuse rather than hang
    seen.add(cur.id);
    out.push(cur);
    if (cur.parentId === null) return out;
    const next = sys.bodies.get(cur.parentId);
    if (!next) return []; // orphan — parent not scanned yet
    cur = next;
  }
  return [];
}

/**
 * Where a body sits at `tMs`, summed up its parent chain.
 *
 * Returns null for an orphan, which is a body scanned before its parent and
 * will resolve on its own within seconds. Skipping it beats guessing.
 */
export function placeBody(
  sys: OrrerySystem,
  id: number,
  tMs: number,
  opts: ScaleOptions = DEFAULT_SCALE,
): PlacedBody | null {
  const chain = ancestry(sys, id);
  if (!chain.length) return null;
  const body = chain[0];

  let x = 0;
  let y = 0;
  let z = 0;
  let trueLs = 0;
  for (const link of chain) {
    if (!link.elements) continue; // the root, or a body still to be scanned
    const p = orbitAt(link.elements, tMs);
    const ls = Math.hypot(p.x, p.y, p.z) / M_PER_LS;
    if (link.id === id) trueLs = ls;
    if (ls <= 0) continue;
    // Compress this level's own offset, keeping its direction.
    const k = compressLs(ls, opts) / ls;
    x += (p.x / M_PER_LS) * k;
    y += (p.y / M_PER_LS) * k;
    z += (p.z / M_PER_LS) * k;
  }
  return { body, x, y, z, trueLs };
}

/**
 * Every body that can be drawn as a point.
 *
 * Belts are excluded — they are bands, see `placeBelts`. So are bodies known
 * only from someone else's parent chain: they carry no elements, so they would
 * draw exactly on top of their parent, and a dot the commander never scanned
 * is a claim this app has no business making. They stay in the table because
 * their children hang off them; they simply are not drawn.
 */
export function placeSystem(
  sys: OrrerySystem,
  tMs: number,
  opts: ScaleOptions = DEFAULT_SCALE,
): PlacedBody[] {
  const out: PlacedBody[] = [];
  for (const body of sys.bodies.values()) {
    if (body.kind === 'belt' || !body.scanned) continue;
    const placed = placeBody(sys, body.id, tMs, opts);
    if (placed) out.push(placed);
  }
  // Depth order, so a moon in front of its planet draws in front of it.
  return out.sort((a, b) => a.z - b.z);
}

/** A belt cluster as the band it actually is, centred on the body it rings. */
export interface PlacedBelt {
  body: OrreryBody;
  /** Centre — the ring owner's position, in display space. */
  cx: number;
  cy: number;
  /** Band radius, in display space. */
  r: number;
}

/**
 * Belt clusters, as rings around their owner.
 *
 * The radius is taken from `DistanceFromArrivalLS`, which is measured from the
 * system's entry point rather than from the parent — exact for a belt around
 * the arrival star, which is where nearly all of them are, and an
 * over-estimate for one around a distant planet. Differencing against the
 * parent's own arrival distance corrects the common case of both being on the
 * same side; nothing here claims better than that.
 */
export function placeBelts(
  sys: OrrerySystem,
  tMs: number,
  opts: ScaleOptions = DEFAULT_SCALE,
): PlacedBelt[] {
  const out: PlacedBelt[] = [];
  for (const body of sys.bodies.values()) {
    if (body.kind !== 'belt' || body.parentId === null) continue;
    const owner = placeBody(sys, body.parentId, tMs, opts);
    if (!owner) continue;
    const ls = Math.abs((body.distanceLs ?? 0) - (owner.body.distanceLs ?? 0));
    if (ls <= 0) continue;
    out.push({ body, cx: owner.x, cy: owner.y, r: compressLs(ls, opts) });
  }
  return out;
}

/**
 * One full orbit as a polyline, in the same display space as the bodies.
 *
 * Sampled through the identical per-level transform rather than drawn as an
 * ellipse, because compression is applied per level and the parent is itself
 * moving — an analytic ellipse would be a shape the body never visits.
 */
export function orbitPath(
  sys: OrrerySystem,
  id: number,
  tMs: number,
  opts: ScaleOptions = DEFAULT_SCALE,
  samples = 72,
): Array<{ x: number; y: number }> {
  const body = sys.bodies.get(id);
  if (!body?.elements) return [];
  const period = body.elements.period * 1000;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= samples; i++) {
    const placed = placeBody(sys, id, tMs + (period * i) / samples, opts);
    if (placed) pts.push({ x: placed.x, y: placed.y });
  }
  return pts;
}

/** Half-width in display-ls needed to frame everything placed. */
export function systemExtent(placed: readonly PlacedBody[]): number {
  let max = 0;
  for (const p of placed) max = Math.max(max, Math.hypot(p.x, p.y));
  return max || 1;
}

// ---------------------------------------------------------------------------
// Where the ship is
// ---------------------------------------------------------------------------

/**
 * A supercruise leg in progress: left `fromId` at `departedMs`, aiming at
 * `toId`. The destination is read live, because retargeting mid-flight is
 * normal and the leg should follow it.
 */
export interface ShipLeg {
  fromId: number;
  toId: number;
  departedMs: number;
}

/**
 * How far along a leg the ship might be — a BAND, not a point.
 *
 * Elite reports no in-system position. Nothing in Status.json or the journal
 * says where the ship is between two bodies, so any single dot on that line is
 * invented. Measured against this commander's own history, distance barely
 * predicts duration at all:
 *
 *     0.2 ls ->   8 s
 *     0.8 ls -> 134 s, 154 s
 *   4696   ls -> 137 s, 162 s, 304 s
 *
 * The same 4,697 ls run took 137 s and 304 s on different days, and a 0.8 ls
 * hop took as long as either — because the trip is spool-up, alignment and
 * deceleration far more than it is distance, and because a pilot stops to
 * scan things. A best-fit curve over those legs carries a mean relative error
 * of 112%, which is worse than no estimate at all.
 *
 * So the bounds are flat and wide rather than a fitted curve pretending to
 * precision, and what gets drawn is the interval they imply: the ship is
 * somewhere between `lo` and `hi` of the way there. Early in a leg that is a
 * useful, moving answer; late in one it widens to "nearly there, or arriving",
 * which is exactly what is actually known.
 */
export interface LegProgress {
  lo: number;
  hi: number;
  /** Midpoint, for the marker. Never mistake this for a position. */
  mid: number;
  elapsedS: number;
}

/**
 * Fastest and slowest plausible legs, in seconds, taken from the measurements
 * above rather than guessed.
 *
 * The three cruise legs came in at 137, 162 and 304 s, so the bounds sit a
 * little outside that: 110 allows for a pilot flying it better than this
 * commander ever did, 330 for one who stopped to look at something. Bounds any
 * tighter would be a claim the evidence does not support; any wider and the
 * band covers the whole route from the first second, which tells nobody
 * anything.
 */
const LEG_FAST_S = 110;
const LEG_SLOW_S = 330;
/**
 * Under a light-second is a manoeuvre, not a cruise. Measured at 8 s for
 * 0.2 ls and 134/154 s for 0.8 ls — the spread is enormous at this range
 * because it is all spool-up and stopping.
 */
const HOP_FAST_S = 8;
const HOP_SLOW_S = 170;

export function legProgress(leg: ShipLeg, nowMs: number, separationLs: number): LegProgress {
  const elapsedS = Math.max(0, (nowMs - leg.departedMs) / 1000);
  const short = separationLs < 1;
  const fast = short ? HOP_FAST_S : LEG_FAST_S;
  const slow = short ? HOP_SLOW_S : LEG_SLOW_S;
  const hi = Math.min(1, elapsedS / fast);
  const lo = Math.min(hi, elapsedS / slow);
  return { lo, hi, mid: (lo + hi) / 2, elapsedS };
}

/** Anything with a position and a size, for the de-overlap pass. */
export interface Disc {
  x: number;
  y: number;
  r: number;
}

/** A body wanting its name written next to it. */
export interface LabelWish {
  key: number;
  text: string;
  x: number;
  y: number;
  r: number;
  /** Lower goes first, and first come first served. Stars lead. */
  priority: number;
  /**
   * Rendered width, when the caller knows better than `charW × length`.
   *
   * The selected body's name is drawn a size larger than the rest, so measuring
   * it at the common size booked it a berth too small and it collided with its
   * neighbours — three of them, on a real map.
   */
  width?: number;
}

export interface PlacedLabel {
  key: number;
  text: string;
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
}

/**
 * Write as many body names as will legibly fit.
 *
 * Every body should be named — you cannot look up "the green one". But 36
 * names in a 400 px panel, drawn blindly, is a smear that hides the map it is
 * labelling. So each name is offered four berths around its body (right, left,
 * above, below) and takes the first that collides with neither an already
 * written name nor any body on the map. A name with nowhere to go is skipped.
 *
 * That skip is what makes zooming worth doing: the bodies spread apart in
 * pixels as you zoom, berths open up, and the names appear on their own. The
 * commander is never told a body has no name — they are told to zoom, by the
 * map filling in as they do.
 *
 * Greedy in priority order, so the things worth naming most — the star, the
 * body under the ship, whatever is selected — never lose their berth to a rock.
 */
export function placeLabels(
  wishes: readonly LabelWish[],
  opts: {
    charW?: number;
    lineH?: number;
    gap?: number;
    halo?: number;
    bodies?: readonly Disc[];
  } = {},
): PlacedLabel[] {
  // Deliberately generous. The face is proportional, so a per-character
  // average is only ever an estimate — and the estimate must err wide, because
  // booking a berth too small is what puts two names on top of each other.
  const charW = opts.charW ?? 4.9;
  const lineH = opts.lineH ?? 8;
  const gap = opts.gap ?? 2.5;
  // The names carry a dark halo so they stay readable over orbit lines, and
  // that halo is part of what the eye reads as the label's edge.
  const halo = opts.halo ?? 1.5;
  const bodies = opts.bodies ?? wishes;

  const taken: Array<{ x: number; y: number; w: number; h: number }> = [];
  const hits = (b: { x: number; y: number; w: number; h: number }): boolean => {
    for (const t of taken) {
      if (b.x < t.x + t.w && t.x < b.x + b.w && b.y < t.y + t.h && t.y < b.y + b.h) return true;
    }
    // A name sitting on top of another body is as bad as one sitting on a name.
    for (const d of bodies) {
      const nx = Math.max(b.x, Math.min(d.x, b.x + b.w));
      const ny = Math.max(b.y, Math.min(d.y, b.y + b.h));
      if (Math.hypot(d.x - nx, d.y - ny) < d.r) return true;
    }
    return false;
  };

  const out: PlacedLabel[] = [];
  for (const w of [...wishes].sort((a, b) => a.priority - b.priority)) {
    const tw = (w.width ?? w.text.length * charW) + halo * 2;
    const off = w.r + gap;
    // Right first — it reads most naturally — then left, then above, then below.
    const berths: PlacedLabel[] = [
      { key: w.key, text: w.text, x: w.x + off, y: w.y + lineH * 0.35, anchor: 'start' },
      { key: w.key, text: w.text, x: w.x - off, y: w.y + lineH * 0.35, anchor: 'end' },
      { key: w.key, text: w.text, x: w.x, y: w.y - off - lineH * 0.2, anchor: 'middle' },
      { key: w.key, text: w.text, x: w.x, y: w.y + off + lineH * 0.8, anchor: 'middle' },
    ];
    for (const b of berths) {
      // The box the glyphs will actually occupy, from the anchor SVG will use.
      // The halo pads every side, not just the two the text grows along — a
      // stroke is drawn around the glyphs, and leaving it out of the height is
      // what let names that cleared each other horizontally still touch.
      const left = b.anchor === 'start' ? b.x : b.anchor === 'end' ? b.x - tw : b.x - tw / 2;
      const box = { x: left, y: b.y - lineH * 0.8 - halo, w: tw, h: lineH + halo * 2 };
      if (hits(box)) continue;
      taken.push(box);
      out.push(b);
      break;
    }
  }
  return out;
}

/**
 * Push overlapping bodies apart until they can be told apart.
 *
 * A system map is read to answer "what is here, and what is near what". Two
 * moons 0.3 ls apart around a gas giant are, at any honest scale, one dot —
 * and one dot you cannot click is worth less than two dots a pixel from where
 * they truly are. So in compressed mode, separation wins over spacing. (In
 * true-distance mode it must not run: that mode exists to be believed.)
 *
 * Symmetric relaxation — each of an overlapping pair gives way by half — run
 * for a fixed number of rounds so the result is deterministic and the same
 * every frame. No randomness, or bodies would jitter as time advances.
 *
 * `maxShift` is what keeps this a map rather than a diagram: nothing moves
 * further than that from where it really is, so a body stays recognisably on
 * its own orbit even after being nudged off it. Crowds that cannot be resolved
 * inside that budget stay slightly overlapped, which is the honest outcome.
 */
export function separateDiscs<T extends Disc>(
  discs: readonly T[],
  gap = 1.5,
  maxShift = 14,
  rounds = 80,
): T[] {
  const out = discs.map((d) => ({ ...d }));
  const home = discs.map((d) => ({ x: d.x, y: d.y }));
  if (out.length < 2) return out;

  for (let round = 0; round < rounds; round++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        const want = a.r + b.r + gap;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= want) continue;
        if (d < 1e-6) {
          // Exactly coincident — no axis to push along. Fan them out by index
          // so the choice is deterministic rather than arbitrary.
          const ang = (i * 2.399963229728653 + j) % (2 * Math.PI); // golden angle
          dx = Math.cos(ang);
          dy = Math.sin(ang);
          d = 1;
        }
        const push = (want - d) / 2;
        const ux = (dx / d) * push;
        const uy = (dy / d) * push;
        a.x -= ux;
        a.y -= uy;
        b.x += ux;
        b.y += uy;
        moved = true;
      }
    }
    // Rein each body back inside its budget after every round, so the clamp
    // shapes the relaxation instead of truncating it at the end.
    for (let i = 0; i < out.length; i++) {
      const dx = out[i].x - home[i].x;
      const dy = out[i].y - home[i].y;
      const d = Math.hypot(dx, dy);
      if (d > maxShift) {
        out[i].x = home[i].x + (dx / d) * maxShift;
        out[i].y = home[i].y + (dy / d) * maxShift;
      }
    }
    if (!moved) break;
  }
  return out;
}
