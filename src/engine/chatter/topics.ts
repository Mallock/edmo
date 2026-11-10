/**
 * What a beat is ABOUT — and, most of the time, that it is not about you.
 *
 * The complaint that produced this module: almost every written scene was
 * anchored to what the commander was doing. Hauling produced hauling talk,
 * mining produced mining talk. It was coherent and completely dead, because a
 * channel that is always about the listener is a service, and a channel that
 * mostly is not is a place. Relevance was the bug.
 *
 * So the writer now takes a TOPIC ROLL before it takes a brief. A minority of
 * beats — the Relevance dial, ~30% by default — go down the old path and are
 * about the commander's business. The rest are ambient: somebody else's
 * divorce bleeding onto the open channel, a bar with one working chair, a man
 * who is certain the station rotates to hide something. None of it knows the
 * commander exists.
 *
 * Three rules keep it from becoming a joke database:
 *
 *  - The categories below are SEEDS, not lines. Each hands the model an idea
 *    concrete enough to act on and incomplete enough that the actual event,
 *    people and outcome are still invented — the same authoring rule as the
 *    situations in llm.ts.
 *  - A category cannot fire twice within NO_REPEAT_WINDOW beats. If the roll
 *    wants cargo again too soon it is rerolled, which is the cheapest way to
 *    make the air feel wide.
 *  - Some beats are FRAGMENTS: half an argument, a punchline with no setup,
 *    somebody answering a question the listener never heard. Overheard radio
 *    is mostly fragments, and a channel of complete exchanges is a stage play.
 *
 * Pure module. The store owns the clock and the dial; randomness is injected.
 */
import type { Quirk } from './cast.ts';
import type { ChannelId } from './types.ts';

// ---------------------------------------------------------------------------
// The dial
// ---------------------------------------------------------------------------

/**
 * How much of the chatter is about the commander.
 *
 * Its own setting, independent of the copilot's Involvement dial and of the
 * comms density: how often the galaxy talks and how much of it concerns you
 * are different questions, and "low" here is deliberately the funny setting.
 */
export type Relevance = 'low' | 'medium' | 'high';

export const RELEVANCE_LEVELS: readonly Relevance[] = ['low', 'medium', 'high'];

interface RelevancePolicy {
  /** The share of rolled beats that should end up about the commander. */
  target: number;
  /** Longest run of consecutive relevant beats allowed. */
  maxRun: number;
}

/**
 * The policy behind each level.
 *
 * `target` is what the listener should HEAR; the roll probability is derived
 * from it below, because the run cap changes the arithmetic. With a run cap
 * of one, a beat that follows a relevant beat can never be relevant, so the
 * steady-state share is p/(1+p) for a roll of p — a raw 0.3 roll would land
 * at 23%. The derivation is tested, not trusted.
 */
const POLICY: Readonly<Record<Relevance, RelevancePolicy>> = {
  low: { target: 0.15, maxRun: 1 },
  medium: { target: 0.3, maxRun: 1 },
  high: { target: 0.55, maxRun: 3 },
};

/** The share of beats a level aims to make about the commander. */
export function relevanceShare(level: Relevance): number {
  return (POLICY[level] ?? POLICY.medium).target;
}

/** Roll probability that yields `target` under the run cap. */
function rollProbability(policy: RelevancePolicy): number {
  const t = policy.target;
  if (policy.maxRun <= 1) return t / (1 - t);
  // Longer runs approach the raw share; a small lift covers the cap's bite.
  return Math.min(0.95, t * (1 + 1 / (policy.maxRun * 4)));
}

// ---------------------------------------------------------------------------
// The categories
// ---------------------------------------------------------------------------

export type TopicCategory =
  | 'wrong-channel'
  | 'station-advert'
  | 'grievance'
  | 'conspiracy'
  | 'bureaucracy'
  | 'small-tragedy'
  | 'wrong-lane'
  | 'mic-open';

export const TOPIC_CATEGORIES: readonly TopicCategory[] = [
  'wrong-channel',
  'station-advert',
  'grievance',
  'conspiracy',
  'bureaucracy',
  'small-tragedy',
  'wrong-lane',
  'mic-open',
];

/** A recurring voice's archetype — fixed for as long as the voice exists. */
export interface VoiceArchetype {
  /** Who they are, in words the model can act on. Follows "<name>, who …". */
  character: string;
  /** Speech quirk, from the cast's fixed set — decides the persona pool. */
  quirk: Quirk;
}

export interface TopicDef {
  id: TopicCategory;
  /** Short tag for the panel. */
  label: string;
  /** What this beat IS, for the model. Guidance, never a quotable line. */
  brief: string;
  /** Channels where this kind of thing is plausibly overheard. */
  channels: readonly ChannelId[];
  /**
   * Ideas, not lines. One is handed to the model per beat; a recurring voice
   * is born carrying one as their running bit and escalates it each return.
   */
  seeds: readonly string[];
  voice: VoiceArchetype;
}

export const TOPICS: Readonly<Record<TopicCategory, TopicDef>> = {
  'wrong-channel': {
    id: 'wrong-channel',
    label: 'wrong channel',
    brief:
      'A PRIVATE conversation bleeding onto the open channel. The people talking have no idea ' +
      'anyone else can hear, and nothing they say is meant for a radio: domestic logistics, ' +
      'a missing animal, somebody describing a meal. The comedy is that it is completely ' +
      'ordinary and completely public.',
    channels: ['LOCAL', 'STATION', 'DEEP', 'CREW', 'CONCOURSE', 'CARRIER'],
    seeds: [
      'two people sorting out who keeps the ship and who keeps the dog, unaware the channel is open',
      'a pilot narrating their lunch to a friend, course by course, with opinions',
      'an appeal for a pet that has been loose somewhere on a station for a week',
      'two people planning a surprise for a third person who is plainly on the same frequency',
      'a message meant for one person, played to every ship in range',
      'somebody apologising at length to a partner while a controller waits to get a word in',
      'a shopping list being read to somebody at home, with corrections from the other end',
      'a heated exchange about whose turn it was to feed something',
      'somebody being talked through a recipe by a relative, one careful step at a time',
      'a private argument about a wedding seating plan on the frequency everybody uses',
    ],
    voice: {
      character:
        'keeps keying the open channel by accident, has done it for years, and has never once ' +
        'realised that everybody can hear',
      quirk: 'cheerful',
    },
  },
  'station-advert': {
    id: 'station-advert',
    label: 'station advert',
    brief:
      'Aggressively bad local commerce. Somebody advertising a small business with far more ' +
      'confidence than the business deserves — the offer is poor, the small print is worse, ' +
      'and the pitch keeps almost admitting it. Played completely straight.',
    channels: ['STATION', 'CONCOURSE', 'CARRIER', 'LOCAL'],
    seeds: [
      'discount limpets whose legality the advertiser keeps very nearly addressing',
      'a bar boasting exactly one working chair and treating it as a feature',
      'a repair shop whose guarantee has more conditions than the repair',
      'a noodle stand advertising a dish whose name changes halfway through the advert',
      'a shuttle service promising arrival times it plainly cannot keep',
      'a used-ship dealer describing a hull that has "character"',
      'a fuel stall with a loyalty scheme nobody has ever completed',
      'an insurance broker reading the small print aloud, which takes a while',
      'a laundry service on deck four whose slogan gets worse each time it is said',
      'a cartographer selling maps of places that are, on reflection, right there',
    ],
    voice: {
      character:
        'runs a small concourse business and advertises it like a resort, over any channel ' +
        'that will carry it',
      quirk: 'cheerful',
    },
  },
  grievance: {
    id: 'grievance',
    label: 'petty grievance',
    brief:
      'A petty complaint taken with total seriousness: pad etiquette, parking angles, queue ' +
      'discipline, the eternal argument about a certain mug. Nobody involved is in any danger ' +
      'and everybody involved is furious.',
    channels: ['LOCAL', 'STATION', 'CONCOURSE', 'CARRIER', 'CREW'],
    seeds: [
      'whoever is in pad seven has parked at an angle that has upset several people',
      'a ship that has sat on a pad for three shifts and will not move',
      'the long-running dispute about the Hutton Orbital mug, with new evidence',
      'somebody holding the mail slot to line up a picture of their ship',
      'a neighbour running thrusters at what is technically night',
      'the eternal question of who left a limpet on the pad',
      'a pilot who took the docking queue as a suggestion',
      'a complaint about somebody else’s ship name, sustained at length',
      'a landing so slow that the two ships behind it have started a book club',
      'somebody using the priority lane as a shortcut, again',
    ],
    voice: {
      character:
        'has strong views on parking, queueing and pad etiquette, and shares them with anyone ' +
        'on the frequency whether or not they asked',
      quirk: 'gruff',
    },
  },
  conspiracy: {
    id: 'conspiracy',
    label: 'conspiracy',
    brief:
      'Somebody who is absolutely certain and entirely wrong. The theory is built out of ' +
      'ordinary station life — rotation, pad numbers, the coffee — and gets bigger every time ' +
      'it is told. They are not joking, and the second voice, if any, is not convinced.',
    channels: ['LOCAL', 'DEEP', 'CREW', 'CONCOURSE'],
    seeds: [
      'a theory that the station only rotates so nobody notices what is on the far side',
      'certainty that the docking computer assigns pads according to personality',
      'a claim that the nav beacon has been broadcasting a message backwards',
      'the discovery that two different stations employ the same cleaner',
      'a theory about why the coffee on every station tastes exactly the same',
      'evidence, supposedly, that a fleet carrier has been following the speaker for years',
      'a claim that mail slots are getting narrower and nobody will confirm it',
      'a growing suspicion that the year is not what everybody says it is',
      'a theory that pad numbers are handed out by somebody with a grudge',
      'somebody who counted the stars from two systems and got different answers',
    ],
    voice: {
      character:
        'is absolutely certain about something nobody else believes, has been for some time, ' +
        'and has new evidence every week',
      quirk: 'anxious',
    },
  },
  bureaucracy: {
    id: 'bureaucracy',
    label: 'bureaucracy',
    brief:
      'A station official reading a rule nobody needs, with clause numbers, to people who ' +
      'did not ask. The procedure is airtight and the thing it governs does not exist, or ' +
      'cannot, or is itself. Delivered without a flicker of doubt.',
    channels: ['STATION', 'CONCOURSE', 'CARRIER'],
    seeds: [
      'a form required for all cargo that does not currently exist, explained clause by clause',
      'a reminder about a regulation whose number nobody can find',
      'a notice that a notice has been withdrawn, pending a further notice',
      'the correct procedure for reporting an incorrect procedure, read in full',
      'a sub-clause defining a "pad", read to a ship that is sitting on one',
      'a permit renewal that requires the permit it renews',
      'a queue for the desk that issues queue numbers',
      'an official clarifying which clause covers an apology',
      'the annual audit of the annual audit, announced with quiet pride',
      'an amendment to the docking fee schedule that changes only the font',
    ],
    voice: {
      character:
        'is a station administrator who has read every regulation, cites them by number, and ' +
        'believes the paperwork is the point',
      quirk: 'formal',
    },
  },
  'small-tragedy': {
    id: 'small-tragedy',
    label: 'small tragedy',
    brief:
      'A minor disaster told in episodes by the person it keeps happening to. A Sidewinder ' +
      'and its insurance, a parcel that cannot be delivered, the wrong ship bought with ' +
      'everything. Told calmly, by somebody past caring, and worse every time.',
    channels: ['LOCAL', 'DEEP', 'STATION', 'CREW'],
    seeds: [
      'a Sidewinder pilot explaining, again, what became of the previous Sidewinder',
      'an insurance claim that has now outlived the ship, the savings and one adjuster',
      'somebody who sold everything for a ship that turned out to be the wrong ship',
      'the fourth rebuy this month, told with the calm of somebody past caring',
      'a cargo lost to a hatch that was very slightly not closed',
      'a courier who has carried the same undeliverable parcel for a month',
      'somebody who paid for a map of the system they were already in',
      'an explorer back after a year to find their favourite bar is now a permit desk',
      'a mining run where the only thing found was the limpets lost last time',
      'a rescue that went so well the rescuer now needs rescuing',
    ],
    voice: {
      character:
        'has had the same small disaster happen so many times that they now tell it like the ' +
        'weather, in episodes, to whoever is listening',
      quirk: 'dry',
    },
  },
  'wrong-lane': {
    id: 'wrong-lane',
    label: 'wrong lane',
    brief:
      'A pilot describing a manoeuvre with real technical confidence, in detail, that very ' +
      'clearly did not work out. The description is the joke: it stays proud all the way ' +
      'through the part where it goes wrong.',
    channels: ['LOCAL', 'STATION', 'CARRIER'],
    seeds: [
      'a docking approach that ended in the mail slot sideways, described as intended',
      'a manoeuvre explained so confidently that its failure surprises nobody but the speaker',
      'somebody who tried to boost through the mail slot and is now explaining why',
      'a landing the pilot calls "firm" and the pad crew call something else',
      'a shortcut through a ring that cost most of the paint',
      'a supercruise exit so close to the star that the retelling keeps pausing',
      'a planetary landing attempted with the gear up and defended afterwards',
      'a reverse out of a pad that reversed several other things too',
      'a turn that was meant to be a turn and became a rotation',
      'somebody interdicted by their own wingmate, still narrating the aftermath',
    ],
    voice: {
      character:
        'is a pilot who describes every manoeuvre as textbook, including the ones that ended ' +
        'in a repair bay',
      quirk: 'veteran',
    },
  },
  'mic-open': {
    id: 'mic-open',
    label: 'mic open',
    brief:
      'A microphone left open on somebody who does not know it. Humming, chewing, a private ' +
      'argument with a machine, a checklist read aloud and disagreed with. Nothing is ' +
      'addressed to anyone — it is a person alone, overheard.',
    channels: ['LOCAL', 'CREW', 'CONCOURSE', 'DEEP', 'STATION'],
    seeds: [
      'somebody humming a tune they clearly do not know, on an open microphone',
      'a pilot chewing something loudly and reviewing it to nobody',
      'a losing argument with a vending machine, keyed in by accident',
      'somebody reading their own checklist aloud and disagreeing with it',
      'a mic left open on a person talking to a plant',
      'a cockpit where somebody is rehearsing a speech to a landlord',
      'a person counting something under their breath and losing the count',
      'a ship’s cat being negotiated with, at length',
      'somebody singing a station jingle and then being disgusted with themselves',
      'a pilot narrating their own docking to themselves in the third person',
    ],
    voice: {
      character:
        'leaves the microphone open without noticing and talks to themselves, to machines and ' +
        'to a cat as though nobody else exists',
      quirk: 'drawl',
    },
  },
};

/** Categories plausible on a channel. Empty for the channels that must never
 *  carry comedy — the tower is talking to the commander, and an emergency is
 *  an emergency. */
export function categoriesFor(channel: ChannelId): TopicCategory[] {
  return TOPIC_CATEGORIES.filter((c) => TOPICS[c].channels.includes(channel));
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The shape of an ambient beat.
 *
 * 'exchange' is the ordinary call-and-response. The three fragments are what
 * overheard radio mostly IS: you tune in late, you leave early, you catch the
 * answer and never the question.
 */
export type BeatShape = 'exchange' | 'reply-unheard' | 'punchline' | 'mid-argument';

/** Share of ambient beats that are fragments rather than whole exchanges. */
export const FRAGMENT_SHARE = 0.3;

const FRAGMENTS: readonly Exclude<BeatShape, 'exchange'>[] = [
  'reply-unheard',
  'punchline',
  'mid-argument',
];

/** How many lines a shape asks for; undefined leaves it to the caller. */
export function linesForShape(shape: BeatShape): number | undefined {
  switch (shape) {
    case 'reply-unheard':
    case 'punchline':
      return 1;
    case 'mid-argument':
      return 2;
    default:
      return undefined;
  }
}

/** What the shape asks of the writer — an order, placed last in the prompt. */
export const SHAPE_BRIEF: Readonly<Record<BeatShape, string>> = {
  exchange: '',
  'reply-unheard':
    'A FRAGMENT: one line only — somebody answering a question the listener never heard. ' +
    'The answer must make the question obvious, and slightly alarming.',
  punchline:
    'A FRAGMENT: one line only — the punchline of a story whose setup the listener missed. ' +
    'It should be funnier for having no setup.',
  'mid-argument':
    'A FRAGMENT: two lines from the MIDDLE of an argument — not the start, not the end. Each ' +
    'line refers to something that happened before the listener tuned in.',
};

// ---------------------------------------------------------------------------
// The roll
// ---------------------------------------------------------------------------

/** How many beats back a category is barred from firing again. */
export const NO_REPEAT_WINDOW = 3;

/** Beats remembered, for the window and for the panel's share readout. */
const RECENT_DEPTH = 24;

export interface TopicRollInput {
  channel: ChannelId;
  relevance: Relevance;
  rand: () => number;
}

export type TopicRoll =
  | { kind: 'relevant' }
  | {
      kind: 'ambient';
      category: TopicCategory;
      /** The idea handed to the writer. */
      seed: string;
      seedIndex: number;
      shape: BeatShape;
      /** Lines the shape asks for, or undefined for the caller's default. */
      lines: number | undefined;
    };

/**
 * Remembers what the air has lately been about, and rolls the next beat.
 *
 * Two memories. The RECENT list is the no-repeat window: a category that fired
 * within the last few beats is barred and the roll picks among the rest. The
 * SEED counter is least-recently-used ordering for the ideas inside a
 * category, for the same reason templates and situations use it — random
 * picking clusters, and a finite pool picked at random plays some ideas three
 * times before others play once.
 */
export class TopicLedger {
  /** Category ids, or 'relevant', oldest first. */
  private recent: string[] = [];
  private seedUse = new Map<string, number>();
  private useSeq = 0;

  /** The last few beats, oldest first — for tests and the panel. */
  history(): readonly string[] {
    return this.recent;
  }

  /** Share of remembered rolls that were about the commander. */
  relevantShare(): number {
    if (!this.recent.length) return 0;
    return this.recent.filter((r) => r === 'relevant').length / this.recent.length;
  }

  /** Categories barred right now — the panel and the tests read this. */
  barred(): Set<string> {
    return new Set(this.recent.slice(-NO_REPEAT_WINDOW));
  }

  private relevantRun(): number {
    let n = 0;
    for (let i = this.recent.length - 1; i >= 0 && this.recent[i] === 'relevant'; i--) n++;
    return n;
  }

  /**
   * Roll the next beat.
   *
   * The relevance roll comes first and is independent of everything but the
   * dial and the run cap. If it loses, or the run cap refuses it, an ambient
   * category is drawn from those that fit the channel and are outside the
   * window. When nothing fits — the tower, an emergency — the beat is relevant
   * by construction; when everything that fits is barred, the coldest barred
   * category is taken rather than going silent, because a repeat is a smaller
   * failure than a dead channel.
   */
  roll(input: TopicRollInput): TopicRoll {
    const fits = categoriesFor(input.channel);
    if (!fits.length) return { kind: 'relevant' };

    const policy = POLICY[input.relevance] ?? POLICY.medium;
    const canBeRelevant = this.relevantRun() < policy.maxRun;
    if (canBeRelevant && input.rand() < rollProbability(policy)) return { kind: 'relevant' };

    const barred = this.barred();
    let open = fits.filter((c) => !barred.has(c));
    if (!open.length) {
      // Everything plausible here fired recently. Take whichever fired longest
      // ago — the same "hearing it twice beats silence" trade the engine's
      // starvation breaker makes.
      const age = (c: TopicCategory): number => {
        const i = this.recent.lastIndexOf(c);
        return i < 0 ? -1 : i;
      };
      open = [...fits].sort((a, b) => age(a) - age(b)).slice(0, 1);
    }
    const category = open[Math.floor(input.rand() * open.length) % open.length];
    const { seed, seedIndex } = this.pickSeed(category, input.rand);

    const shape: BeatShape =
      input.rand() < FRAGMENT_SHARE
        ? FRAGMENTS[Math.floor(input.rand() * FRAGMENTS.length) % FRAGMENTS.length]
        : 'exchange';

    return { kind: 'ambient', category, seed, seedIndex, shape, lines: linesForShape(shape) };
  }

  /**
   * An idea from the category, coldest first.
   *
   * Random among the coldest few rather than strictly the coldest, so the
   * order varies while the coverage does not — the template picker's idiom.
   */
  pickSeed(
    category: TopicCategory,
    rand: () => number,
    exclude: ReadonlySet<string> = new Set(),
  ): { seed: string; seedIndex: number } {
    const seeds = TOPICS[category].seeds;
    const pool = seeds.map((seed, i) => ({ seed, i })).filter((s) => !exclude.has(s.seed));
    const source = pool.length ? pool : seeds.map((seed, i) => ({ seed, i }));
    const ordered = [...source].sort(
      (a, b) => (this.seedUse.get(`${category}:${a.i}`) ?? 0) - (this.seedUse.get(`${category}:${b.i}`) ?? 0),
    );
    const cold = ordered.slice(0, Math.min(3, ordered.length));
    const pick = cold[Math.floor(rand() * cold.length) % cold.length];
    this.useSeq += 1;
    this.seedUse.set(`${category}:${pick.i}`, this.useSeq);
    return { seed: pick.seed, seedIndex: pick.i };
  }

  /** A rolled beat was actually written. Only then does it count. */
  note(what: 'relevant' | TopicCategory): void {
    this.recent.push(what);
    if (this.recent.length > RECENT_DEPTH) this.recent = this.recent.slice(-RECENT_DEPTH);
  }

  load(json: unknown): void {
    const data = json as { recent?: unknown; seedUse?: unknown } | null;
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.recent)) {
      this.recent = data.recent.filter((x): x is string => typeof x === 'string').slice(-RECENT_DEPTH);
    }
    if (data.seedUse && typeof data.seedUse === 'object') {
      this.seedUse = new Map(
        Object.entries(data.seedUse as Record<string, unknown>).filter(
          (e): e is [string, number] => typeof e[1] === 'number',
        ),
      );
      this.useSeq = Math.max(0, ...this.seedUse.values());
    }
  }

  toJSON(): { recent: string[]; seedUse: Record<string, number> } {
    return { recent: this.recent, seedUse: Object.fromEntries(this.seedUse) };
  }

  /** Test/reset hook. */
  reset(): void {
    this.recent = [];
    this.seedUse.clear();
    this.useSeq = 0;
  }
}

/** Subject key for the texture brief an ambient beat is written against —
 *  distinct per seed, so the same-subject gate sees variety, and prefixed so
 *  the engine never opens a story arc on a running gag (the regulars' ledger
 *  is that mechanism). */
export function topicSubjectKey(category: TopicCategory, seedIndex: number): string {
  return `topic:${category}:${seedIndex}`;
}
