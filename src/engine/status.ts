/**
 * Status.json — the game's high-frequency real-time ship telemetry.
 *
 * ED rewrites Status.json several times a second with a `Flags` bitfield (ship
 * mode + warnings), a `Flags2` bitfield (Odyssey on-foot state), GUI focus,
 * pips, fuel, cargo, legal state and current destination. The operator watches
 * this file — nothing else in the journal reports "low fuel", "overheating",
 * "being interdicted" or "shields down" as they happen.
 *
 * This module is pure: `parseStatus` normalizes a snapshot; `StatusTracker`
 * folds successive snapshots and returns edge-triggered safety alerts (each
 * fires once per rising edge, so a steady state never re-nags). The store adds
 * its own combat-cooldown gating on top.
 */
import type { JournalEvent } from './types.ts';

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Status.json `Flags` bits (main-ship / SRV state + warnings). */
export const FLAG = {
  Docked: 1 << 0,
  Landed: 1 << 1,
  LandingGear: 1 << 2,
  ShieldsUp: 1 << 3,
  Supercruise: 1 << 4,
  FlightAssistOff: 1 << 5,
  HardpointsDeployed: 1 << 6,
  InWing: 1 << 7,
  LightsOn: 1 << 8,
  CargoScoopDeployed: 1 << 9,
  SilentRunning: 1 << 10,
  ScoopingFuel: 1 << 11,
  SrvHandbrake: 1 << 12,
  SrvTurret: 1 << 13,
  SrvUnderShip: 1 << 14,
  SrvDriveAssist: 1 << 15,
  FsdMassLocked: 1 << 16,
  FsdCharging: 1 << 17,
  FsdCooldown: 1 << 18,
  LowFuel: 1 << 19, // < 25 %
  Overheating: 1 << 20, // > 100 %
  HasLatLong: 1 << 21,
  InDanger: 1 << 22,
  BeingInterdicted: 1 << 23,
  InMainShip: 1 << 24,
  InFighter: 1 << 25,
  InSrv: 1 << 26,
  AnalysisMode: 1 << 27,
  NightVision: 1 << 28,
  AltitudeFromAverage: 1 << 29,
  FsdJump: 1 << 30,
  SrvHighBeam: 1 << 31,
} as const;

/** Status.json `Flags2` bits (Odyssey on-foot / environment). */
export const FLAG2 = {
  OnFoot: 1 << 0,
  InTaxi: 1 << 1,
  InMulticrew: 1 << 2,
  OnFootInStation: 1 << 3,
  OnFootOnPlanet: 1 << 4,
  AimDownSight: 1 << 5,
  LowOxygen: 1 << 6,
  LowHealth: 1 << 7,
  Cold: 1 << 8,
  Hot: 1 << 9,
  VeryCold: 1 << 10,
  VeryHot: 1 << 11,
  GlideMode: 1 << 12,
  OnFootInHangar: 1 << 13,
  OnFootSocialSpace: 1 << 14,
  OnFootExterior: 1 << 15,
  BreathableAtmosphere: 1 << 16,
  TelepresenceMulticrew: 1 << 17,
  PhysicalMulticrew: 1 << 18,
  FsdHyperdriveCharging: 1 << 19,
} as const;

const GUI_FOCUS: Record<number, string> = {
  0: 'none',
  1: 'right panel',
  2: 'left panel',
  3: 'comms panel',
  4: 'role panel',
  5: 'station services',
  6: 'galaxy map',
  7: 'system map',
  8: 'orrery',
  9: 'FSS',
  10: 'surface scanner',
  11: 'codex',
};

/** True when the GUI focus means the commander is deliberately busy in a menu
 *  (planning, station services, scanning) — used to suppress "idle" nudges. */
export function isBusyFocus(focus: number): boolean {
  return focus === 5 || focus === 6 || focus === 7 || focus === 8 || focus === 9 || focus === 10 || focus === 11;
}

/** Normalized snapshot of Status.json. */
export interface ShipStatus {
  raw: number; // Flags
  raw2: number; // Flags2
  docked: boolean;
  landed: boolean;
  supercruise: boolean;
  hardpoints: boolean;
  silentRunning: boolean;
  cargoScoop: boolean;
  scoopingFuel: boolean;
  shieldsUp: boolean;
  lowFuel: boolean;
  overheating: boolean;
  inDanger: boolean;
  beingInterdicted: boolean;
  fsdCharging: boolean;
  fsdMassLocked: boolean;
  nightVision: boolean;
  onFoot: boolean;
  lowOxygen: boolean;
  lowHealth: boolean;
  guiFocus: number;
  guiFocusLabel: string;
  /** [Sys, Eng, Wep], each 0–8 (the game reports half-pips as 0.5). */
  pips?: [number, number, number];
  /** Main-tank fuel fraction 0..1, when the snapshot carries capacity. */
  fuelPct?: number;
  fuelMain?: number;
  cargo?: number;
  legalState?: string;
  balance?: number;
  body?: string;
  /** Selected nav destination (Status.json `Destination`), when set. */
  destination?: { system?: string; body?: string; name?: string };
  /** On-foot life support / environment readouts, 0..1. */
  oxygen?: number;
  health?: number;
  timestamp: string;
}

function bit(flags: number, mask: number): boolean {
  return (flags & mask) !== 0;
}

/** Parse a Status.json snapshot object into a ShipStatus (null if not one). */
export function parseStatus(ev: JournalEvent): ShipStatus | null {
  const flags = num(ev.Flags);
  if (flags == null) return null;
  const flags2 = num(ev.Flags2) ?? 0;
  const focus = num(ev.GuiFocus) ?? 0;
  const pipsRaw = Array.isArray(ev.Pips) ? (ev.Pips as unknown[]) : undefined;
  const pips: [number, number, number] | undefined =
    pipsRaw && pipsRaw.length === 3
      ? [(num(pipsRaw[0]) ?? 0) / 2, (num(pipsRaw[1]) ?? 0) / 2, (num(pipsRaw[2]) ?? 0) / 2]
      : undefined;
  const fuel = ev.Fuel as { FuelMain?: number; FuelReservoir?: number } | undefined;
  const fuelMain = fuel && num(fuel.FuelMain);
  const dest = ev.Destination as { System?: number; Body?: number; Name?: string } | undefined;
  return {
    raw: flags,
    raw2: flags2,
    docked: bit(flags, FLAG.Docked),
    landed: bit(flags, FLAG.Landed),
    supercruise: bit(flags, FLAG.Supercruise),
    hardpoints: bit(flags, FLAG.HardpointsDeployed),
    silentRunning: bit(flags, FLAG.SilentRunning),
    cargoScoop: bit(flags, FLAG.CargoScoopDeployed),
    scoopingFuel: bit(flags, FLAG.ScoopingFuel),
    shieldsUp: bit(flags, FLAG.ShieldsUp),
    lowFuel: bit(flags, FLAG.LowFuel),
    overheating: bit(flags, FLAG.Overheating),
    inDanger: bit(flags, FLAG.InDanger),
    beingInterdicted: bit(flags, FLAG.BeingInterdicted),
    fsdCharging: bit(flags, FLAG.FsdCharging),
    fsdMassLocked: bit(flags, FLAG.FsdMassLocked),
    nightVision: bit(flags, FLAG.NightVision),
    onFoot: bit(flags2, FLAG2.OnFoot),
    lowOxygen: bit(flags2, FLAG2.LowOxygen),
    lowHealth: bit(flags2, FLAG2.LowHealth),
    guiFocus: focus,
    guiFocusLabel: GUI_FOCUS[focus] ?? 'none',
    pips,
    fuelMain: fuelMain ?? undefined,
    fuelPct: undefined, // filled by the tracker, which knows tank capacity
    cargo: num(ev.Cargo),
    legalState: str(ev.LegalState),
    balance: num(ev.Balance),
    body: str(ev.BodyName),
    destination:
      dest && (dest.Name || dest.System)
        ? { system: dest.System != null ? String(dest.System) : undefined, body: dest.Body != null ? String(dest.Body) : undefined, name: str(dest.Name) }
        : undefined,
    oxygen: num(ev.Oxygen),
    health: num(ev.Health),
    timestamp: str(ev.timestamp) ?? '',
  };
}

export type StatusAlertKind =
  | 'low-fuel'
  | 'overheating'
  | 'shields-down'
  | 'interdiction'
  | 'silent-running'
  | 'low-oxygen'
  | 'low-health'
  | 'legal-wanted';

export type StatusSeverity = 'info' | 'warn' | 'urgent';

export interface StatusAlert {
  kind: StatusAlertKind;
  severity: StatusSeverity;
  message: string;
}

/**
 * Folds Status.json snapshots and emits an alert on the RISING edge of each
 * hazard flag. Fuel-tank capacity is learned from Loadout (setFuelCapacity)
 * so `fuelPct` can be reported even though Status.json omits the tank size.
 */
export class StatusTracker {
  current: ShipStatus | null = null;
  private fuelCapacity = 0;

  /** Teach the tracker the main-tank size (from a Loadout event). */
  setFuelCapacity(tons: number): void {
    if (tons > 0) this.fuelCapacity = tons;
  }

  apply(ev: JournalEvent): StatusAlert[] {
    const next = parseStatus(ev);
    if (!next) return [];
    if (this.fuelCapacity > 0 && next.fuelMain != null) {
      next.fuelPct = Math.max(0, Math.min(1, next.fuelMain / this.fuelCapacity));
    }
    const prev = this.current;
    this.current = next;
    if (!prev) return []; // first snapshot: establish a baseline, don't alert
    const alerts: StatusAlert[] = [];
    const rose = (sel: (s: ShipStatus) => boolean): boolean => !sel(prev) && sel(next);

    // Being interdicted — the single most valuable real-time callout: it lets
    // the operator coach the submit-and-boost escape before the tether breaks.
    if (rose((s) => s.beingInterdicted)) {
      alerts.push({
        kind: 'interdiction',
        severity: 'urgent',
        message: 'Interdiction in progress — throttle to zero to submit, then boost clear once you drop.',
      });
    }
    if (rose((s) => s.overheating)) {
      alerts.push({
        kind: 'overheating',
        severity: 'urgent',
        message: 'Heat critical — ease the throttle, retract hardpoints, and vent before something cooks.',
      });
    }
    // Shields lost: only alert in a threat context, so undocking/normal drops
    // (shields also read "down" briefly on station approach) stay quiet.
    if (!next.shieldsUp && prev.shieldsUp && (next.inDanger || next.hardpoints || prev.hardpoints)) {
      alerts.push({
        kind: 'shields-down',
        severity: 'urgent',
        message: 'Shields are down — break off or boost to range until the ring rebuilds.',
      });
    }
    if (rose((s) => s.lowFuel)) {
      alerts.push({
        kind: 'low-fuel',
        severity: 'warn',
        message: 'Fuel below 25 percent — line up a scoopable star (class K, G, B, F, O, A or M) soon.',
      });
    }
    if (rose((s) => s.lowOxygen)) {
      alerts.push({
        kind: 'low-oxygen',
        severity: 'urgent',
        message: 'Oxygen low, commander — get back to breathable air or your ship.',
      });
    }
    if (rose((s) => s.lowHealth)) {
      alerts.push({
        kind: 'low-health',
        severity: 'urgent',
        message: 'Health critical — take cover and back off.',
      });
    }
    return alerts;
  }
}

const SCOOPABLE = new Set(['K', 'G', 'B', 'F', 'O', 'A', 'M']); // "KGB FOAM"

/** True when a main-sequence star class refuels the ship (fuel-scoopable). */
export function isScoopableStar(starClass: string | undefined): boolean {
  if (!starClass) return false;
  return SCOOPABLE.has(starClass.trim().charAt(0).toUpperCase());
}
