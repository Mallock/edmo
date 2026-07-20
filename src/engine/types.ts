/**
 * Core domain types for the Mission Operator engine.
 *
 * These mirror SPEC.md §3.1.5. Field names for raw journal events match the
 * Elite Dangerous Player Journal exactly (verified against real journals).
 */

/** A single line from a Journal.*.log file, or an object from a snapshot file. */
export interface JournalEvent {
  timestamp: string; // ISO 8601, e.g. "2025-07-05T21:03:01Z"
  event: string; // e.g. "MissionAccepted"
  [key: string]: unknown;
}

export type MissionCategory =
  | 'Courier'
  | 'Delivery'
  | 'DeliveryWing'
  | 'PassengerBulk'
  | 'PassengerVIP'
  | 'Sightseeing'
  | 'LongDistanceExpedition'
  | 'Massacre'
  | 'Assassinate'
  | 'Salvage'
  | 'Collect'
  | 'Mining'
  | 'Rescue'
  | 'Donation'
  | 'Scan'
  | 'Hack'
  | 'Disable'
  | 'Smuggle'
  | 'OnFoot'
  | 'Other';

export type MissionState =
  | 'ACTIVE'
  | 'REDIRECTED'
  | 'COMPLETE'
  | 'FAILED'
  | 'ABANDONED';

export interface Location {
  system: string;
  station?: string;
}

export type StepSource = 'accept' | 'cargodepot' | 'redirect' | 'combat' | 'complete';

export interface MissionStep {
  label: string;
  done: boolean;
  source: StepSource;
}

export interface CargoProgress {
  collected: number;
  delivered: number;
  total: number;
  progress: number; // 0..1
}

/** Normalized mission model — the single source of truth the UI/AI consume. */
export interface Mission {
  id: number;
  internalName: string; // e.g. "Mission_Assassinate"
  title: string; // LocalisedName
  category: MissionCategory;
  bgsState?: string; // parsed BGS modifier: "Expansion" | "War" | "Boom" | ...
  faction?: string;
  targetFaction?: string;
  origin?: Location; // where accepted (current location at accept time)
  destination?: Location; // current destination, updated by MissionRedirected
  reward: number;
  /** Reward listed on the mission board at accept — `reward` becomes the paid
   *  amount on completion, which is lower when an alternative package is taken. */
  boardReward?: number;
  influence?: string;
  reputation?: string;
  wing: boolean;
  expiry: string | null; // ISO timestamp
  acceptedAt: string; // ISO timestamp

  commodity?: { name: string; localised: string; count: number };
  passengers?: { count: number; type: string; vip: boolean; wanted: boolean };
  target?: { name: string; type: string };
  /** Localised target type even without a named target ("Pirates", "Deserter"). */
  targetType?: string;
  /** Required kills for Massacre missions (journal `KillCount`). */
  killCount?: number;
  /** True for Odyssey on-foot missions (internal Name starts `Mission_OnFoot_`). */
  onFoot?: boolean;

  cargo?: CargoProgress;
  steps: MissionStep[];
  state: MissionState;

  /** Bookkeeping used by the heartbeat and operator. */
  redirected: boolean;
  killProgress: number; // inferred kills toward a massacre/assassinate target
  raw: JournalEvent; // original MissionAccepted, for prompts/debugging
}

/** A point of interest the FSS discovered in the current system. */
export interface SystemSignal {
  name: string; // localised name ("Resource Extraction Site [Hazardous]") or raw station name
  type?: string; // journal SignalType when present: "NavBeacon", "ResourceExtraction", "Combat", …
  isStation: boolean;
}

/** What the journal has told us about the current star system this session. */
export interface SystemIntel {
  security?: string; // e.g. "Low Security"
  allegiance?: string; // e.g. "Independent"
  controllingFaction?: string;
  population?: number;
  signals: SystemSignal[];
  /** Local minor factions in an active BGS state (War, Boom, Election, …) —
   *  the states that spawn combat/BGS missions. From FSDJump/Location Factions[]. */
  factionStates?: Array<{ name: string; state: string }>;
}

/** Snapshot of the whole player situation the operator reasons over. */
export interface OperatorState {
  now: string; // ISO timestamp of the latest tick/event
  location: Location;
  docked: boolean;
  activeMissions: Mission[];
  /** Timestamp of the last "progress" event (jump/dock/undock/kill/cargo). */
  lastActivityAt: string;
  /** Local-system knowledge (from FSDJump/Location + FSS signals), if any. */
  system?: SystemIntel;
  /** Commander name from LoadGame — lets the operator get personal. */
  cmdr?: string;
}
