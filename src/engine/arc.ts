/**
 * The session arc — the commander's story, computed.
 *
 * The aliveness experiment was unambiguous: the operator becomes a person when
 * it is handed a NARRATIVE (the story so far), a MOOD of its own, and the
 * occasional licence to mention its own watch — and the model must never be
 * asked to derive any of that itself (handed raw material it recommends the
 * wrong goal, recites tallies, or invents). So the story is folded here, in
 * code, the way rankCommunityGoals folds the CG board: chapters keyed to what
 * the commander is actually DOING — hauling, mining, exobiology, passenger
 * runs, bounty hunting, community-goal work, exploring — with a turn line when
 * the activity changes, so a shift from the rings to the passenger cabins is
 * a story beat the operator gets to mark out loud.
 *
 * Chapter switches use hysteresis: one stray bounty in the middle of a mining
 * shift is an interruption, not a new chapter. Definitive acts (refining ore,
 * sampling biology, a community-goal contribution) carry enough weight to turn
 * the chapter alone; ambient ones (a single kill, one scan) need a second.
 */
import type { JournalEvent } from './types.ts';
import { speakableCredits } from './copilot.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export type ChapterKind =
  | 'hauling'
  | 'mining'
  | 'exobiology'
  | 'passenger runs'
  | 'bounty hunting'
  | 'community-goal work'
  | 'exploring';

/** Weight needed before a different activity becomes the new chapter. */
const TURN_WEIGHT = 2;
/** Observations older than this no longer argue for a chapter. */
const OBSERVATION_WINDOW_MS = 15 * 60_000;

interface Tally {
  handIns: number;
  earned: number;
  tonnes: number;
  samples: number;
  kills: number;
  bountyCr: number;
  scans: number;
  cgDeliveries: number;
}

const zeroTally = (): Tally => ({
  handIns: 0, earned: 0, tonnes: 0, samples: 0, kills: 0, bountyCr: 0, scans: 0, cgDeliveries: 0,
});

/** One human fragment describing a chapter's work so far. */
function chapterFragment(kind: ChapterKind, t: Tally): string {
  switch (kind) {
    case 'mining':
      return `a mining shift${t.tonnes ? `, ${t.tonnes} t refined so far` : ' just begun'}`;
    case 'exobiology':
      return `an exobiology walk${t.samples ? `, ${t.samples} sample${t.samples === 1 ? '' : 's'} logged` : ''}`;
    case 'passenger runs':
      return `passenger work${t.handIns ? `, ${t.handIns} cabin${t.handIns === 1 ? '' : 's'} delivered` : ''}`;
    case 'bounty hunting':
      return `bounty hunting${t.kills ? `, ${t.kills} kill${t.kills === 1 ? '' : 's'} and ${speakableCredits(t.bountyCr)} claimed` : ''}`;
    case 'community-goal work':
      return `hauling for the community goal${t.cgDeliveries ? `, ${t.cgDeliveries} run${t.cgDeliveries === 1 ? '' : 's'} in` : ''}`;
    case 'exploring':
      return `charting the black${t.scans ? `, ${t.scans} bodies scanned` : ''}`;
    default:
      return `the contract grind${t.handIns ? `, ${t.handIns} hand-in${t.handIns === 1 ? '' : 's'} this stretch` : ''}`;
  }
}

export class SessionArc {
  private chapter: ChapterKind | null = null;
  private chapterTally = zeroTally();
  private chapterStartedAt = 0;
  /** Votes for a DIFFERENT chapter than the current one. */
  private votes = new Map<ChapterKind, { weight: number; at: number }>();
  /** Session totals, across all chapters. */
  private totals = zeroTally();
  private winStreak = 0;
  private lossStreak = 0;
  private lastDeathAt = 0;
  private lastCgContribution = -1;

  /**
   * Fold one journal event. Returns a chapter-turn EVENT line when the story
   * moves to a new activity, else null. Deliberately never returns a line for
   * the FIRST chapter — the session opening is not a "turn".
   */
  apply(ev: JournalEvent, nowMs: number): string | null {
    switch (ev.event) {
      case 'MiningRefined':
        this.totals.tonnes += 1;
        if (this.chapter === 'mining') this.chapterTally.tonnes += 1;
        return this.observe('mining', TURN_WEIGHT, nowMs);
      case 'ScanOrganic': {
        // Only completed samples argue for the chapter; the analyse step fires 3x.
        if (ev.ScanType !== 'Sample' && ev.ScanType !== 'Analyse') return null;
        this.totals.samples += 1;
        if (this.chapter === 'exobiology') this.chapterTally.samples += 1;
        return this.observe('exobiology', TURN_WEIGHT, nowMs);
      }
      case 'Bounty':
      case 'FactionKillBond': {
        const cr = num(ev.TotalReward) ?? num(ev.Reward) ?? 0;
        this.totals.kills += 1;
        this.totals.bountyCr += cr;
        if (this.chapter === 'bounty hunting') {
          this.chapterTally.kills += 1;
          this.chapterTally.bountyCr += cr;
        }
        return this.observe('bounty hunting', 1, nowMs);
      }
      case 'FSSAllBodiesFound':
      case 'SAAScanComplete':
        this.totals.scans += 1;
        if (this.chapter === 'exploring') this.chapterTally.scans += 1;
        return this.observe('exploring', 1, nowMs);
      case 'MissionCompleted': {
        const name = str(ev.Name) ?? '';
        const reward = num(ev.Reward) ?? 0;
        this.totals.handIns += 1;
        this.totals.earned += reward;
        this.chapterTally.handIns += 1;
        this.winStreak += 1;
        this.lossStreak = 0;
        if (/passenger|sightsee|tourism/i.test(name)) return this.observe('passenger runs', TURN_WEIGHT, nowMs);
        if (/massacre|assassin/i.test(name)) return this.observe('bounty hunting', 1, nowMs);
        return this.observe('hauling', 1, nowMs);
      }
      case 'MissionAccepted': {
        const name = str(ev.Name) ?? '';
        if (/passenger|sightsee|tourism/i.test(name)) return this.observe('passenger runs', 1, nowMs);
        return null;
      }
      case 'MissionFailed':
      case 'MissionAbandoned':
        this.lossStreak += 1;
        this.winStreak = 0;
        return null;
      case 'Died':
        this.lastDeathAt = nowMs;
        this.lossStreak += 1;
        this.winStreak = 0;
        return null;
      case 'CommunityGoal': {
        // A rising personal contribution means the commander is WORKING the goal.
        const goals = Array.isArray(ev.CurrentGoals) ? (ev.CurrentGoals as Array<Record<string, unknown>>) : [];
        const sum = goals.reduce((s, g) => s + (num(g.PlayerContribution) ?? 0), 0);
        const rose = this.lastCgContribution >= 0 && sum > this.lastCgContribution;
        this.lastCgContribution = sum;
        if (!rose) return null;
        this.totals.cgDeliveries += 1;
        if (this.chapter === 'community-goal work') this.chapterTally.cgDeliveries += 1;
        return this.observe('community-goal work', TURN_WEIGHT, nowMs);
      }
      default:
        return null;
    }
  }

  private observe(kind: ChapterKind, weight: number, nowMs: number): string | null {
    if (this.chapter === kind) {
      this.votes.delete(kind);
      return null;
    }
    // First chapter opens silently — a session start is not a turn. The tally
    // is NOT reset here: the event that opened the chapter has already counted
    // itself into it (the opening hand-in belongs to the opening chapter).
    if (this.chapter === null) {
      this.chapter = kind;
      this.chapterStartedAt = nowMs;
      return null;
    }
    const v = this.votes.get(kind);
    const fresh = v && nowMs - v.at < OBSERVATION_WINDOW_MS ? v.weight : 0;
    const total = fresh + weight;
    if (total < TURN_WEIGHT) {
      this.votes.set(kind, { weight: total, at: nowMs });
      return null;
    }
    const closing = chapterFragment(this.chapter, this.chapterTally);
    this.chapter = kind;
    this.chapterStartedAt = nowMs;
    this.chapterTally = zeroTally();
    this.votes.clear();
    return `EVENT: Chapter turn — ${closing} closes; the run moves to ${kind}.`;
  }

  currentChapter(): ChapterKind | null {
    return this.chapter;
  }

  /**
   * The computed story-so-far, for the copilot's ARC line — or null before the
   * session has any shape. Numbers arrive pre-rounded so the model cannot
   * garble them.
   */
  arcLine(): string | null {
    if (!this.chapter) return null;
    const parts: string[] = [];
    if (this.totals.handIns > 0) {
      parts.push(
        `${this.totals.handIns} contract${this.totals.handIns === 1 ? '' : 's'} closed` +
          (this.totals.earned > 0 ? `, ${speakableCredits(this.totals.earned)} banked` : ''),
      );
    }
    if (this.winStreak >= 5) parts.push(`${this.winStreak} clean hand-ins without a miss — the streak is becoming a reputation`);
    else if (this.totals.handIns >= 8) parts.push('the kind of day that gets retold');
    const story = parts.length ? parts.join('; ') : 'the day is young, the board is open';
    return `ARC: the story so far — ${story}. Current chapter: ${chapterFragment(this.chapter, this.chapterTally)}.`;
  }

  /**
   * The operator's own state, computed from the session — never asked of the
   * model, only coloured by it. `hoursOnShift` comes from the store's clock.
   */
  moodLine(nowMs: number, hoursOnShift: number): string {
    const mood =
      nowMs - this.lastDeathAt < 20 * 60_000 && this.lastDeathAt > 0
        ? 'rattled but steady — that rebuy stung to watch'
        : this.lossStreak >= 2
          ? "clipped, a little worried — the run has gone sideways"
          : this.winStreak >= 5
            ? 'quietly proud, warming to the day — the streak is doing it'
            : hoursOnShift >= 4
              ? 'deep-shift tired, wry — coffee long gone cold'
              : this.chapter === 'mining'
                ? 'settled into the rhythm of the rocks'
                : this.chapter === 'exploring' || this.chapter === 'exobiology'
                  ? 'unhurried, a little far-eyed — the quiet work suits the hour'
                  : 'unhurried, dry good humour';
    return `OPERATOR MOOD: ${mood}.`;
  }
}
