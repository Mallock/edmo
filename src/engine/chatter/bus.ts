/**
 * Two buses, and the rules that keep ambience out of the way.
 *
 * This is the load-bearing decision of the whole comms feature (design.md D2).
 * The app already has ONE speech queue: src/ui/tts.ts serializes everything,
 * so an utterance waits for whatever is in front of it. Chatter is high volume
 * and low importance; pushing it through that queue would put a dock worker's
 * joke in front of "hull at twenty-two percent".
 *
 * So there are two buses:
 *
 *   PRIORITY — the operator, hazard callouts, the newsreader, the saga.
 *              Serialized, de-duplicated, never gated by anything on AMBIENT.
 *   AMBIENT  — comms traffic. Ducks under PRIORITY, drops when it backs up,
 *              and discards anything that has gone stale rather than speaking
 *              late. Arrival traffic control heard four minutes after the
 *              clamps engaged is worse than silence.
 *
 * The arithmetic and the queue policy live here, DOM-free, so they can be
 * tested without an audio device. src/ui/radio.ts owns the actual gain nodes
 * and applies these numbers to them.
 */

export type BusId = 'PRIORITY' | 'AMBIENT' | 'MUSIC' | 'TOWER';

/**
 * TOWER is the fourth bus, and it exists because of a category error in the
 * first three.
 *
 * AMBIENT is atmosphere: people talking to each other, none of it addressed
 * to the commander, all of it droppable. PRIORITY is the operator — the app's
 * own voice, speaking about the commander in the third person.
 *
 * Traffic control calling YOUR ship by name is neither. It is not atmosphere,
 * because it is addressed to you and answering it is the difference between
 * docking and being shot at; and it is not the operator, because it comes
 * from the world rather than from the app. Putting it on AMBIENT meant it
 * could be dropped for a queue of dockside gossip. Putting it on PRIORITY
 * would have it compete with hull-breach callouts.
 *
 * So: it ducks under PRIORITY (nothing outranks the hull), ambience ducks
 * under IT (chatter gets out of the way when the tower calls), and music
 * drops as hard for it as for the operator, because a clearance you did not
 * hear is a clearance you did not get.
 */
export const TOWER_DUCK_PRIORITY_DB = -10;

/** How far AMBIENT drops while the tower is talking to this ship. */
export const AMBIENT_DUCK_TOWER_DB = -11;

/** How far AMBIENT drops while PRIORITY is sounding. */
export const DUCK_DB = -14;

/**
 * MUSIC is the third bus: internet radio the commander chose to have on.
 *
 * It ducks under BOTH speaking buses, and by different amounts, because the
 * two mean different things. The operator talking is the one thing the
 * commander must not miss, so music drops hard and gets out of the way.
 * Comms traffic is atmosphere talking to atmosphere — the radio only thins,
 * the way a cab radio does when someone speaks over it, and both are heard.
 */
export const MUSIC_DUCK_PRIORITY_DB = -20;
export const MUSIC_DUCK_AMBIENT_DB = -9;
/** Addressed to this ship, so it gets the operator's depth, not ambience's. */
export const MUSIC_DUCK_TOWER_DB = -20;

/** How long the ambient bus takes to come back up. A step reads as a glitch;
 *  a ramp reads as someone turning a dial. */
export const DUCK_RESTORE_MS = 400;

/** Ducking down is faster than coming back — the important voice must not be
 *  masked by the first syllable of a fade. */
export const DUCK_ATTACK_MS = 80;

/** How many transmissions may wait on AMBIENT before the oldest is dropped.
 *  Matches EDCoPilot's ChatterSpeechMaxQueueLength=4 instinct, one tighter. */
export const AMBIENT_QUEUE_CAP = 3;

/** Default staleness for a queued transmission when it does not set its own. */
export const DEFAULT_TTL_MS = 90_000;

/**
 * The ambient bus gain, in dB, for a given state.
 *
 * Kept as a function rather than a constant because the caller's configured
 * level is a user setting: ducking is relative to wherever they left the
 * slider, not an absolute target.
 */
export function ambientGainDb(
  configuredDb: number,
  priorityActive: boolean,
  towerActive = false,
): number {
  // The deeper duck wins. Chatter gets out of the way for both, but the
  // operator outranks the tower — nothing outranks the hull.
  if (priorityActive) return configuredDb + DUCK_DB;
  if (towerActive) return configuredDb + AMBIENT_DUCK_TOWER_DB;
  return configuredDb;
}

/** The tower bus gain: full, unless the operator is speaking over it. */
export function towerGainDb(configuredDb: number, priorityActive: boolean): number {
  return priorityActive ? configuredDb + TOWER_DUCK_PRIORITY_DB : configuredDb;
}

/** Ramp time for a duck transition, in milliseconds. */
export function duckRampMs(priorityActive: boolean): number {
  return priorityActive ? DUCK_ATTACK_MS : DUCK_RESTORE_MS;
}

/**
 * The music bus gain, in dB, for a given state.
 *
 * The deeper duck wins when both are sounding — an operator callout over
 * comms traffic must not leave the radio sitting at the shallower level.
 */
export function musicGainDb(
  configuredDb: number,
  priorityActive: boolean,
  ambientActive: boolean,
  towerActive = false,
): number {
  if (priorityActive) return configuredDb + MUSIC_DUCK_PRIORITY_DB;
  // A clearance you did not hear is a clearance you did not get, so the tower
  // gets the operator's depth rather than ambience's.
  if (towerActive) return configuredDb + MUSIC_DUCK_TOWER_DB;
  if (ambientActive) return configuredDb + MUSIC_DUCK_AMBIENT_DB;
  return configuredDb;
}

/** One thing waiting to be heard on the ambient bus. */
export interface AmbientItem<T = unknown> {
  /** Stable id, for cancelling a specific transmission. */
  id: string;
  /** Which channel it came from — mute is per channel (comms-panel spec). */
  channel: string;
  /** When it was queued (ms epoch). */
  queuedAt: number;
  /** How long it stays worth saying. */
  ttlMs: number;
  payload: T;
}

/** Why an item left the queue without being spoken — surfaced for the panel. */
export type DropReason = 'backlog' | 'stale' | 'muted' | 'cleared';

export interface Dropped<T> {
  item: AmbientItem<T>;
  reason: DropReason;
}

/**
 * The ambient pending queue: bounded, self-expiring, drop-oldest.
 *
 * Deliberately NOT a generic priority queue. Ambience has no priorities worth
 * modelling — it has a shelf life, and when more arrives than can be spoken
 * the right answer is to throw away the oldest, because the newest is the one
 * that still describes the situation the commander is in.
 */
export class AmbientQueue<T = unknown> {
  private items: AmbientItem<T>[] = [];
  private readonly cap: number;
  /** Everything dropped since the last drain — the panel reports these. */
  private dropped: Dropped<T>[] = [];

  constructor(cap: number = AMBIENT_QUEUE_CAP) {
    this.cap = Math.max(1, cap);
  }

  get length(): number {
    return this.items.length;
  }

  /** Queue an item, dropping the oldest when the cap is exceeded. */
  push(item: AmbientItem<T>): void {
    this.items.push(item);
    while (this.items.length > this.cap) {
      const old = this.items.shift();
      if (old) this.dropped.push({ item: old, reason: 'backlog' });
    }
  }

  /**
   * The next item worth speaking, discarding anything that expired while it
   * waited. Returns null when nothing survives.
   */
  take(nowMs: number): AmbientItem<T> | null {
    while (this.items.length) {
      const next = this.items.shift()!;
      if (nowMs - next.queuedAt >= next.ttlMs) {
        this.dropped.push({ item: next, reason: 'stale' });
        continue;
      }
      return next;
    }
    return null;
  }

  /** Discard everything from one channel — per-channel squelch. */
  muteChannel(channel: string): void {
    const keep: AmbientItem<T>[] = [];
    for (const it of this.items) {
      if (it.channel === channel) this.dropped.push({ item: it, reason: 'muted' });
      else keep.push(it);
    }
    this.items = keep;
  }

  /** Discard everything — master mute, or the act turning to CRISIS. */
  clear(reason: DropReason = 'cleared'): void {
    for (const it of this.items) this.dropped.push({ item: it, reason });
    this.items = [];
  }

  /** Drain the drop log. */
  takeDropped(): Dropped<T>[] {
    const out = this.dropped;
    this.dropped = [];
    return out;
  }

  /** Read-only view, for the panel. */
  peek(): readonly AmbientItem<T>[] {
    return this.items;
  }
}
