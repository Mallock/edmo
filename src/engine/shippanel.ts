/**
 * The at-a-glance ship readout that fills the HUD when no mission is selected.
 *
 * That space used to hold three buttons that also live in the chat bar, so it
 * was a large panel of nothing. Everything here is already folded from the
 * journal and Status.json — it just was not being shown: how much hold is
 * actually free, whether the tank will make the next jump, what a rebuy would
 * cost, and what unbanked value is riding along and would be lost with the ship.
 *
 * Pure module — unit-tested in tests/shippanel.test.ts.
 */
import type { ShipLoadout } from './ship.ts';

/** Internal hull ids the journal uses → the name a commander says out loud. */
const HULLS: Record<string, string> = {
  adder: 'Adder',
  anaconda: 'Anaconda',
  asp: 'Asp Explorer',
  asp_scout: 'Asp Scout',
  belugaliner: 'Beluga Liner',
  cobramkiii: 'Cobra Mk III',
  cobramkiv: 'Cobra Mk IV',
  cutter: 'Imperial Cutter',
  diamondback: 'Diamondback Scout',
  diamondbackxl: 'Diamondback Explorer',
  dolphin: 'Dolphin',
  eagle: 'Eagle',
  empire_courier: 'Imperial Courier',
  empire_eagle: 'Imperial Eagle',
  empire_trader: 'Imperial Clipper',
  federation_corvette: 'Federal Corvette',
  federation_dropship: 'Federal Dropship',
  federation_gunship: 'Federal Gunship',
  ferdelance: 'Fer-de-Lance',
  hauler: 'Hauler',
  independant_trader: 'Keelback',
  krait_light: 'Krait Phantom',
  krait_mkii: 'Krait Mk II',
  mamba: 'Mamba',
  mandalay: 'Mandalay',
  orca: 'Orca',
  panthermkii: 'Panther Clipper Mk II',
  python: 'Python',
  python_nx: 'Python Mk II',
  sidewinder: 'Sidewinder',
  type6: 'Type-6 Transporter',
  type7: 'Type-7 Transporter',
  type8: 'Type-8 Transporter',
  type9: 'Type-9 Heavy',
  type9_military: 'Type-10 Defender',
  typex: 'Alliance Chieftain',
  typex_2: 'Alliance Crusader',
  typex_3: 'Alliance Challenger',
  viper: 'Viper Mk III',
  viper_mkiv: 'Viper Mk IV',
  vulture: 'Vulture',
};

/** "type8" → "Type-8 Transporter"; unknown ids are tidied, never dropped. */
export function hullName(id?: string): string {
  if (!id) return 'Unknown hull';
  const k = id.toLowerCase();
  return HULLS[k] ?? k.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** A gauge the HUD draws: a label, a fraction, and the numbers behind it. */
export interface Gauge {
  label: string;
  /** 0..1, or null when the underlying reading is unknown. */
  fraction: number | null;
  text: string;
  /** Warn when it matters: hold full, tank low, hull damaged. */
  warn: boolean;
}

export interface ShipPanel {
  /** `rahtari · Type-8 Transporter · MA-26T` — whatever of it is known. */
  title: string;
  gauges: Gauge[];
  /** Short `label: value` facts, in the order they matter. */
  facts: Array<{ label: string; value: string }>;
  /** Value aboard that a rebuy would not cover — lost with the ship. */
  atRisk: string | null;
  /** Set when there is no Loadout yet, so the panel explains itself. */
  hint: string | null;
}

const cr = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`;

export interface ShipPanelInput {
  ship: ShipLoadout | null;
  /** Tons in the hold right now (Cargo.json), if known. */
  liveCargo: number | null;
  /** Main tank fraction from Status.json. */
  fuelPct: number | null;
  /** 0..1 from Loadout/HullDamage. */
  hullHealth: number | null;
  /** Completed bio samples not yet sold at Vista Genomics. */
  unsoldBio: number;
  /** Estimated value of cartographic data not yet sold. */
  unsoldCartoValue: number;
  /** Fleet carrier line, when they own one. */
  carrier: string | null;
  session: { jumps: number; distanceLy: number; earned: number } | null;
}

/**
 * Assemble the readout. Everything is optional: early in a session the journal
 * has not produced a Loadout yet, and a panel that renders half the truth is
 * better than one that renders nothing.
 */
export function buildShipPanel(i: ShipPanelInput): ShipPanel {
  const s = i.ship;
  const title = s
    ? [s.shipName, hullName(s.ship), s.shipIdent].filter(Boolean).join(' · ')
    : 'Ship unknown';

  const gauges: Gauge[] = [];
  if (s?.cargoCapacity) {
    const used = i.liveCargo ?? 0;
    const free = Math.max(0, s.cargoCapacity - used);
    gauges.push({
      label: 'CARGO',
      fraction: Math.min(1, used / s.cargoCapacity),
      // Free space is the number they are actually looking for, so lead with it.
      text: `${free} t free · ${used}/${s.cargoCapacity} t`,
      warn: free === 0,
    });
  }
  if (i.fuelPct != null) {
    gauges.push({
      label: 'FUEL',
      fraction: i.fuelPct,
      text: s?.fuelCapacity
        ? `${(i.fuelPct * s.fuelCapacity).toFixed(1)}/${s.fuelCapacity} t`
        : `${Math.round(i.fuelPct * 100)}%`,
      warn: i.fuelPct < 0.25,
    });
  }
  if (i.hullHealth != null && i.hullHealth < 1) {
    gauges.push({
      label: 'HULL',
      fraction: i.hullHealth,
      text: `${Math.round(i.hullHealth * 100)}%`,
      warn: i.hullHealth < 0.7,
    });
  }

  const facts: Array<{ label: string; value: string }> = [];
  if (s?.maxJumpRange) facts.push({ label: 'JUMP', value: `${s.maxJumpRange.toFixed(1)} ly` });
  if (s?.rebuy) facts.push({ label: 'REBUY', value: `${cr(s.rebuy)} cr` });
  if (s?.cabins.total) facts.push({ label: 'SEATS', value: `${s.cabins.total}` });
  if (i.carrier) facts.push({ label: 'CARRIER', value: i.carrier });
  if (i.session && (i.session.jumps || i.session.earned)) {
    facts.push({
      label: 'SESSION',
      value: `${i.session.jumps} jumps · ${i.session.distanceLy.toFixed(0)} ly${
        i.session.earned ? ` · +${cr(i.session.earned)} cr` : ''
      }`,
    });
  }

  // Unbanked exploration value dies with the ship, and no rebuy returns it —
  // which makes it the one number worth showing next to the rebuy cost.
  const risk: string[] = [];
  if (i.unsoldBio) risk.push(`${i.unsoldBio} bio sample${i.unsoldBio === 1 ? '' : 's'}`);
  if (i.unsoldCartoValue >= 100_000) risk.push(`~${cr(i.unsoldCartoValue)} cr of survey data`);

  return {
    title,
    gauges,
    facts,
    atRisk: risk.length ? `${risk.join(' · ')} aboard — unbanked` : null,
    hint: s ? null : 'Board your ship in-game and the loadout appears here.',
  };
}
