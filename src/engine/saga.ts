/**
 * The Saga — a space-opera serial narrated from the commander's real journal.
 * SagaTracker folds events into compact story beats; buildEpisodeChat asks the
 * local LLM to narrate numbered episodes with continuity ("the story so far").
 * Every plot beat is a true event — the prose is fiction, the history is not.
 */
import type { ChatMessage } from './lmstudio.ts';
import type { JournalEvent } from './types.ts';
import { LORE_PRIMER } from './lore.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const cr = (n: number): string => `${n.toLocaleString('en-US')} cr`;

export interface StoryBeat {
  t: string; // ISO timestamp
  text: string;
}

const MAX_BEATS = 400;

export class SagaTracker {
  beats: StoryBeat[] = [];
  cmdr = '';
  ship = '';
  private shipNameOnly = '';
  private pendingBounties = 0;
  private pendingBountyCr = 0;
  private bountyFaction = '';
  private lastSystem = '';
  private dramaSeen = new Set<string>();

  /** Track the ship in use; a CHANGE becomes a chronicle beat, so multi-ship
   *  days stay attributable (the hauler's runs must not read as the miner's). */
  private setShip(t: string, name: string | undefined, type: string | undefined): void {
    if (!name) return;
    const label = `${name} (${type ?? 'ship'})`;
    if (this.shipNameOnly && this.shipNameOnly !== name) {
      this.push(t, `Took the helm of the ${label}`);
    }
    this.shipNameOnly = name;
    this.ship = label;
  }

  apply(ev: JournalEvent): void {
    const t = ev.timestamp;
    switch (ev.event) {
      case 'LoadGame':
        this.cmdr = str(ev.Commander) ?? this.cmdr;
        this.setShip(t, str(ev.ShipName), str(ev.Ship_Localised) ?? str(ev.Ship));
        break;
      case 'Loadout':
        this.setShip(t, str(ev.ShipName), str(ev.Ship));
        break;
      case 'FSDJump':
        this.flushBounties(t);
        this.lastSystem = str(ev.StarSystem) ?? this.lastSystem;
        break;
      case 'Docked':
        this.flushBounties(t);
        this.push(t, `Docked at ${str(ev.StationName)} in ${str(ev.StarSystem)}`);
        break;
      case 'MissionAccepted': {
        const pax = num(ev.PassengerCount)
          ? ` (${ev.PassengerCount} ${str(ev.PassengerType) ?? 'passengers'}${ev.PassengerVIPs ? ', VIP' : ''}${ev.PassengerWanted ? ', WANTED' : ''})`
          : '';
        this.push(
          t,
          `Accepted from ${str(ev.Faction)}: "${str(ev.LocalisedName)}"${pax} → ${str(ev.DestinationStation) ?? ''} ${str(ev.DestinationSystem) ?? ''}, ${cr(num(ev.Reward) ?? 0)}`,
        );
        break;
      }
      case 'MissionRedirected':
        this.flushBounties(t);
        this.push(
          t,
          `Objective complete — ordered back to ${str(ev.NewDestinationStation) ?? str(ev.NewDestinationSystem)}`,
        );
        break;
      case 'MissionCompleted':
        this.flushBounties(t);
        this.push(t, `Handed in "${str(ev.LocalisedName)}" — paid ${cr(num(ev.Reward) ?? 0)}`);
        break;
      case 'MissionFailed':
        this.flushBounties(t);
        this.push(t, `Mission FAILED: "${str(ev.LocalisedName)}"`);
        break;
      case 'MissionAbandoned':
        this.push(t, `Abandoned "${str(ev.LocalisedName)}"`);
        break;
      case 'Bounty':
        this.pendingBounties += 1;
        this.pendingBountyCr += num(ev.TotalReward) ?? 0;
        this.bountyFaction = str(ev.VictimFaction) ?? this.bountyFaction;
        break;
      case 'UnderAttack':
        if (ev.Target !== 'Fighter') this.push(t, `Came under fire in ${this.lastSystem || 'deep space'}`);
        break;
      case 'ReceiveText': {
        const code = typeof ev.Message === 'string' ? ev.Message : '';
        const said = str(ev.Message_Localised);
        if (!said) break;
        if (code.startsWith('$Pirate')) {
          this.push(t, `Pirate hail: "${said}"`);
          break;
        }
        // Dramatic one-off comms become chronicle beats too — once per kind.
        const drama = /^\$(Military_UnderFire|Smuggler_NearDeath|Deserter_Flee|MinerCriticalDamage|CargoHunter|PassengerHunter)/.exec(
          code,
        );
        if (drama && !this.dramaSeen.has(drama[1])) {
          this.dramaSeen.add(drama[1]);
          const from = str(ev.From_Localised) ?? str(ev.From) ?? 'unknown vessel';
          this.push(t, `Comms — ${from}: "${said}"`);
        }
        break;
      }
      default:
        break;
    }
  }

  private push(t: string, text: string): void {
    if (this.beats.at(-1)?.text === text) return; // collapse duplicates
    this.beats.push({ t, text });
    if (this.beats.length > MAX_BEATS) this.beats = this.beats.slice(-MAX_BEATS);
  }

  private flushBounties(t: string): void {
    if (this.pendingBounties > 0) {
      this.push(
        t,
        `Destroyed ${this.pendingBounties} ship(s) of ${this.bountyFaction || 'hostiles'} — bounties worth ${cr(this.pendingBountyCr)}`,
      );
      this.pendingBounties = 0;
      this.pendingBountyCr = 0;
    }
  }

  /** Calendar day (UTC, journal time) of the most recent beat, or null. */
  latestDay(): string | null {
    return this.beats.at(-1)?.t.slice(0, 10) ?? null;
  }

  /** Beats for one day, including any still-unflushed bounty streak. */
  beatsForDay(day: string): StoryBeat[] {
    const out = this.beats.filter((b) => b.t.startsWith(day));
    if (this.pendingBounties > 0) {
      out.push({
        t: `${day}T23:59:59Z`,
        text: `Destroyed ${this.pendingBounties} ship(s) of ${this.bountyFaction || 'hostiles'} — bounties worth ${cr(this.pendingBountyCr)}`,
      });
    }
    return out;
  }
}

/** Prompt for one numbered episode (temperature ~0.85, allow 3k tokens). */
export function buildEpisodeChat(opts: {
  episodeNumber: number;
  day: string;
  beats: StoryBeat[];
  cmdr: string;
  ship: string;
  storySoFar: string;
}): ChatMessage[] {
  const chronicle = opts.beats
    .slice(0, 34)
    .map((b) => `- [${b.t.slice(11, 16)}] ${b.text}`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        `You are the narrator of an ongoing space-opera serial chronicling the true exploits of ` +
        `Commander ${opts.cmdr || 'the pilot'}${opts.ship ? ` and the ship ${opts.ship}` : ''}. ` +
        `${LORE_PRIMER} Write the next episode: a dramatic third-person chapter of 180-250 words ` +
        `with a short evocative title on the first line. Ground every plot beat in the chronicle ` +
        `of true events provided — you may invent atmosphere, brief dialogue and inner thoughts, ` +
        `but never invent events, outcomes, or any faction, company, organization, station, ` +
        `system, ship or person not named in the chronicle. Correct Elite Dangerous terminology ` +
        `(supercruise, frame shift, docking clearance); no modern-Earth idioms. Tone: vast, cold, ` +
        `human — classic space opera. End with a single-sentence hook toward the next episode. ` +
        `No markdown.`,
    },
    {
      role: 'user',
      content:
        (opts.storySoFar ? `The story so far:\n${opts.storySoFar}\n\n` : '') +
        `Chronicle of true events (${opts.day}):\n${chronicle}\n\nWrite Episode ${opts.episodeNumber} now.`,
    },
  ];
}

/** Offline fallback — a plain chronicle recap instead of prose. */
export function beatRecap(day: string, beats: StoryBeat[]): string {
  const lines = beats.slice(-12).map((b) => `${b.t.slice(11, 16)} ${b.text}`);
  return `Chronicle of ${day} (the narrator is offline — raw log):\n${lines.join('\n')}`;
}
