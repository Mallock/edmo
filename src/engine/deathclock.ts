/**
 * The Death Clock — landing-window timer for the World of Death.
 *
 * Spoihaae XE-X d2-9 A 1 («Monde de la Mort», made famous by Distant Worlds 3)
 * is a landable 1.17 g world on a wildly eccentric 0.06–2.5 ls orbit around a
 * white dwarf. Most of each orbit the planet is unreachable: too deep in the
 * dwarf's exclusion zone on the way in, bathed in the polar jets on the way
 * out. The community numbers (CMDR Solandri, via the DW3 organisers) give a
 * 1 h 27 m 53 s orbit that is clear from ~12 minutes after periapsis until
 * ~48 minutes before the next one — about 28 minutes of usable window.
 *
 * Where the phase comes from: since game v4.0 update 14, every journal `Scan`
 * of a body carries `MeanAnomaly` (degrees past periapsis at the scan
 * timestamp) and `OrbitalPeriod` (seconds). One FSS ping of A 1 therefore
 * calibrates the clock exactly — no eyeballing the orrery. Manual marks
 * ("I am watching periapsis happen right now") remain as a fallback for old
 * journals that predate the orbital-elements fields.
 *
 * Pure module: DeathClock folds journal events and holds calibration;
 * phaseOf() derives the live picture for any wall-clock instant; the
 * DeathClockAnnouncer turns successive phases into edge-triggered spoken
 * alerts, StatusTracker-style (each transition fires once, never re-nags).
 */
import type { JournalEvent } from './types.ts';

export const WOD_SYSTEM = 'Spoihaae XE-X d2-9';
export const WOD_BODY = 'Spoihaae XE-X d2-9 A 1';

/** Community timings — used until (and unless) a scan supplies real ones. */
export const WOD_DEFAULTS = {
  period: 5273, // s — 1 h 27 m 53 s orbit
  open: 720, // s after periapsis the approach clears
  close: 2393, // s after periapsis the jets take the planet back
  buffer: 180, // s of personal margin before `close`: the leave-by line
} as const;

export type DeathClockSource = 'scan' | 'mark';
export type DeathClockMarkKind = 'peri' | 'apo' | 'open' | 'close' | 'clear';
/** exclusion → clear → board (inside the window, past leave-by) → jet, wraps. */
export type DeathClockZone = 'exclusion' | 'clear' | 'board' | 'jet';

export interface DeathClockState {
  /** Wall-clock ms of a periapsis passage (any one — the orbit is periodic). */
  epochMs: number | null;
  period: number; // s
  open: number; // s after periapsis
  close: number; // s after periapsis
  buffer: number; // s before close — the leave-by margin
  source: DeathClockSource | null;
  /** When the calibration input happened (scan timestamp / mark time), ms. */
  calibratedAt: number | null;
}

export interface DeathClockWindow {
  opensAtMs: number;
  leaveByMs: number;
  closesAtMs: number;
  /** Seconds until this window opens; <= 0 means it is open right now. */
  startsInS: number;
}

export interface DeathClockPhase {
  /** Seconds since the last periapsis, [0, period). */
  t: number;
  zone: DeathClockZone;
  inWindow: boolean;
  /** The one number to watch: to open (hold), to leave-by (clear), to close (board). */
  countdownS: number;
  /** Seconds until the next window opens (0 while one is open). */
  opensInS: number;
  /** Seconds until the open window closes, or null outside one. */
  closesInS: number | null;
  /** Seconds to the next periapsis. */
  periInS: number;
  windows: DeathClockWindow[];
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** "M:SS" under an hour, "H:MM:SS" above. */
export function fmtDur(s: number): string {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Duration in words a voice can say: "45 seconds", "18 minutes", "2 hours". */
export function speakableDur(s: number): string {
  s = Math.max(0, Math.round(s));
  if (s <= 90) return `${s} seconds`;
  const totalMin = Math.round(s / 60);
  if (totalMin < 60) return `${totalMin} minute${totalMin === 1 ? '' : 's'}`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const hours = `${h} hour${h === 1 ? '' : 's'}`;
  return m ? `${hours} ${m} minute${m === 1 ? '' : 's'}` : hours;
}

// ---------------------------------------------------------------------------
// Orbit geometry — for the HUD's orbit strip only, not the timings.
// ---------------------------------------------------------------------------

const R_APO = 2.5; // ls
const R_PERI = 0.06; // ls
const SEMI_A = (R_APO + R_PERI) / 2;
const ECC = (R_APO - R_PERI) / (R_APO + R_PERI);
const SEMI_B = SEMI_A * Math.sqrt(1 - ECC * ECC);

/**
 * Planet position `t` seconds after periapsis, in orbit-plane light-seconds
 * with the white dwarf at the origin and periapsis on the +x axis.
 * Newton's method on Kepler's equation — eight rounds is plenty at e≈0.95.
 */
export function orbitXY(t: number, period: number): { x: number; y: number } {
  const M = 2 * Math.PI * (t / period);
  let E = M;
  for (let i = 0; i < 8; i++) {
    const f = E - ECC * Math.sin(E) - M;
    E -= f / (1 - ECC * Math.cos(E));
  }
  return { x: SEMI_A * (Math.cos(E) - ECC), y: SEMI_B * Math.sin(E) };
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

/** The live picture at `nowMs`, or null while uncalibrated. */
export function phaseOf(
  s: DeathClockState,
  nowMs: number,
  windowCount = 4,
): DeathClockPhase | null {
  if (s.epochMs == null) return null;
  const P = s.period;
  const t = ((((nowMs - s.epochMs) / 1000) % P) + P) % P;
  const leave = s.close - s.buffer;
  const inWindow = t >= s.open && t < s.close;
  const zone: DeathClockZone =
    t < s.open ? 'exclusion' : t < leave ? 'clear' : t < s.close ? 'board' : 'jet';
  const opensInS = inWindow ? 0 : t < s.open ? s.open - t : P - t + s.open;
  const countdownS = zone === 'clear' ? leave - t : zone === 'board' ? s.close - t : opensInS;

  // Openings counted from the CURRENT window when one is open (startsInS <= 0).
  const o0 = inWindow ? s.open - t : opensInS;
  const windows: DeathClockWindow[] = [];
  for (let k = 0; k < windowCount; k++) {
    const o = o0 + k * P;
    windows.push({
      opensAtMs: nowMs + o * 1000,
      leaveByMs: nowMs + (o + leave - s.open) * 1000,
      closesAtMs: nowMs + (o + s.close - s.open) * 1000,
      startsInS: Math.round(o),
    });
  }

  return {
    t,
    zone,
    inWindow,
    countdownS,
    opensInS,
    closesInS: inWindow ? s.close - t : null,
    periInS: P - t,
    windows,
  };
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/** Folds journal events and holds the clock's calibration. */
export class DeathClock {
  state: DeathClockState = {
    epochMs: null,
    calibratedAt: null,
    source: null,
    ...WOD_DEFAULTS,
  };

  /**
   * A `Scan` of A 1 recalibrates the clock from the journal's own orbital
   * elements: MeanAnomaly advances 360° per period, so degrees / 360 × period
   * is exactly "seconds since periapsis" at the scan's timestamp. Returns true
   * when the event (re)calibrated the clock. Old journals replayed at startup
   * calibrate too — the orbit is periodic, so any past fix stays valid.
   */
  apply(ev: JournalEvent): boolean {
    if (ev.event !== 'Scan') return false;
    const body = typeof ev.BodyName === 'string' ? ev.BodyName : '';
    if (body.trim().toLowerCase() !== WOD_BODY.toLowerCase()) return false;
    const period = num(ev.OrbitalPeriod);
    const anomaly = num(ev.MeanAnomaly); // degrees; absent before v4.0 U14
    const at = Date.parse(typeof ev.timestamp === 'string' ? ev.timestamp : '');
    if (period == null || period < 60 || anomaly == null || !Number.isFinite(at)) return false;
    const frac = (((anomaly / 360) % 1) + 1) % 1;
    this.state = {
      ...this.state,
      period,
      epochMs: at - frac * period * 1000,
      source: 'scan',
      calibratedAt: at,
    };
    return true;
  }

  /** Manual fallback: "this orbital event is happening right now". */
  mark(kind: DeathClockMarkKind, nowMs: number): void {
    if (kind === 'clear') {
      this.state = { ...this.state, epochMs: null, source: null, calibratedAt: null };
      return;
    }
    const off = {
      peri: 0,
      open: this.state.open,
      close: this.state.close,
      apo: this.state.period / 2,
    }[kind];
    this.state = { ...this.state, epochMs: nowMs - off * 1000, source: 'mark', calibratedAt: nowMs };
  }

  toJSON(): DeathClockState {
    return this.state;
  }

  /** Restore a persisted state; garbage fields fall back to defaults. */
  load(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    const s = { ...this.state };
    const epoch = num(r.epochMs);
    if (epoch !== undefined) s.epochMs = epoch;
    const calAt = num(r.calibratedAt);
    if (calAt !== undefined) s.calibratedAt = calAt;
    if (r.source === 'scan' || r.source === 'mark') s.source = r.source;
    for (const k of ['period', 'open', 'close', 'buffer'] as const) {
      const v = num(r[k]);
      if (v !== undefined && v >= 0) s[k] = v;
    }
    // Timing sanity — a nonsense geometry reverts to the community numbers.
    if (s.period < 60 || s.open >= s.close || s.close > s.period || s.buffer >= s.close - s.open) {
      s.period = WOD_DEFAULTS.period;
      s.open = WOD_DEFAULTS.open;
      s.close = WOD_DEFAULTS.close;
      s.buffer = WOD_DEFAULTS.buffer;
    }
    this.state = s;
  }
}

// ---------------------------------------------------------------------------
// Spoken alerts
// ---------------------------------------------------------------------------

export type DeathClockAlertKind =
  | 'arrival'
  | 'opens-soon'
  | 'window-open'
  | 'leave-by'
  | 'window-closed';

export interface DeathClockAlert {
  kind: DeathClockAlertKind;
  severity: 'info' | 'warn' | 'urgent';
  message: string;
}

/** Pre-warning lead time: "window opens in five minutes, get into position". */
const OPENS_SOON_S = 300;

function arrivalMessage(p: DeathClockPhase): string {
  if (p.zone === 'clear')
    return `World of Death — the landing window is open: ${speakableDur(p.countdownS)} until leave-by.`;
  if (p.zone === 'board')
    return `World of Death — the window is closing: ${speakableDur(p.countdownS)} left. Too late to start a descent.`;
  return `World of Death on the clock — hold off the planet. Next landing window opens in ${speakableDur(p.opensInS)}.`;
}

/**
 * Folds successive phases into edge-triggered alerts: one on system entry
 * (the current picture), one per zone transition that matters, one pre-open
 * warning per cycle. Outside the system it stays silent and re-arms.
 */
export class DeathClockAnnouncer {
  private wasInSystem = false;
  private lastZone: DeathClockZone | null = null;
  private warnedOpensSoon = false;

  /** Mark the current phase as already communicated — a calibration line just
   *  spoke the same picture — so the next tick doesn't repeat it as arrival. */
  prime(phase: DeathClockPhase | null, inSystem: boolean): void {
    this.wasInSystem = inSystem;
    this.lastZone = phase?.zone ?? null;
    this.warnedOpensSoon = phase != null && phase.opensInS <= OPENS_SOON_S;
  }

  tick(phase: DeathClockPhase | null, inSystem: boolean): DeathClockAlert[] {
    const entered = inSystem && !this.wasInSystem;
    this.wasInSystem = inSystem;
    if (!inSystem) {
      this.lastZone = null;
      this.warnedOpensSoon = false;
      return [];
    }
    if (!phase) {
      this.lastZone = null;
      return entered
        ? [
            {
              kind: 'arrival',
              severity: 'info',
              message:
                "This is the World of Death. The death clock isn't calibrated — scan planet A 1 and it sets itself.",
            },
          ]
        : [];
    }
    const alerts: DeathClockAlert[] = [];
    const z = phase.zone;
    if (this.lastZone === null) {
      alerts.push({
        kind: 'arrival',
        severity: z === 'board' ? 'urgent' : 'info',
        message: arrivalMessage(phase),
      });
    } else if (z !== this.lastZone) {
      if (z === 'clear') {
        alerts.push({
          kind: 'window-open',
          severity: 'warn',
          message: `Landing window open — clear to land. ${speakableDur(phase.countdownS)} until leave-by.`,
        });
      } else if (z === 'board' && this.lastZone === 'clear') {
        alerts.push({
          kind: 'leave-by',
          severity: 'urgent',
          message: `Leave-by reached — recall and board now. The window shuts in ${speakableDur(phase.countdownS)}.`,
        });
      } else if (
        (z === 'jet' || z === 'exclusion') &&
        (this.lastZone === 'clear' || this.lastZone === 'board')
      ) {
        alerts.push({
          kind: 'window-closed',
          severity: 'warn',
          message: `Window closed — hold clear of the planet. Next window in ${speakableDur(phase.opensInS)}.`,
        });
      }
    }
    // One pre-open call per cycle; re-arms whenever the next opening is far.
    if (phase.opensInS > OPENS_SOON_S) {
      this.warnedOpensSoon = false;
    } else if (z === 'jet' || z === 'exclusion') {
      const say = !this.warnedOpensSoon && alerts.length === 0;
      this.warnedOpensSoon = true;
      if (say) {
        alerts.push({
          kind: 'opens-soon',
          severity: 'info',
          message: `Landing window opens in ${speakableDur(phase.opensInS)} — get into position.`,
        });
      }
    }
    this.lastZone = z;
    return alerts;
  }
}
