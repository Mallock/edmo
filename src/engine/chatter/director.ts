/**
 * The act machine and the scene picker — where cadence becomes drama.
 *
 * Cadence alone produces ambience: lines arriving at plausible intervals,
 * forever, about nothing. What turns that into a world is structure, and the
 * structure here is four acts driven by the same pressure signal the copilot
 * already uses.
 *
 *        no threat, routine                    threat rising
 *   ┌──────────────────────┐   pressure↑   ┌──────────────────────┐
 *   │        QUIET         │──────────────▶│       BUILDING       │
 *   │ texture and setup    │◀──────────────│ setups pay off, no   │
 *   │                      │   pressure↓   │ idle texture         │
 *   └──────────┬───────────┘               └──────────┬───────────┘
 *              │                                      │ combat / hazard
 *              │                                      ▼
 *              │                           ┌──────────────────────┐
 *              │                           │        CRISIS        │
 *              │                           │ EVERY ambient channel│
 *              │                           │ silent. Emergency    │
 *              │                           │ only, and only true. │
 *              │                           └──────────┬───────────┘
 *              │                                      │ fight over
 *              │                           ┌──────────▼───────────┐
 *              └───────────────────────────│       AFTERMATH      │
 *                                          │ the world reacts     │
 *                                          └──────────────────────┘
 *
 * CRISIS is the important one, and it is defined entirely by what it REMOVES.
 * The chatter the commander had stopped noticing stops, and the silence lands
 * harder than any line could — at a generation cost of exactly nothing. It is
 * the cheapest good idea in the whole feature.
 *
 * Pure module: time is passed in, randomness is injected, nothing is spoken
 * here. The store owns the clock and the Speaker.
 */
import { isNearDuplicate } from '../copilot.ts';
import type { Brief } from './brief.ts';
import { functionsForAct, sceneText, type Scene } from './scenes.ts';
import type { Act, DramaticFunction } from './types.ts';

// ---------------------------------------------------------------------------
// The act machine
// ---------------------------------------------------------------------------

/** Pressure at which QUIET gives way to BUILDING. */
export const BUILDING_AT = 0.35;
/** …and at which BUILDING settles back. Hysteresis: a value that both enters
 *  and leaves would flap the act every tick around the boundary. */
export const QUIET_AT = 0.2;
/** How long AFTERMATH runs before decaying to QUIET. */
export const AFTERMATH_MS = 4 * 60_000;

export interface ActInput {
  nowMs: number;
  pressure: number;
  /** A fight is in progress, or a hull/heat hazard is live. */
  inCrisis: boolean;
  /** The combat streak just reported its summary — the fight is over. */
  crisisResolvedAt?: number | null;
}

export interface ActTransition {
  from: Act;
  to: Act;
  atMs: number;
  reason: string;
}

/**
 * Tracks the act.
 *
 * Transitions are recorded rather than merely applied, because the panel shows
 * them and because a state machine you cannot observe is a state machine you
 * cannot test.
 */
export class ActMachine {
  private act: Act = 'QUIET';
  private enteredAt = 0;
  private aftermathUntil = 0;
  private log: ActTransition[] = [];

  get current(): Act {
    return this.act;
  }

  get since(): number {
    return this.enteredAt;
  }

  /** Transitions since the last drain — for the panel. */
  drainTransitions(): ActTransition[] {
    const out = this.log;
    this.log = [];
    return out;
  }

  private to(next: Act, nowMs: number, reason: string): void {
    if (next === this.act) return;
    this.log.push({ from: this.act, to: next, atMs: nowMs, reason });
    this.act = next;
    this.enteredAt = nowMs;
  }

  update(input: ActInput): Act {
    const { nowMs, pressure, inCrisis } = input;

    // Crisis wins over everything. Nothing about a quiet cadence should be
    // able to keep the channel open while the commander is being shot at.
    if (inCrisis) {
      this.to('CRISIS', nowMs, 'combat or hazard');
      return this.act;
    }

    if (this.act === 'CRISIS') {
      this.aftermathUntil = nowMs + AFTERMATH_MS;
      this.to('AFTERMATH', nowMs, 'the fight is over');
      return this.act;
    }

    if (input.crisisResolvedAt) {
      this.aftermathUntil = Math.max(this.aftermathUntil, input.crisisResolvedAt + AFTERMATH_MS);
      this.to('AFTERMATH', nowMs, 'combat resolved');
      return this.act;
    }

    if (this.act === 'AFTERMATH') {
      if (nowMs < this.aftermathUntil) return this.act;
      this.to(pressure >= BUILDING_AT ? 'BUILDING' : 'QUIET', nowMs, 'aftermath elapsed');
      return this.act;
    }

    if (this.act === 'QUIET' && pressure >= BUILDING_AT) {
      this.to('BUILDING', nowMs, 'pressure rising');
    } else if (this.act === 'BUILDING' && pressure < QUIET_AT) {
      this.to('QUIET', nowMs, 'pressure eased');
    }
    return this.act;
  }

  /** Test/reset hook. */
  reset(): void {
    this.act = 'QUIET';
    this.enteredAt = 0;
    this.aftermathUntil = 0;
    this.log = [];
  }
}

// ---------------------------------------------------------------------------
// Anti-repetition
// ---------------------------------------------------------------------------

/**
 * Scenes remembered for the text-similarity gate.
 *
 * Was 6, which was sized against a cadence of roughly twenty transmissions an
 * hour. At the shipped density — ninety an hour — six is under five minutes of
 * memory, and a measured run showed the minimum gap before a line came back
 * was exactly seven transmissions: the ring depth plus one. It was not a
 * safeguard, it was the thing setting the repeat rate.
 */
const RECENT_TEXT = 28;
/** Subjects remembered per channel — deeper, because a stuck record is
 *  audible as a topic long before it is audible as a phrase. */
const RECENT_SUBJECTS = 24;
/** Templates remembered per channel, for the least-recently-used ordering. */
const RECENT_TEMPLATES = 64;

export type RejectReason = 'near-duplicate' | 'same-subject' | 'invalid';

/**
 * Remembers what has just been said, so it is not said again.
 *
 * Two gates, because they catch different failures. The text gate (borrowed
 * wholesale from the copilot, which had exactly this problem) catches a scene
 * rephrasing one from ten minutes ago. The subject gate catches the far more
 * noticeable case of three consecutive transmissions all being about the price
 * of Bertrandite, in three different sets of words.
 */
export class RepetitionGuard {
  private texts: string[] = [];
  private subjects = new Map<string, string[]>();
  /** Monotonic use counter per template id — the LRU ordering. */
  private templateUse = new Map<string, number>();
  private useSeq = 0;

  /** Why this scene should be rejected, or null to allow it. */
  check(scene: Scene): RejectReason | null {
    const text = sceneText(scene);
    // isNearDuplicate compares against the whole ring in one call — it takes
    // the list, not one string at a time.
    if (this.texts.length && isNearDuplicate(text, this.texts)) return 'near-duplicate';

    const perChannel = this.subjects.get(scene.channel) ?? [];
    // Only the immediately preceding subject on this channel is a hard block;
    // further back it is merely discouraged (handled by the caller's ordering).
    if (perChannel[perChannel.length - 1] === scene.brief.subjectKey) return 'same-subject';
    return null;
  }

  /** Record a scene as transmitted. */
  remember(scene: Scene): void {
    this.texts.push(sceneText(scene));
    if (this.texts.length > RECENT_TEXT) this.texts = this.texts.slice(-RECENT_TEXT);

    const list = this.subjects.get(scene.channel) ?? [];
    list.push(scene.brief.subjectKey);
    this.subjects.set(scene.channel, list.slice(-RECENT_SUBJECTS));

    if (scene.templateId) {
      this.useSeq += 1;
      this.templateUse.set(scene.templateId, this.useSeq);
      if (this.templateUse.size > RECENT_TEMPLATES) {
        // Drop the coldest entries; they are the ones the ordering below would
        // have picked next anyway, so forgetting them costs nothing.
        const cold = [...this.templateUse.entries()]
          .sort((a, b) => a[1] - b[1])
          .slice(0, this.templateUse.size - RECENT_TEMPLATES);
        for (const [k] of cold) this.templateUse.delete(k);
      }
    }
  }

  /**
   * When this template was last used. 0 means never.
   *
   * Drives least-recently-used template selection, which is what actually
   * fixes repetition. Picking at random and rejecting collisions sounds
   * equivalent and is not: random picking clusters, so with N templates you
   * hear some of them three times before you hear others once. Cycling the
   * catalogue guarantees every line gets an airing before any line repeats.
   */
  templateAge(templateId: string): number {
    return this.templateUse.get(templateId) ?? 0;
  }

  /**
   * Mark an arbitrary key as used now.
   *
   * The same least-recently-used machinery serves anything that is picked from
   * a finite set and would otherwise cluster — templates, and the situations
   * the model is asked to write about.
   */
  noteUse(key: string): void {
    this.useSeq += 1;
    this.templateUse.set(key, this.useSeq);
  }

  /** Current use counter, for callers comparing several templates. */
  get useCounter(): number {
    return this.useSeq;
  }

  /** How recently this subject was used on this channel — 0 = never. */
  subjectHeat(channel: string, subjectKey: string): number {
    const list = this.subjects.get(channel) ?? [];
    const i = list.lastIndexOf(subjectKey);
    return i < 0 ? 0 : (i + 1) / list.length;
  }

  load(json: unknown): void {
    const data = json as {
      texts?: string[];
      subjects?: Record<string, string[]>;
      templates?: Record<string, number>;
    } | null;
    if (!data) return;
    if (Array.isArray(data.texts)) this.texts = data.texts.slice(-RECENT_TEXT);
    if (data.subjects && typeof data.subjects === 'object') {
      this.subjects = new Map(Object.entries(data.subjects));
    }
    if (data.templates && typeof data.templates === 'object') {
      this.templateUse = new Map(Object.entries(data.templates));
      this.useSeq = Math.max(0, ...this.templateUse.values());
    }
  }

  toJSON(): {
    texts: string[];
    subjects: Record<string, string[]>;
    templates: Record<string, number>;
  } {
    return {
      texts: this.texts,
      subjects: Object.fromEntries(this.subjects),
      templates: Object.fromEntries(this.templateUse),
    };
  }
}

// ---------------------------------------------------------------------------
// Choosing what a scene should be doing
// ---------------------------------------------------------------------------

export interface FunctionChoice {
  func: DramaticFunction;
  /** The arc this beat continues, when it continues one. */
  arcId?: string;
}

/**
 * What should the next scene DO?
 *
 * An open arc that has already been established wants complicating or
 * reversing, and that preference is the entire mechanism by which anything in
 * this feature accumulates. Everything else falls back to what the act allows.
 */
export function chooseFunction(
  act: Act,
  openArcs: Array<{ id: string; beats: Array<{ func: DramaticFunction }> }>,
  rand: () => number,
): FunctionChoice | null {
  const allowed = functionsForAct(act);
  if (!allowed.length) return null;

  // Continue a thread roughly half the time when one is available and the act
  // has room for the beat it needs next.
  if (openArcs.length && rand() < 0.55) {
    const arc = openArcs[Math.floor(rand() * openArcs.length) % openArcs.length];
    const next = nextBeatFor(arc.beats.map((b) => b.func));
    if (allowed.includes(next)) return { func: next, arcId: arc.id };
  }
  return { func: allowed[Math.floor(rand() * allowed.length) % allowed.length] };
}

/** Where a thread goes next, given where it has been. */
export function nextBeatFor(sofar: readonly DramaticFunction[]): DramaticFunction {
  if (!sofar.length) return 'establish';
  const complications = sofar.filter((f) => f === 'complicate').length;
  // One complication is a story; three is a soap opera. Turn it.
  if (complications >= 2) return 'reverse';
  if (sofar[sofar.length - 1] === 'establish') return 'complicate';
  return rand01(sofar.length) < 0.5 ? 'complicate' : 'reverse';
}

/** Deterministic pseudo-random from a small integer — no global state. */
function rand01(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// Scoring candidate briefs
// ---------------------------------------------------------------------------

/**
 * Rank briefs so the interesting ones surface.
 *
 * Recency and magnitude matter, but the dominant term is repetition: a
 * perfectly good price movement that was mentioned two transmissions ago is
 * worth less than a duller one nobody has heard, because the failure the
 * commander actually notices is not "that was boring", it is "it keeps saying
 * the same thing".
 */
export function scoreBrief(
  brief: Brief,
  channel: string,
  guard: RepetitionGuard,
): number {
  let s = 1;
  if (brief.kind === 'market') s += 1.2;
  if (brief.kind === 'event') s += 1.5;
  if (brief.kind === 'construction') s += 0.8;
  if (brief.kind === 'faction') s += 0.6;
  if (brief.kind === 'texture') s -= 0.5;

  // Fresher is better, but never decisive — a day-old price is still news to
  // somebody who has been in supercruise since.
  const ageH = (brief.ageMs ?? 0) / 3_600_000;
  s -= Math.min(1, ageH / 48);

  s -= 2.5 * guard.subjectHeat(channel, brief.subjectKey);
  return s;
}

/** Best brief for a channel, or null when everything is worn out. */
export function pickBrief(
  briefs: readonly Brief[],
  channel: string,
  guard: RepetitionGuard,
): Brief | null {
  if (!briefs.length) return null;
  let best: Brief | null = null;
  let bestScore = -Infinity;
  for (const b of briefs) {
    const s = scoreBrief(b, channel, guard);
    if (s > bestScore) {
      bestScore = s;
      best = b;
    }
  }
  return best;
}
