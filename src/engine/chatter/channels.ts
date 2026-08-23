/**
 * Which channels exist, when each one can open, and how often anyone talks.
 *
 * The reference implementation gates its chatter on a per-channel probability
 * and a minimum interval — `SpaceChatterCrewProb=2`,
 * `SpaceChatterCrewMinInterval=90`, `SpaceChatterSupercruiseProb=4`. That is
 * the right skeleton and the wrong nervous system: a flat dice roll produces
 * the same density during a quiet haul and a hull-breach, which is why the
 * most common thing anyone does with that feature is turn it off.
 *
 * Two things are different here.
 *
 * First, a channel opens on GEOMETRY, not on a flag. Station traffic is gated
 * by the actual separation between the ship and the port, taken from the
 * orrery — so the channel genuinely fades in on approach, and a port the app
 * cannot place stays silent rather than being invented. `DEEP` is not a
 * distance threshold (the reference uses `DeepSpaceRange=500` ly); it is what
 * remains when nothing else is in reach, which is a different and truer thing:
 * a busy system 5,000 ly out is not deep space, and an empty one 40 ly from
 * Sol is.
 *
 * Second, the cadence runs OPPOSITE to the copilot's. `copilotDensityGapMs`
 * tightens as pressure rises — the operator leans in when it counts. The world
 * does the reverse: strangers stop chatting when things get serious, and the
 * channel going quiet is the point.
 *
 * Pure module. No DOM, no audio, no clock of its own — every function takes
 * the time it should reason about.
 */
import type { RadioProfileName } from './profiles.ts';
import type { Act, ChannelId, ClosedReason } from './types.ts';
import { CHANNEL_IDS } from './types.ts';

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

/**
 * Beyond this separation a station is not audible at all.
 *
 * Was 2,000 ls, which sounded principled and in practice shut the most-wanted
 * channel almost everywhere: plenty of real ports sit 100,000+ ls from the
 * arrival star, and the separation figure available in-system is measured from
 * that star rather than from the ship. The strength curve below still degrades
 * the audio honestly with distance — that part was working — but the hard
 * cutoff was throwing away traffic a commander would certainly hear.
 */
export const STATION_RANGE_LS = 250_000;
/** Inside this, the signal is as good as it gets. */
export const STATION_FULL_LS = 200;
/** Below this strength the channel stays shut. Kept low: at this point the
 *  question is whether a port exists in this system at all, and the degrade
 *  curve handles the rest. */
export const MIN_AUDIBLE_STRENGTH = 0.02;

/**
 * Signal strength 0..1 for a station at `separationLs`.
 *
 * Logarithmic because in-system distances are: a port can be 12 ls or 240,000
 * ls out, and a linear ramp would make everything past the first few hundred
 * ls identically inaudible. Monotonically decreasing in separation, which is
 * what makes an approach sound like an approach.
 */
export function signalStrength(separationLs: number | null): number {
  if (separationLs === null || !Number.isFinite(separationLs)) return 0;
  const sep = Math.max(0, separationLs);
  if (sep <= STATION_FULL_LS) return 1;
  if (sep >= STATION_RANGE_LS) return 0;
  const span = Math.log(STATION_RANGE_LS) - Math.log(STATION_FULL_LS);
  return Math.max(0, Math.min(1, (Math.log(STATION_RANGE_LS) - Math.log(sep)) / span));
}

/** How much to degrade the radio profile at this strength, 0 (clean) .. 1. */
export function degradeFor(strength: number): number {
  return Math.max(0, Math.min(1, 1 - strength));
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/**
 * How busy the air is.
 *
 * Its OWN setting, deliberately. The first cut drove cadence from
 * `settings.vision.involvement` — the copilot's knob — which meant a commander
 * who wanted a quiet copilot and a busy channel could not have one, and the
 * default landed at roughly one transmission every hundred seconds. Measured
 * against the reference implementation, whose floor is
 * `MinimumDelayBetweenChatter=5` seconds across seven channels, that is not a
 * populated star system; it is an empty one with a radio in it.
 */
export type ChatterDensity = 'sparse' | 'normal' | 'busy' | 'bustling';

export const CHATTER_DENSITIES: readonly ChatterDensity[] = [
  'sparse',
  'normal',
  'busy',
  'bustling',
];

/** Base gap between candidate transmissions at each density. */
export function chatterBaseGapMs(density: ChatterDensity): number {
  switch (density) {
    case 'sparse':
      return 150_000;
    case 'normal':
      return 60_000;
    case 'busy':
      return 30_000;
    case 'bustling':
      return 16_000;
    default:
      return 60_000;
  }
}

/**
 * Gap to the next candidate transmission.
 *
 * Still the INVERSE of `copilotDensityGapMs` — the operator leans in as things
 * get tense and the world backs off — but the spread is gentler than it was.
 * The old curve stretched to 3× the base gap at full pressure, which on top of
 * an already-slow base meant the channel effectively died several minutes
 * before the act machine actually silenced it. CRISIS is what stops the
 * chatter; pressure only thins it.
 */
export function chatterGapMs(density: ChatterDensity, pressure: number): number {
  const p = Math.max(0, Math.min(1, pressure));
  return Math.round(chatterBaseGapMs(density) * (0.8 + 1.4 * p));
}

// ---------------------------------------------------------------------------
// The channel table
// ---------------------------------------------------------------------------

export interface ChannelDef {
  readonly id: ChannelId;
  readonly profile: RadioProfileName;
  /** Relative likelihood when several channels are eligible at once. */
  readonly weight: number;
  /** Minimum gap between transmissions on this channel. */
  readonly minIntervalMs: number;
  /** Acts during which this channel may transmit at all. */
  readonly acts: readonly Act[];
}

const ALL_BUT_CRISIS: readonly Act[] = ['QUIET', 'BUILDING', 'AFTERMATH'];

export const CHANNELS: Readonly<Record<ChannelId, ChannelDef>> = {
  STATION: {
    id: 'STATION',
    profile: 'station',
    weight: 4,
    minIntervalMs: 38_000,
    acts: ALL_BUT_CRISIS,
  },
  LOCAL: {
    id: 'LOCAL',
    profile: 'local',
    weight: 3,
    minIntervalMs: 40_000,
    acts: ALL_BUT_CRISIS,
  },
  CREW: {
    id: 'CREW',
    profile: 'crew',
    weight: 3,
    minIntervalMs: 70_000,
    acts: ALL_BUT_CRISIS,
  },
  DEEP: {
    id: 'DEEP',
    profile: 'deep',
    weight: 2,
    minIntervalMs: 150_000,
    acts: ALL_BUT_CRISIS,
  },
  // The only channel that survives CRISIS, and only with a verified brief.
  EMERGENCY: {
    id: 'EMERGENCY',
    profile: 'emergency',
    weight: 1,
    minIntervalMs: 45_000,
    acts: ['BUILDING', 'CRISIS', 'AFTERMATH'],
  },
  CARRIER: {
    id: 'CARRIER',
    profile: 'carrier',
    weight: 1,
    minIntervalMs: 180_000,
    acts: ALL_BUT_CRISIS,
  },
  CONCOURSE: {
    id: 'CONCOURSE',
    profile: 'concourse',
    weight: 2,
    minIntervalMs: 55_000,
    acts: ALL_BUT_CRISIS,
  },
};

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Everything the director knows when deciding whether a channel can open. */
export interface ChannelContext {
  nowMs: number;
  act: Act;
  density: ChatterDensity;
  pressure: number;
  /** On foot at a station — the only time the concourse is audible. */
  onFoot: boolean;
  /** Ports the orrery has actually RESOLVED in this system. Zero closes
   *  STATION: a port the app cannot place is a port it must not invent. */
  resolvedPorts: number;
  /** Separation to the nearest/target port in ls, or null when unknown. */
  portSeparationLs: number | null;
  /** A fleet carrier is present in this system. */
  carrierPresent: boolean;
  /** Population of the current system, or null when unknown. */
  population: number | null;
  /** Crew aboard — multi-crew, or the fiction of a crewed ship. */
  hasCrew: boolean;
  /** Last transmission per channel (ms epoch). */
  lastTransmitAt: Partial<Record<ChannelId, number>>;
  mutedChannels: ReadonlySet<ChannelId>;
  /** True when a verified brief exists for an emergency right now. */
  emergencyBriefReady: boolean;
}

export type ChannelState =
  | { id: ChannelId; open: true; strength: number; degrade: number }
  | { id: ChannelId; open: false; reason: ClosedReason };

/**
 * Can this channel transmit right now, and how well does it come through?
 *
 * Order matters: the reasons are checked cheapest-and-most-explanatory first,
 * because the panel shows whichever one fires and "no port in system" is a
 * more useful thing to read than "holding".
 */
export function evaluateChannel(id: ChannelId, ctx: ChannelContext): ChannelState {
  const def = CHANNELS[id];
  const shut = (reason: ClosedReason): ChannelState => ({ id, open: false, reason });

  if (ctx.mutedChannels.has(id)) return shut('muted');
  if (!def.acts.includes(ctx.act)) return shut('act-suppressed');

  const last = ctx.lastTransmitAt[id];
  if (last !== undefined && ctx.nowMs - last < def.minIntervalMs) return shut('too-soon');

  switch (id) {
    case 'STATION': {
      if (ctx.resolvedPorts <= 0) return shut('no-ports-in-system');
      const strength = signalStrength(ctx.portSeparationLs);
      if (strength < MIN_AUDIBLE_STRENGTH) return shut('out-of-range');
      return { id, open: true, strength, degrade: degradeFor(strength) };
    }
    case 'LOCAL': {
      // Somebody has to be out here to talk to. An uninhabited system has
      // traffic only if the commander brought it.
      if (ctx.population !== null && ctx.population <= 0) return shut('unpopulated');
      if (ctx.resolvedPorts <= 0 && !ctx.carrierPresent) return shut('out-of-range');
      const strength = ctx.portSeparationLs === null ? 0.6 : signalStrength(ctx.portSeparationLs);
      const eff = Math.max(0.35, strength); // open-channel traffic is nearer than the port
      return { id, open: true, strength: eff, degrade: degradeFor(eff) };
    }
    case 'CREW': {
      if (!ctx.hasCrew) return shut('no-crew');
      // Three metres away — range is not a concept here.
      return { id, open: true, strength: 1, degrade: 0 };
    }
    case 'DEEP': {
      // Defined by absence: if anything nearer is reachable, this is not deep
      // space, however many light years from the Bubble the commander is.
      const nearer =
        (ctx.resolvedPorts > 0 &&
          signalStrength(ctx.portSeparationLs) >= MIN_AUDIBLE_STRENGTH) ||
        ctx.carrierPresent;
      if (nearer) return shut('others-in-range');
      return { id, open: true, strength: 0.25, degrade: degradeFor(0.25) };
    }
    case 'EMERGENCY': {
      if (!ctx.emergencyBriefReady) return shut('no-verified-brief');
      return { id, open: true, strength: 1, degrade: 0 };
    }
    case 'CARRIER': {
      if (!ctx.carrierPresent) return shut('no-carrier');
      return { id, open: true, strength: 0.9, degrade: degradeFor(0.9) };
    }
    case 'CONCOURSE': {
      if (!ctx.onFoot) return shut('not-on-foot');
      return { id, open: true, strength: 1, degrade: 0 };
    }
    default:
      return shut('act-suppressed');
  }
}

/** Every channel's state, for the director and the panel's channel strip. */
export function evaluateAll(ctx: ChannelContext): ChannelState[] {
  return CHANNEL_IDS.map((id) => evaluateChannel(id, ctx));
}

/**
 * Pick a channel to transmit on, or null.
 *
 * Weighted so the busy channels dominate without starving the rare ones —
 * a carrier broadcast should be a surprise, not a rotation slot. `rand` is
 * injected rather than called for, so the choice is reproducible in tests.
 */
export function selectChannel(
  ctx: ChannelContext,
  rand: () => number,
): Extract<ChannelState, { open: true }> | null {
  const open = evaluateAll(ctx).filter(
    (s): s is Extract<ChannelState, { open: true }> => s.open,
  );
  if (!open.length) return null;

  // In CRISIS only EMERGENCY survives the act gate, so this needs no special
  // case — but be explicit, because getting it wrong is the loud failure.
  if (ctx.act === 'CRISIS') {
    return open.find((s) => s.id === 'EMERGENCY') ?? null;
  }

  const total = open.reduce((sum, s) => sum + CHANNELS[s.id].weight, 0);
  let roll = rand() * total;
  for (const s of open) {
    roll -= CHANNELS[s.id].weight;
    if (roll <= 0) return s;
  }
  return open[open.length - 1];
}

/** Is it time to even consider transmitting? */
export function dueToTransmit(
  lastAnyAt: number | null,
  ctx: Pick<ChannelContext, 'nowMs' | 'density' | 'pressure'>,
): boolean {
  if (lastAnyAt === null) return true;
  return ctx.nowMs - lastAnyAt >= chatterGapMs(ctx.density, ctx.pressure);
}
