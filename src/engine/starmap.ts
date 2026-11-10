/**
 * How far is that, and how many jumps — for places the commander has been.
 *
 * The shopping list learned to reach 1,500 ly, and then could not say how far
 * anything was. Community rows carry a distance because Ardent computes one;
 * the commander's OWN market readings carry `distanceLy: null`, because
 * `marketMemory` remembers a station, a system and a price and has never known
 * where any of it is. So the five best sellers of titanium — every one of them
 * read first-hand at HIP 71120 — rendered with no distance at all, and could
 * not be sorted by the thing that actually decides the trip.
 *
 * The game has been handing us the answer the whole time. `FSDJump`,
 * `Location` and `CarrierJump` all carry `StarPos`, and `state.ts` keeps it for
 * the CURRENT system only, resetting on arrival. Kept instead as a map, every
 * system the commander has ever flown to has coordinates — which is, by
 * definition, every system their market memory holds, because they had to go
 * there to read the board.
 *
 * No network, no lookup, no permission. Just the arithmetic we were discarding.
 *
 * Pure module — unit-tested in tests/starmap.test.ts.
 */
import type { JournalEvent } from './types.ts';
import { distanceLy, type Coords } from './place.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Systems remembered. Generous because the record is tiny — three floats and a
 * name — and because a colonisation career visits a great many systems, each of
 * which may hold a market the shopping list wants to measure.
 */
const MAX_SYSTEMS = 2000;

/** Coordinates for every system the commander has visited. */
export class StarMap {
  private at = new Map<string, Coords>();
  /** Insertion order is not recency, so the order of arrival is kept apart. */
  private order: string[] = [];

  get size(): number {
    return this.at.size;
  }

  /** Case-insensitive: the journal is consistent, community data is not. */
  coordsOf(system: string | null | undefined): Coords | null {
    const key = str(system).toLowerCase();
    return key ? (this.at.get(key) ?? null) : null;
  }

  /** Light years between two systems, or null when either is unknown to us. */
  between(a: string | null | undefined, b: string | null | undefined): number | null {
    const from = this.coordsOf(a);
    const to = this.coordsOf(b);
    if (!from || !to) return null;
    return distanceLy(from, to);
  }

  /**
   * Place a system we have never flown to, from a coordinate lookup.
   *
   * Kept separate from `apply` because the provenance differs: `apply` folds
   * the game's own StarPos, this takes a community figure. Both are galactic
   * coordinates and neither is more true than the other — but a system the
   * commander HAS visited must never have its journal position overwritten by
   * a lookup, so a known system is left alone.
   */
  place(system: string, x: number, y: number, z: number): boolean {
    const key = str(system).toLowerCase();
    if (!key || this.at.has(key)) return false;
    if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
    this.order.push(key);
    this.at.set(key, { x, y, z });
    return true;
  }

  apply(ev: JournalEvent): boolean {
    // Every event that carries StarPos also names the system it belongs to.
    // Docked does NOT carry one, which is why a market read is not enough on
    // its own — the arrival before it is what puts the system on the map.
    const pos = ev.StarPos;
    if (!Array.isArray(pos) || pos.length !== 3) return false;
    const system = str(ev.StarSystem);
    if (!system) return false;
    const [x, y, z] = pos as unknown[];
    const c = { x: num(x), y: num(y), z: num(z) };
    if (c.x == null || c.y == null || c.z == null) return false;
    const key = system.toLowerCase();
    const known = this.at.get(key);
    // Sol really is {0,0,0}, so "already known" cannot be a falsy check.
    if (known && known.x === c.x && known.y === c.y && known.z === c.z) return false;
    if (!known) this.order.push(key);
    this.at.set(key, { x: c.x, y: c.y, z: c.z });
    while (this.order.length > MAX_SYSTEMS) {
      const oldest = this.order.shift();
      if (oldest && oldest !== key) this.at.delete(oldest);
    }
    return true;
  }

  toJSON(): Array<{ s: string; x: number; y: number; z: number }> {
    // Short keys: two thousand systems go into localStorage and the field
    // names would otherwise be most of the payload.
    return this.order
      .map((k) => {
        const c = this.at.get(k);
        return c ? { s: k, x: c.x, y: c.y, z: c.z } : null;
      })
      .filter((r): r is { s: string; x: number; y: number; z: number } => r != null);
  }

  load(rows: unknown): void {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const row = r as { s?: unknown; x?: unknown; y?: unknown; z?: unknown };
      const key = str(row.s).toLowerCase();
      const x = num(row.x);
      const y = num(row.y);
      const z = num(row.z);
      if (!key || x == null || y == null || z == null) continue;
      if (!this.at.has(key)) this.order.push(key);
      this.at.set(key, { x, y, z });
    }
  }
}

// ------------------------------------------------------------- the jump range

/**
 * A hold full of steel is not the ship the outfitting screen described.
 *
 * `Loadout.MaxJumpRange` is the game's own figure and it is the EMPTY one. A
 * Type-9 that reports 32 ly does not make 32 ly carrying 784 t of titanium, and
 * dividing a 464 ly haul by the wrong range is the difference between "eighteen
 * jumps" and "thirty-one" — which is the difference between doing the run this
 * evening and not.
 *
 * Rather than model FSD mass curves from module specs we do not have, this
 * watches what the ship ACTUALLY does: every `FSDJump` states the distance
 * jumped, and the cargo aboard at that moment is already known. The longest
 * jump observed while genuinely loaded is a measured laden range, from this
 * commander's own ship, with their own engineering on it.
 */
export interface JumpObservation {
  /** Light years covered by one jump. */
  ly: number;
  /** Tons aboard at the time. */
  cargo: number;
  at: number;
}

/**
 * Loaded enough for the measurement to mean something.
 *
 * Half a hold is where the range penalty is unmistakable and where a hauler
 * spends most of its time. Below it the jump says more about the ship empty
 * than about the ship working.
 */
const LADEN_FRACTION = 0.5;

/** Observations older than this describe a ship the commander may not still fly. */
const KEEP = 60;

export class JumpRange {
  private seen: JumpObservation[] = [];

  /**
   * Record a jump. `cargo` is what was aboard; `capacity` sizes "laden".
   *
   * Returns true when the observation was kept, which the caller uses to decide
   * whether anything is worth persisting.
   */
  note(ly: number, cargo: number, at: number): boolean {
    if (!(ly > 0) || !Number.isFinite(ly)) return false;
    this.seen.push({ ly, cargo: Math.max(0, cargo), at });
    if (this.seen.length > KEEP) this.seen = this.seen.slice(-KEEP);
    return true;
  }

  apply(ev: JournalEvent, cargo: number): boolean {
    if (ev.event !== 'FSDJump') return false;
    const ly = num(ev.JumpDist);
    if (ly == null) return false;
    const at = Date.parse(str(ev.timestamp)) || Date.now();
    return this.note(ly, cargo, at);
  }

  /**
   * The best laden jump seen, or null when the ship has not flown loaded.
   *
   * The MAXIMUM rather than the mean, because a commander plotting economically
   * makes many short hops by choice — those say nothing about reach. The
   * longest jump they managed while loaded is the range they actually have.
   */
  ladenLy(capacity: number | null | undefined): number | null {
    const cap = capacity && capacity > 0 ? capacity : 0;
    if (!cap) return null;
    const laden = this.seen.filter((o) => o.cargo >= cap * LADEN_FRACTION);
    if (!laden.length) return null;
    return Math.max(...laden.map((o) => o.ly));
  }

  /** The best jump seen with the hold effectively empty. */
  emptyLy(capacity: number | null | undefined): number | null {
    const cap = capacity && capacity > 0 ? capacity : 0;
    const empty = this.seen.filter((o) => o.cargo < Math.max(1, cap * LADEN_FRACTION));
    if (!empty.length) return null;
    return Math.max(...empty.map((o) => o.ly));
  }

  toJSON(): JumpObservation[] {
    return this.seen;
  }

  load(rows: unknown): void {
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const o = r as { ly?: unknown; cargo?: unknown; at?: unknown };
      const ly = num(o.ly);
      const cargo = num(o.cargo);
      const at = num(o.at);
      if (ly == null || ly <= 0) continue;
      this.seen.push({ ly, cargo: cargo ?? 0, at: at ?? 0 });
    }
    if (this.seen.length > KEEP) this.seen = this.seen.slice(-KEEP);
  }
}

/** Where a jump-range figure came from, so the panel never overstates it. */
export type RangeBasis = 'laden' | 'empty' | 'rated';

export interface ReachEstimate {
  /** Light years per jump used for the arithmetic. */
  rangeLy: number;
  basis: RangeBasis;
}

/**
 * The range to plan with, and an honest label for where it came from.
 *
 * Measured laden beats measured empty beats the outfitting screen's number,
 * because each is a better description of the ship that will actually be
 * making the trip.
 */
export function reachOf(
  jumps: JumpRange,
  capacity: number | null | undefined,
  ratedLy: number | null | undefined,
): ReachEstimate | null {
  const laden = jumps.ladenLy(capacity);
  if (laden) return { rangeLy: laden, basis: 'laden' };
  const empty = jumps.emptyLy(capacity);
  if (empty) return { rangeLy: empty, basis: 'empty' };
  return ratedLy && ratedLy > 0 ? { rangeLy: ratedLy, basis: 'rated' } : null;
}

/**
 * Jumps to cover a distance — never fewer than one for any real distance.
 *
 * Deliberately a floor rather than a route: real plotting is rarely a straight
 * line and a sparse region forces detours, so this is the best case and the
 * panel says "about". Zero distance is zero jumps, which is what "in system"
 * means.
 */
export function jumpsFor(distanceLy: number | null, range: ReachEstimate | null): number | null {
  if (distanceLy == null || !range || range.rangeLy <= 0) return null;
  if (distanceLy <= 0) return 0;
  return Math.max(1, Math.ceil(distanceLy / range.rangeLy));
}

/** "about 14 jumps at 33.2 ly laden" — the reasoning, not just the number. */
export function describeReach(range: ReachEstimate | null): string | null {
  if (!range) return null;
  const ly = `${Math.round(range.rangeLy * 10) / 10} ly`;
  return range.basis === 'laden'
    ? `${ly} laden — your longest jump with a loaded hold`
    : range.basis === 'empty'
      ? `${ly} empty — you have not jumped loaded yet, so a full hold will do worse`
      : `${ly} rated — the outfitting figure, which is the EMPTY range`;
}
