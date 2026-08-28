/**
 * Radio profiles — what a channel SOUNDS like, as data.
 *
 * The reference implementation for this feature (EDCoPilot, sitting on the
 * same machine) carries its entire radio character in about six INI numbers:
 * `RadioEffectHPF=1200`, `RadioEffectDistortionLevel=5`,
 * `RadioEffectWhiteNoiseLevel`, `RadioEffectPopProbability`,
 * `SpaceChatterRadioBeep`, `BTDelayBeforeSpeech=0.2`. That is the right
 * granularity, and being tunable without a rebuild is most of why it landed —
 * so the numbers live here as plain data and the audio graph reads them.
 *
 * Nothing in this file touches the DOM or Web Audio. The graph that consumes
 * a profile lives in src/ui/radio.ts; keeping the table pure is what lets the
 * test runner (node --test, loading .ts by type-stripping) import it at all.
 *
 * Two conventions worth stating, because they are load-bearing for the graph:
 *  - `hpfHz` of 0 and `lpfHz` at or above Nyquist mean "no filter" — the graph
 *    skips the node entirely rather than configuring a pass-through, because a
 *    biquad at the band edge still colours the signal.
 *  - `hissDb` of null means no noise bed at all, which is different from a very
 *    quiet one: the graph never starts the noise source, so `clean` costs
 *    nothing.
 */

/** Which tones bracket a transmission. */
export type BeepMode = 'none' | 'open' | 'roger' | 'both';

export interface RadioProfile {
  /** High-pass corner. 0 = no high-pass. */
  readonly hpfHz: number;
  /** Low-pass corner. At/above Nyquist = no low-pass. */
  readonly lpfHz: number;
  /** Soft-clip amount, 0 (clean) .. 1 (hard). */
  readonly drive: number;
  /** Noise bed level in dBFS, or null for no noise bed. */
  readonly hissDb: number | null;
  /** Expected random crackles per minute. */
  readonly popsPerMin: number;
  /** Gap between the channel opening and speech starting. */
  readonly squelchMs: number;
  readonly beep: BeepMode;
  /** Trim, applied after the chain. */
  readonly gainDb: number;
}

export type RadioProfileName =
  | 'clean'
  | 'tower'
  | 'station'
  | 'local'
  | 'crew'
  | 'deep'
  | 'emergency'
  | 'carrier'
  | 'concourse';

/**
 * The table.
 *
 * `clean` is the operator's own voice and everything that existed before this
 * feature — it MUST stay a true bypass so that adding the bus changes nothing
 * for callers that never asked for a channel.
 *
 * The rest are arranged along two axes that matter more than any single knob:
 * how far away the speaker is (drive and hiss up, bandwidth down), and how
 * much equipment sits between you and them (a station has good gear and a
 * formal squelch; a drifting deep-space contact has neither).
 */
export const RADIO_PROFILES: Readonly<Record<RadioProfileName, RadioProfile>> = {
  // The bypass. Do not add character here.
  clean: {
    hpfHz: 0,
    lpfHz: 22_050,
    drive: 0,
    hissDb: null,
    popsPerMin: 0,
    squelchMs: 0,
    beep: 'none',
    gainDb: 0,
  },

  // Traffic control: strong signal, good equipment, formal procedure. The
  // telephone band is deliberate — it is the sound everyone reads as "radio".
  // Traffic control on the approach channel, addressed to this ship. Cleaner
  // and louder than the general station feed: it is a directed transmission
  // from a few hundred metres away, not overheard chatter from across the
  // bay, and the commander is meant to act on it.
  tower: {
    hpfHz: 380,
    lpfHz: 3800,
    drive: 0.4,
    hissDb: -40,
    popsPerMin: 3,
    squelchMs: 150,
    beep: 'both',
    gainDb: 0,
  },

  station: {
    hpfHz: 450,
    lpfHz: 3400,
    drive: 0.55,
    hissDb: -34,
    popsPerMin: 6,
    squelchMs: 180,
    beep: 'both',
    gainDb: -1,
  },

  // Ship-to-ship on the open channel: whoever is out there, on whatever they
  // have bolted to the hull. Noisier and less disciplined than a station.
  local: {
    hpfHz: 380,
    lpfHz: 3200,
    drive: 0.45,
    hissDb: -30,
    popsPerMin: 10,
    squelchMs: 140,
    beep: 'roger',
    gainDb: -2,
  },

  // Your own crew, over the intercom, three metres away. Barely processed —
  // the contrast with the outside channels is what makes the ship feel like
  // shelter.
  crew: {
    hpfHz: 200,
    lpfHz: 6500,
    drive: 0.15,
    hissDb: -44,
    popsPerMin: 1,
    squelchMs: 60,
    beep: 'none',
    gainDb: 0,
  },

  // Something a very long way off. Narrow, hissy, breaking up. This profile
  // is mostly used to make the silence around it feel earned.
  deep: {
    hpfHz: 500,
    lpfHz: 2600,
    drive: 0.7,
    hissDb: -22,
    popsPerMin: 22,
    squelchMs: 260,
    beep: 'open',
    gainDb: -3,
  },

  // Distress and priority traffic: hot, clipped, and louder than everything
  // else on purpose. The only profile with positive trim.
  emergency: {
    hpfHz: 600,
    lpfHz: 3000,
    drive: 0.85,
    hissDb: -26,
    popsPerMin: 16,
    squelchMs: 90,
    beep: 'both',
    gainDb: 2,
  },

  // A fleet carrier has room for a real transmitter. Wide, clean, slow to key.
  carrier: {
    hpfHz: 300,
    lpfHz: 3800,
    drive: 0.35,
    hissDb: -38,
    popsPerMin: 3,
    squelchMs: 200,
    beep: 'roger',
    gainDb: -1,
  },

  // Not radio at all — a public-address speaker in a room you are standing in.
  // No squelch, no beeps, wide band, pushed back in the mix.
  concourse: {
    hpfHz: 160,
    lpfHz: 5200,
    drive: 0.1,
    hissDb: -40,
    popsPerMin: 0,
    squelchMs: 0,
    beep: 'none',
    gainDb: -6,
  },
};

/** Every profile name, for settings UIs and tests. */
export const RADIO_PROFILE_NAMES = Object.keys(RADIO_PROFILES) as RadioProfileName[];

/**
 * Look up a profile by name.
 *
 * Unknown names resolve to `clean` rather than throwing: a profile name can
 * reach here from persisted settings or a user-authored grammar file, and a
 * transmission that sounds unprocessed is a much better failure than one that
 * takes the audio path down with it.
 */
export function radioProfile(name: string | null | undefined): RadioProfile {
  if (!name) return RADIO_PROFILES.clean;
  return RADIO_PROFILES[name as RadioProfileName] ?? RADIO_PROFILES.clean;
}

/** True when this profile asks for no processing at all. */
export function isBypass(p: RadioProfile): boolean {
  return (
    p.hpfHz <= 0 &&
    p.lpfHz >= 22_050 &&
    p.drive <= 0 &&
    p.hissDb === null &&
    p.popsPerMin <= 0 &&
    p.beep === 'none' &&
    p.gainDb === 0
  );
}

/**
 * Shape check for a profile, used by tests and by the settings layer when
 * reading user-tuned values back off disk. Returns the reason it is invalid,
 * or null when it is fine.
 */
export function validateProfile(p: RadioProfile): string | null {
  if (!Number.isFinite(p.hpfHz) || p.hpfHz < 0) return 'hpfHz must be a finite number >= 0';
  if (!Number.isFinite(p.lpfHz) || p.lpfHz <= 0) return 'lpfHz must be a finite number > 0';
  if (p.hpfHz > 0 && p.hpfHz >= p.lpfHz) return 'hpfHz must be below lpfHz';
  if (!Number.isFinite(p.drive) || p.drive < 0 || p.drive > 1) return 'drive must be 0..1';
  if (p.hissDb !== null && (!Number.isFinite(p.hissDb) || p.hissDb > 0))
    return 'hissDb must be null or a finite value <= 0';
  if (!Number.isFinite(p.popsPerMin) || p.popsPerMin < 0) return 'popsPerMin must be >= 0';
  if (!Number.isFinite(p.squelchMs) || p.squelchMs < 0) return 'squelchMs must be >= 0';
  if (!['none', 'open', 'roger', 'both'].includes(p.beep)) return 'beep must be a BeepMode';
  if (!Number.isFinite(p.gainDb)) return 'gainDb must be finite';
  return null;
}

/** dB → linear amplitude. Shared by the graph and the tests. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}
