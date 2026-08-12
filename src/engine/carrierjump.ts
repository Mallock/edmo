/**
 * The two clocks a carrier run is actually paced by.
 *
 * A fleet carrier jump is not an action, it is a schedule. You plot it, the
 * carrier locks down for about a quarter of an hour, it jumps, and then it
 * cannot jump again for five minutes. Running a 44-jump route to the far side
 * of the galaxy means living inside that cycle for hours — and the game shows
 * the countdown only on the carrier management panel, which is not where the
 * commander is looking while they mine, scoop or fly.
 *
 * Both numbers come from the journal rather than from folklore:
 *
 *   CarrierJumpRequest carries DepartureTime — the exact instant of the jump,
 *   so the lockdown countdown is authoritative and needs no constant.
 *
 *   The cooldown was MEASURED from a live run. Arrival at 12:37:10, the next
 *   request accepted at 12:42:12 — a commander clicking two seconds after it
 *   cleared. Five minutes, from arrival.
 *
 * Pure module — unit-tested in tests/carrierjump.test.ts.
 */
import type { JournalEvent } from './types.ts';

/** Seconds after arrival before the carrier will accept another jump. */
export const CARRIER_COOLDOWN_S = 300;

export type CarrierPhase =
  /** No carrier, or nothing known about its jumps yet. */
  | { kind: 'idle' }
  /** A jump is scheduled: locked down until it goes. */
  | { kind: 'countdown'; system: string; secondsLeft: number }
  /** Just arrived; cannot plot the next hop yet. */
  | { kind: 'cooldown'; secondsLeft: number }
  /** Cooldown served — the next jump can be plotted now. */
  | { kind: 'ready' };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const ms = (v: unknown): number | null => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : null;
};

/** "M:SS" — the digital readout, always at least one minute digit. */
export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

/** Everything the clocks need, as plain data the UI can hold and re-read. */
export interface CarrierJumpState {
  pending: { system: string; departureMs: number } | null;
  arrivedMs: number | null;
  system: string | null;
}

/**
 * The live phase for any instant.
 *
 * Pure and separate from the tracker so the card can recompute it every second
 * against its own clock — the store's snapshot only rebuilds on the 15 s
 * heartbeat, and a digital counter that moves in 15 s steps is not a counter.
 */
export function phaseOf(state: CarrierJumpState, nowMs: number): CarrierPhase {
  if (state.pending) {
    const left = (state.pending.departureMs - nowMs) / 1000;
    // Past its departure time but no arrival yet — the jump is happening.
    // Report zero rather than counting into negatives.
    return { kind: 'countdown', system: state.pending.system, secondsLeft: Math.max(0, left) };
  }
  if (state.arrivedMs != null) {
    const since = (nowMs - state.arrivedMs) / 1000;
    if (since < CARRIER_COOLDOWN_S) return { kind: 'cooldown', secondsLeft: CARRIER_COOLDOWN_S - since };
    return { kind: 'ready' };
  }
  return { kind: 'idle' };
}

export class CarrierJumpTracker {
  /** The scheduled jump, or null when none is pending. */
  private pending: { system: string; departureMs: number } | null = null;
  /** When the carrier last actually arrived somewhere. */
  private arrivedMs: number | null = null;
  /** Where the carrier is, used to tell an arrival from a status refresh. */
  private system: string | null = null;

  /** Plain-data view, for the snapshot and for persistence. */
  get state(): CarrierJumpState {
    return { pending: this.pending, arrivedMs: this.arrivedMs, system: this.system };
  }

  apply(ev: JournalEvent): void {
    switch (ev.event) {
      case 'CarrierJumpRequest': {
        const departureMs = ms(ev.DepartureTime);
        const system = str(ev.SystemName);
        if (departureMs != null && system) this.pending = { system, departureMs };
        break;
      }
      case 'CarrierJumpCancelled':
        this.pending = null;
        break;
      case 'CarrierLocation':
      case 'CarrierJump': {
        const system = str(ev.StarSystem);
        if (!system) break;
        // CarrierLocation ALSO fires as a periodic status refresh — four times
        // in one evening while the carrier sat in Tir. Treating every one as an
        // arrival would restart the cooldown at random and tell the commander
        // to wait when they could already plot. An arrival is a system that
        // changed, or one that matches the jump we were waiting on.
        //
        // The FIRST sighting is neither. Before it we knew nothing about where
        // the carrier was, so "it is somewhere new" is not news of a jump — it
        // is the app learning the carrier exists. Counting it started a phantom
        // cooldown for every commander who owns a carrier and has not plotted
        // anything, and five minutes later the operator announced it was clear
        // to jump a route that was never plotted.
        const arrived = this.pending?.system === system || (this.system !== null && system !== this.system);
        if (arrived) {
          this.arrivedMs = ms(ev.timestamp) ?? Date.now();
          this.pending = null;
        }
        this.system = system;
        break;
      }
      default:
        break;
    }
  }

  /** Where the carrier is heading, while a jump is scheduled. */
  get destination(): string | null {
    return this.pending?.system ?? null;
  }

  /** The live phase for this instant. */
  phase(nowMs: number): CarrierPhase {
    return phaseOf(this.state, nowMs);
  }

  toJSON(): CarrierJumpState {
    return this.state;
  }

  load(d: CarrierJumpState | null, nowMs: number = Date.now()): void {
    if (!d) return;
    if (d.pending && typeof d.pending.departureMs === 'number') this.pending = d.pending;
    // A cooldown that finished before the app was even started tells the
    // commander nothing — restoring it only makes the card claim READY TO JUMP
    // about a jump made days ago. Keep an arrival only while it is still
    // running its clock; an expired one is dropped back to idle.
    if (typeof d.arrivedMs === 'number' && nowMs - d.arrivedMs < CARRIER_COOLDOWN_S * 1000) {
      this.arrivedMs = d.arrivedMs;
    }
    if (typeof d.system === 'string') this.system = d.system;
  }
}

/** One line for the card / the operator, or null when there is nothing to say. */
export function describePhase(phase: CarrierPhase): string | null {
  switch (phase.kind) {
    case 'countdown':
      return `Carrier jumps to ${phase.system} in ${fmtClock(phase.secondsLeft)}.`;
    case 'cooldown':
      return `Carrier cooling down — it will accept the next jump in ${fmtClock(phase.secondsLeft)}.`;
    case 'ready':
      return 'Carrier is ready to jump — plot the next hop.';
    default:
      return null;
  }
}

/**
 * Edge-triggered spoken alerts, StatusTracker-style: each transition fires
 * once and never nags again.
 *
 * Only the two edges a commander is actually waiting on. The point of the
 * cooldown clock is that they can go and do something else — mine the tritium
 * for the next hop — and be told when it is worth coming back.
 */
export class CarrierJumpAnnouncer {
  private saidDeparture = '';
  /**
   * Whether a cooldown this announcer actually watched is still owed its
   * "clear" call.
   *
   * Strictly edge-triggered, because 'ready' is not an event — it is the
   * resting state the carrier sits in for the rest of the evening. Anything
   * time-based here (the old "once per cooldown length" gate) turns that
   * resting state into a nag every five minutes, and speaks on the very first
   * tick to a commander who never plotted anything. The call is only worth
   * making to someone who was waiting for it: we saw the cooldown start, so we
   * say when it ends, once.
   */
  private readyOwed = false;

  /** The line to speak now, or null. */
  next(phase: CarrierPhase): string | null {
    if (phase.kind === 'countdown' && phase.secondsLeft <= 60) {
      const key = `${phase.system}@${Math.round(phase.secondsLeft / 60)}`;
      if (this.saidDeparture !== key) {
        this.saidDeparture = key;
        return `Carrier jumps to ${phase.system} in about a minute.`;
      }
    }
    if (phase.kind === 'cooldown') this.readyOwed = true; // watched it start
    if (phase.kind === 'ready' && this.readyOwed) {
      this.readyOwed = false;
      return 'Carrier is clear to jump again, commander.';
    }
    return null;
  }
}
