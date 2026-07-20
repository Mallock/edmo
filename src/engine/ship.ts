/**
 * Ship loadout intelligence — folds the journal `Loadout` event so the operator
 * can answer the questions the mission board never checks for you:
 *   - "Do I have cargo room for this delivery?" (cargo racks vs mission Count)
 *   - "Do I have cabins for these passengers, at the right class?"
 *   - "Can my jump range even reach that expedition?"
 *   - "Am I fitted for this — collector limpets for salvage, a refinery to mine?"
 *
 * `Loadout` reports the game's own `MaxJumpRange` and `CargoCapacity`, so we
 * take those verbatim; cabin seats are summed from the module list against the
 * real capacity table (verified from Coriolis module data).
 */
import type { JournalEvent, Mission } from './types.ts';

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Passenger seats per module Size for each cabin class (1=Econ … 4=Luxury). */
const CABIN_SEATS: Record<number, Record<number, number>> = {
  1: { 2: 2, 3: 4, 4: 8, 5: 16, 6: 32 }, // Economy
  2: { 3: 3, 4: 6, 5: 10, 6: 16 }, // Business
  3: { 4: 3, 5: 6, 6: 12 }, // First
  4: { 5: 4, 6: 8 }, // Luxury
};

const CABIN_CLASS_NAME: Record<number, string> = {
  1: 'Economy',
  2: 'Business',
  3: 'First',
  4: 'Luxury',
};

export interface CabinTally {
  economy: number;
  business: number;
  first: number;
  luxury: number;
  /** Total seats across all cabins. */
  total: number;
}

export interface ShipLoadout {
  ship?: string; // hull internal id ("cutter")
  shipName?: string;
  shipIdent?: string;
  maxJumpRange?: number; // ly, game-reported
  cargoCapacity: number; // tons
  fuelCapacity?: number; // main tank, tons
  fuelReserve?: number;
  rebuy?: number;
  cabins: CabinTally;
  hasFuelScoop: boolean;
  hasRefinery: boolean;
  hasCollectorLimpet: boolean;
  hasProspectorLimpet: boolean;
  hasShieldGenerator: boolean;
  hasFsdInterdictor: boolean;
  hasSurfaceScanner: boolean;
}

const EMPTY_CABINS: CabinTally = { economy: 0, business: 0, first: 0, luxury: 0, total: 0 };

/** Parse a `Loadout` event into a normalized ShipLoadout. */
export function parseLoadout(ev: JournalEvent): ShipLoadout {
  const modules = Array.isArray(ev.Modules) ? (ev.Modules as Array<Record<string, unknown>>) : [];
  const cabins: CabinTally = { ...EMPTY_CABINS };
  let hasFuelScoop = false;
  let hasRefinery = false;
  let hasCollectorLimpet = false;
  let hasProspectorLimpet = false;
  let hasShieldGenerator = false;
  let hasFsdInterdictor = false;
  let hasSurfaceScanner = false;

  for (const mod of modules) {
    const item = (str(mod.Item) ?? '').toLowerCase();
    if (!item) continue;
    const cab = /int_passengercabin_size(\d+)_class(\d+)/.exec(item);
    if (cab) {
      const size = Number(cab[1]);
      const cls = Number(cab[2]);
      const seats = CABIN_SEATS[cls]?.[size] ?? 0;
      cabins.total += seats;
      if (cls === 1) cabins.economy += seats;
      else if (cls === 2) cabins.business += seats;
      else if (cls === 3) cabins.first += seats;
      else if (cls === 4) cabins.luxury += seats;
      continue;
    }
    if (item.includes('fuelscoop')) hasFuelScoop = true;
    else if (item.includes('refinery')) hasRefinery = true;
    else if (item.includes('dronecontrol_collection') || item.includes('dronecontrol_universal'))
      hasCollectorLimpet = true;
    else if (item.includes('dronecontrol_prospector')) hasProspectorLimpet = true;
    else if (item.includes('shieldgenerator')) hasShieldGenerator = true;
    else if (item.includes('fsdinterdictor')) hasFsdInterdictor = true;
    else if (item.includes('detailedsurfacescanner')) hasSurfaceScanner = true;
    // The universal limpet controller also prospects.
    if (item.includes('dronecontrol_universal')) hasProspectorLimpet = true;
  }

  const fuel = ev.FuelCapacity as { Main?: number; Reserve?: number } | undefined;
  return {
    ship: str(ev.Ship),
    shipName: str(ev.ShipName),
    shipIdent: str(ev.ShipIdent),
    maxJumpRange: num(ev.MaxJumpRange),
    cargoCapacity: num(ev.CargoCapacity) ?? 0,
    fuelCapacity: fuel && num(fuel.Main),
    fuelReserve: fuel && num(fuel.Reserve),
    rebuy: num(ev.Rebuy),
    cabins,
    hasFuelScoop,
    hasRefinery,
    hasCollectorLimpet,
    hasProspectorLimpet,
    hasShieldGenerator,
    hasFsdInterdictor,
    hasSurfaceScanner,
  };
}

/**
 * Hulls that can only berth at a LARGE pad — internal journal `Ship` ids,
 * lowercased. Large ships get "docking denied — too large for this pad class"
 * at medium/small outposts and most surface settlements, so a trade planner
 * must be told to exclude those stops (Spansh `requires_large_pad`). This is
 * the full large-pad roster; every other hull fits a medium (or smaller) pad.
 */
const LARGE_PAD_SHIPS = new Set([
  'anaconda',
  'federation_corvette', // Federal Corvette
  'cutter', // Imperial Cutter
  'type9', // Type-9 Heavy
  'type9_military', // Type-10 Defender
  'type7', // Type-7 Transporter
  'empire_trader', // Imperial Clipper
  'belugaliner', // Beluga Liner
  'orca', // Orca
  'panther_clipper', // Panther Clipper Mk II
]);

/**
 * True when the hull needs a large pad, so trade/mission stops must have one.
 * Unknown or missing ship → false (don't over-filter routes for the many
 * medium/small hulls); `panther` is matched loosely in case the id varies.
 */
export function shipRequiresLargePad(ship?: string): boolean {
  if (!ship) return false;
  const id = ship.toLowerCase();
  return LARGE_PAD_SHIPS.has(id) || id.includes('panther');
}

/** Cabin quality a passenger flavor demands (best-effort from PassengerType). */
function requiredCabinClass(m: Mission): number {
  if (m.category === 'PassengerVIP') return 3; // VIPs ride First or better
  return 1; // bulk / tourist → Economy is fine
}

/** Seats available at `minClass` or better (higher quality accepts lower). */
function seatsAtOrAbove(cabins: CabinTally, minClass: number): number {
  let seats = 0;
  if (minClass <= 1) seats += cabins.economy;
  if (minClass <= 2) seats += cabins.business;
  if (minClass <= 3) seats += cabins.first;
  seats += cabins.luxury; // luxury accepts everyone
  return seats;
}

/**
 * Fit note for a just-accepted (or active) mission against the current ship —
 * flags the "you can't actually carry this" traps: no cargo room, no cabins,
 * wrong cabin class, not fitted to mine/salvage, expedition beyond jump range.
 * Returns null when nothing is worth saying. Labelled as a check, since the
 * live cargo hold is only known when Cargo.json says so.
 */
export function fitNote(m: Mission, ship: ShipLoadout, liveCargo?: number): string | null {
  const bits: string[] = [];

  if (m.commodity && (m.category === 'Delivery' || m.category === 'DeliveryWing' || m.category === 'Collect')) {
    const need = m.commodity.count;
    const free = liveCargo != null ? ship.cargoCapacity - liveCargo : ship.cargoCapacity;
    if (ship.cargoCapacity > 0 && need > ship.cargoCapacity) {
      bits.push(`needs ${need} t but the hold is only ${ship.cargoCapacity} t — this won't fit in one run`);
    } else if (liveCargo != null && need > free) {
      bits.push(`needs ${need} t and only ${Math.max(0, free)} t is free — clear space first`);
    }
  }

  if (m.category === 'Collect' && !ship.hasCollectorLimpet) {
    bits.push('no collector limpet controller fitted — you may need one to scoop the goods');
  }
  if (m.category === 'Salvage' && !ship.hasCollectorLimpet) {
    bits.push('no collector limpet controller — salvage cargo is easier to scoop with one');
  }
  if (m.category === 'Mining' && !(ship.hasRefinery && ship.hasProspectorLimpet)) {
    const miss = [!ship.hasRefinery && 'a refinery', !ship.hasProspectorLimpet && 'a prospector limpet controller']
      .filter(Boolean)
      .join(' and ');
    bits.push(`not rigged to mine — missing ${miss}`);
  }

  if (m.passengers && (m.category === 'PassengerBulk' || m.category === 'PassengerVIP' || m.category === 'Sightseeing')) {
    const need = m.passengers.count;
    const cls = requiredCabinClass(m);
    if (ship.cabins.total === 0) {
      bits.push('no passenger cabins fitted at all — you cannot board them');
    } else {
      const seats = seatsAtOrAbove(ship.cabins, cls);
      if (seats < need) {
        const q = cls > 1 ? ` ${CABIN_CLASS_NAME[cls]}-class or better` : '';
        bits.push(`needs ${need}${q} seats but only ${seats} are fitted`);
      }
    }
  }

  if (m.category === 'LongDistanceExpedition' && ship.maxJumpRange && ship.maxJumpRange < 20) {
    bits.push(`your jump range is ${ship.maxJumpRange.toFixed(1)} ly — a long expedition will crawl; consider a longer-legged ship`);
  }

  if (!bits.length) return null;
  return `Fit check: ${bits.join('; ')}.`;
}

/** Compact ship line for the LLM context payload. */
export function describeShip(ship: ShipLoadout): string {
  const bits: string[] = [];
  if (ship.shipName) bits.push(`Ship "${ship.shipName}"${ship.ship ? ` (${ship.ship})` : ''}`);
  else if (ship.ship) bits.push(`Ship ${ship.ship}`);
  if (ship.maxJumpRange) bits.push(`max jump ${ship.maxJumpRange.toFixed(1)} ly`);
  if (ship.cargoCapacity) bits.push(`cargo ${ship.cargoCapacity} t`);
  if (ship.cabins.total) {
    const cls: string[] = [];
    if (ship.cabins.economy) cls.push(`${ship.cabins.economy} economy`);
    if (ship.cabins.business) cls.push(`${ship.cabins.business} business`);
    if (ship.cabins.first) cls.push(`${ship.cabins.first} first`);
    if (ship.cabins.luxury) cls.push(`${ship.cabins.luxury} luxury`);
    bits.push(`${ship.cabins.total} passenger seats (${cls.join(', ')})`);
  }
  const fittings: string[] = [];
  if (ship.hasFuelScoop) fittings.push('fuel scoop');
  if (ship.hasRefinery) fittings.push('refinery');
  if (ship.hasCollectorLimpet) fittings.push('collector limpets');
  if (ship.hasProspectorLimpet) fittings.push('prospector limpets');
  if (!ship.hasShieldGenerator) fittings.push('NO shields');
  if (fittings.length) bits.push(fittings.join(', '));
  return bits.join(' · ');
}

/** Folds Loadout events; keeps the current ship + live cargo tonnage. */
export class ShipTracker {
  current: ShipLoadout | null = null;
  /** Live cargo tonnage from Cargo.json, when known. */
  liveCargo: number | undefined;

  apply(ev: JournalEvent): void {
    if (ev.event === 'Loadout') this.current = parseLoadout(ev);
  }

  /** Update live cargo from a Cargo.json snapshot's `Count`. */
  setCargo(tons: number | undefined): void {
    this.liveCargo = tons;
  }

  fitNote(m: Mission): string | null {
    if (!this.current) return null;
    return fitNote(m, this.current, this.liveCargo);
  }
}
