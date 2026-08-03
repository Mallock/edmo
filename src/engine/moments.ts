/**
 * Moments — the journal events the copilot could not hear.
 *
 * The operator lives on what the store translates into EVENT lines, and the
 * vocabulary was curated around missions, travel and mining. Everything else a
 * session is made of — the interdiction you shook off, the neutron jet you
 * rode, the promotion, the fight, the death — never reached the conversation,
 * so the copilot fell back to atmosphere exactly where the real drama was.
 *
 * `momentOf` is a pure mapper: journal event in, EVENT line + reaction tier
 * out, null for everything that is not a moment. `CombatStreak` aggregates a
 * fight the way SagaTracker does, so the copilot reacts to the fight AFTER it
 * is over — the ambient voice deliberately stays out of live combat, and one
 * beat about "three ships down" beats three beats mid-dogfight.
 */
import type { JournalEvent } from './types.ts';
import type { ReactionTier } from './copilot.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export interface Moment {
  line: string;
  tier: ReactionTier;
}

/** Rank tracks a Promotion event can carry, in the order worth reporting. */
const PROMOTION_TRACKS = [
  'Combat',
  'Trade',
  'Explore',
  'Soldier',
  'Exobiologist',
  'Federation',
  'Empire',
  'CQC',
] as const;

/**
 * The EVENT line for a journal event outside the curated vocabulary, or null.
 * Tiers reuse the copilot's involvement gates: interdictions, promotions and
 * deaths always land ('mission'); sights and finds from 'medium' up
 * ('discovery'/'arrival'); wing and fuel texture only for a chatty copilot
 * ('travel').
 */
export function momentOf(
  ev: JournalEvent,
  opts: { fuelCapacity?: number } = {},
): Moment | null {
  switch (ev.event) {
    case 'Interdicted': {
      const byThargoid = ev.IsThargoid === true;
      const who = byThargoid
        ? 'something not human'
        : (str(ev.Interdictor_Localised) ?? str(ev.Interdictor) ?? 'an unknown ship');
      const player = ev.IsPlayer === true ? ' (another commander)' : '';
      return {
        line:
          ev.Submitted === true
            ? `EVENT: Interdicted by ${who}${player} — submitted and dropped to normal space.`
            : `EVENT: Pulled out of supercruise by ${who}${player}.`,
        tier: 'mission',
      };
    }
    case 'EscapeInterdiction': {
      const who = str(ev.Interdictor_Localised) ?? str(ev.Interdictor) ?? 'an unknown ship';
      return { line: `EVENT: Shook off an interdiction attempt by ${who}.`, tier: 'mission' };
    }
    case 'JetConeBoost': {
      const boost = num(ev.BoostValue);
      return {
        line: `EVENT: Rode a neutron star's jet cone — frame shift drive supercharged${boost ? ` ×${boost.toFixed(1)}` : ''}.`,
        tier: 'discovery',
      };
    }
    case 'FuelScoop': {
      // Every scoop is journal noise; the tank coming back to FULL is the one
      // worth a word. Needs the capacity to know — without it, stay quiet.
      const total = num(ev.Total);
      const cap = opts.fuelCapacity;
      if (total === undefined || !cap || total < cap * 0.99) return null;
      return { line: 'EVENT: Fuel scooping done — main tank full again.', tier: 'travel' };
    }
    case 'USSDrop': {
      const type = str(ev.USSType_Localised) ?? str(ev.USSType) ?? 'an unidentified signal source';
      const threat = num(ev.USSThreat) ?? 0;
      return {
        line: `EVENT: Dropped into ${type}${threat > 0 ? ` — threat level ${threat}` : ''}.`,
        // A hot signal source is a decision, not scenery.
        tier: threat >= 2 ? 'mission' : 'discovery',
      };
    }
    case 'Promotion': {
      const track = PROMOTION_TRACKS.find((t) => num(ev[t]) !== undefined);
      if (!track) return null;
      return {
        line: `EVENT: Promotion — the commander's ${track} rank just climbed a grade.`,
        tier: 'mission',
      };
    }
    case 'Died': {
      const killer =
        str(ev.KillerName_Localised) ?? str(ev.KillerName) ?? str(ev.KillerShip);
      return {
        line: `EVENT: Ship destroyed${killer ? ` by ${killer}` : ''} — the leg ends at the rebuy screen.`,
        tier: 'mission',
      };
    }
    case 'WingJoin':
      return { line: 'EVENT: Joined a wing — flying with company now.', tier: 'travel' };
    case 'WingLeave':
      return { line: 'EVENT: Left the wing — flying alone again.', tier: 'travel' };
    case 'Touchdown': {
      // Autopilot / dismissed-ship touchdowns are not the commander landing.
      if (ev.PlayerControlled === false) return null;
      const body = str(ev.Body);
      return { line: `EVENT: Set down on ${body ?? 'the surface'}.`, tier: 'arrival' };
    }
    case 'Disembark': {
      const where = str(ev.StationName) ?? str(ev.Body);
      return { line: `EVENT: On foot${where ? ` at ${where}` : ''}.`, tier: 'arrival' };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The fight, told once it is over
// ---------------------------------------------------------------------------

/** Mirrors the copilot's own combat-quiet window: the aftermath line unlocks at
 *  the same moment the ambient voice is allowed to speak again. */
export const COMBAT_QUIET_MS = 60_000;

/**
 * Accumulates a fight — bounties and combat-zone bonds — and reports it as ONE
 * event once the shooting has stopped. The ambient copilot deliberately stays
 * out of live combat; before this, that meant the fight simply never existed
 * for it: kills set the quiet timer and nothing else, so the operator came out
 * of a three-kill brawl talking about cargo space.
 */
export class CombatStreak {
  private kills = 0;
  private cr = 0;
  private faction = '';
  private lastAt = 0;

  /** Fold one journal event; returns true when it belonged to the fight. */
  apply(ev: JournalEvent, nowMs: number): boolean {
    switch (ev.event) {
      case 'Bounty':
        this.kills += 1;
        this.cr += num(ev.TotalReward) ?? 0;
        this.faction = str(ev.VictimFaction) ?? this.faction;
        this.lastAt = nowMs;
        return true;
      case 'FactionKillBond':
        this.kills += 1;
        this.cr += num(ev.Reward) ?? 0;
        this.faction = str(ev.VictimFaction) ?? this.faction;
        this.lastAt = nowMs;
        return true;
      case 'UnderAttack':
        // Taking fire extends the fight without scoring it — the aftermath must
        // not fire in the middle of an exchange just because no kill landed.
        if (this.kills > 0) this.lastAt = nowMs;
        return false;
      default:
        return false;
    }
  }

  active(): boolean {
    return this.kills > 0;
  }

  /**
   * The aftermath line, once the fight has been quiet for COMBAT_QUIET_MS (or
   * immediately when forced — a jump or docking ends a fight by definition).
   * Returns null while the fight is live or when there was no fight. Resets on
   * report, so a fight is only ever told once.
   */
  flush(nowMs: number, force = false): string | null {
    if (this.kills === 0) return null;
    if (!force && nowMs - this.lastAt < COMBAT_QUIET_MS) return null;
    const ships = `${this.kills} ship${this.kills === 1 ? '' : 's'}`;
    const of = this.faction ? ` of ${this.faction}` : '';
    const pay = this.cr > 0 ? ` — ${this.cr.toLocaleString('en-US')} cr in bounties earned` : '';
    const line = `EVENT: The fight is over: ${ships}${of} destroyed${pay}.`;
    this.kills = 0;
    this.cr = 0;
    this.faction = '';
    this.lastAt = 0;
    return line;
  }
}
