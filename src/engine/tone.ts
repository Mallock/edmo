/**
 * A different register each time, on top of the same voice.
 *
 * Rotating the FACTS (see rotate.ts) stopped the briefs being byte-identical,
 * but the instructions around them repeated on a short cycle — eight registers,
 * eight angles — and worse, the grounding instruction let the model choose which
 * fact to build on, so it chose the same juiciest one every time. A live session
 * produced five consecutive STATION scenes about the same 3,121 tons of steel:
 * different words, one idea, thirteen minutes of it.
 *
 * So the pools are COMPOSED now rather than flat. A register is a mood crossed
 * with a lean, a news angle is an angle crossed with a lede rule, and the pool
 * sizes are chosen coprime (13 × 11, with a 12-entry anchor pool) so consecutive
 * rotations walk the full cross product: 143 distinct registers before a comms
 * prompt repeats, and the mood/lean/anchor combination does not recur for 1,716
 * calls. The user asked for at least fifty; composition buys hundreds for the
 * price of two dozen well-written lines.
 *
 * None of them changes what may be said, only how it is pitched and which part
 * of the briefing carries the weight. Nothing here can make output less
 * accurate — the worst case is a line that would have read the same anyway.
 *
 * Rotated, not random, for the same reason the briefs are: the caller owns a
 * counter, the functions stay pure, and a run is reproducible.
 */

/** xs[rotate], wrapping and safe against negative counters. */
const pick = <T>(xs: readonly T[], rotate: number): T =>
  xs[((rotate % xs.length) + xs.length) % xs.length];

// ----------------------------------------------------------------- comms

/** The mood of the exchange. 13 entries — coprime with the leans below. */
const COMMS_MOOD: readonly string[] = [
  'Pitch this one mid-conversation — they have been talking for a while already.',
  'Pitch this one clipped and busy. Nobody has time to finish a thought.',
  'Pitch this one tired. It is late in a long shift and it shows.',
  'Pitch this one faintly amused. Somebody finds the situation funnier than it is.',
  'Pitch this one wary. Neither of them is saying everything they know.',
  'Pitch this one flat and procedural, until one word gives something away.',
  'Pitch this one as a disagreement neither party will name outright.',
  'Pitch this one as two people who have had this exact exchange before.',
  'Pitch this one relieved — something finally went right and neither of them trusts it.',
  'Pitch this one impatient. One of them wanted this settled an hour ago.',
  'Pitch this one almost warm. They like each other and would never say so.',
  'Pitch this one distracted — one speaker is clearly doing something else at the same time.',
  'Pitch this one matter-of-fact about something that deserves more alarm than it gets.',
];

/** A structural lean for the lines themselves. 11 entries. */
const COMMS_LEAN: readonly string[] = [
  'Open on the reply, as if we missed the first half.',
  'Let one line be much shorter than the other.',
  'Put a number in one line and none in the other.',
  'Let the second line refuse, deflect or correct the first.',
  'Mention a person who is not on the channel.',
  'Let something mundane carry the weight — a meal, a shift, a form.',
  'End on the line that raises the question, not the one that answers it.',
  'Keep both speakers half-focused on their own work.',
  'Let one speaker mishear or half-hear the other.',
  'Make the second line change the subject without acknowledging the first.',
  // Replaced 'let neither line name the thing' — it was TEACHING crypticness
  // one scene in eleven, and the live air had gone telegraphic everywhere.
  'Let one speaker actually explain something, patiently, in plain words.',
];

/**
 * Which part of the briefing carries this scene. 21 entries.
 *
 * This is the data half of the randomizer, and the one the steel loop proved
 * necessary: told only to "choose one concrete fact", a model chooses the same
 * standout figure every single time. Steering the choice costs nothing when the
 * briefing lacks the named item — the instruction reads as a preference and the
 * model falls back to what is there.
 *
 * REBALANCED on live evidence. The pool was fourteen entries of which two were
 * the faction board, three were places and infrastructure, and NONE were
 * ordinary life — so two scenes in seven opened with an explicit order to write
 * about politics or a station, and the air came out reading like a bulletin
 * from a system nobody actually lives in. A prompt census made it plain: the
 * briefing rows were 62% factions and places, 0% anything domestic, and the
 * model was obeying perfectly.
 *
 * The five life anchors below are the correction. They cost nothing when the
 * briefing is thin — a model with no domestic fact to hand invents one, which
 * is exactly what people on a radio do. Twenty-one is coprime with the moods
 * (13), leans (11) and moments (25), so one shared counter still walks the
 * whole cross product rather than locking the pools together.
 */
/** An anchor and what KIND of material it steers the scene toward. */
interface Anchor {
  kind: 'politics' | 'place' | 'life' | 'free';
  text: string;
}

const COMMS_ANCHOR: readonly Anchor[] = [
  // Interleaved, not appended: the pool is walked by a rotating counter, so
  // entries added at the END are only reached at the end of the cycle. Measured
  // — appending five life anchors put them at rotations 14-18, a sixteen-scene
  // session saw two, and LIFE stayed flat at 6%. Spacing them every fourth
  // entry is what makes a short session actually contain any.
  { kind: 'politics', text: 'This time, prefer the FACTION BOARD as the driver — who runs the place, who is climbing.' },
  { kind: 'place', text: 'This time, prefer a STATION by name as the driver.' },
  { kind: 'life', text: 'This time, prefer ORDINARY LIFE as the driver — a meal, the end of a shift, sleep, ' +
    'somebody’s family, what they do when not working.' },
  { kind: 'place', text: 'This time, prefer a SIGNAL out there as the driver — a site, a beacon, a zone.' },
  { kind: 'place', text: 'This time, prefer DISTANCE as the driver — how far everything is from everything.' },
  { kind: 'life', text: 'This time, prefer FOOD OR SUPPLY as the driver — the canteen, what the shops are out of, ' +
    'a delivery of something unglamorous somebody is waiting on.' },
  { kind: 'free', text: 'This time, prefer the SECURITY rating as the driver.' },
  { kind: 'free', text: 'This time, prefer the ECONOMY as the driver — what this system does for a living.' },
  { kind: 'life', text: 'This time, prefer TIME as the driver — the hour, how long a shift has run, a birthday, ' +
    'an anniversary nobody else remembers.' },
  { kind: 'place', text: 'This time, prefer TRAFFIC as the driver — who else is on approach, who is leaving.' },
  { kind: 'free', text: "This time, prefer the COMMANDER'S presence as the driver, still never addressing them." },
  { kind: 'life', text: 'This time, prefer A SMALL PRIVATE WORRY as the driver — money at home, a message not ' +
    'answered, a promise made to somebody elsewhere.' },
  { kind: 'free', text: 'This time, prefer something INVENTED as the driver — a ship, a person, a cargo of your own making, set against the real backdrop.' },
  { kind: 'life', text: 'This time, prefer the POPULATION as the driver — crowds, or emptiness.' },
  { kind: 'life', text: 'This time, prefer THE VIEW as the driver — the star, the light, what is outside, and how ' +
    'used to it they are.' },
  { kind: 'free', text: 'This time, prefer a RUMOUR about any of it as the driver, stated as hearsay.' },
  { kind: 'free', text: 'This time, prefer MAINTENANCE as the driver — something worn, overdue or jury-rigged.' },
  { kind: 'free', text: 'This time, prefer something somebody SAW as the driver — a ship, a light, debris — told ' +
    'like an eyewitness: one specific detail, uncertain edges.' },
  { kind: 'politics', text: 'This time, prefer an UNDERDOG from the faction board as the driver — one of the small ' +
    'shares, not the front-runner.' },
  // The station's own file on this ship. Measured: the briefing carried "315
  // visits, 325,000 t of food cartridges" and the scene came out as generic
  // pad-queue chatter, because nothing ever pointed at it. Two anchors rather
  // than one keeps the pool at 21 — coprime with the moods (13), leans (11)
  // and moments (25), so one counter still walks the whole cross product.
  { kind: 'life', text: 'This time, prefer THE STATION FILE as the driver — how often this ship has been ' +
    'here, what it always seems to be carrying.' },
  { kind: 'life', text: 'This time, prefer THE LAST TIME as the driver — what happened when this ship was ' +
    'last here, or how long ago that was.' },
];

/**
 * Which kinds of anchor a channel may be handed.
 *
 * Measured, and the reason this exists: giving each channel its own subject
 * matter in the system prompt was not enough on its own, because the anchor
 * lives in the USER message — later, and more specific. Told "you do not
 * discuss faction politics" and then "prefer the FACTION BOARD as the driver",
 * the model obeyed the second. A 24-scene run came out inverted: the crew
 * intercom ran 33% political and the concourse 50%, while the open channel —
 * the one place politics belongs — was the LEAST political at 17%.
 *
 * So the two instructions are reconciled at the source. A channel that does
 * not talk politics is never handed a political anchor, and the conflict
 * cannot arise.
 */
const CHANNEL_ANCHOR_KINDS: Readonly<Record<string, ReadonlyArray<Anchor['kind']>>> = {
  STATION: ['place', 'life', 'free'],
  LOCAL: ['politics', 'place', 'life', 'free'],
  CREW: ['life', 'free'],
  DEEP: ['life', 'free'],
  EMERGENCY: ['place', 'free'],
  CARRIER: ['place', 'life', 'free'],
  CONCOURSE: ['life', 'free'],
};

/**
 * What KIND of moment this is — an axis independent of the situation.
 *
 * The situations in llm.ts say what a scene is ABOUT; this says what shape
 * the exchange takes. The same situation under two energies is two different
 * scenes — "a ship acting strangely on the scanner" played routine-and-
 * efficient is a different night on the radio than the same contact played
 * as somebody withholding part of the story. 25 entries: coprime with the
 * moods (13), leans (11) and anchors (12), so one shared counter walks the
 * whole cross product instead of locking pools together.
 */
const SCENE_ENERGY: readonly string[] = [
  'routine and efficient',
  'mildly irritated',
  'friendly between strangers',
  'two people with history',
  'quietly suspicious',
  'dryly funny',
  'awkward',
  'hurried',
  'tired but competent',
  'someone trying not to panic',
  'someone enjoying this far too much',
  'an authority figure losing patience',
  'an inexperienced person pretending to understand',
  'professionals solving something without drama',
  'a misunderstanding slowly becoming apparent',
  'somebody withholding part of the story',
  'a favour being asked',
  'a favour being repaid',
  'an old grievance surfacing',
  'unexpectedly warm',
  'slightly absurd',
  'a bad situation becoming manageable',
  'a normal situation becoming strange',
  'everyone pretending something is normal',
  'nobody quite sure who is responsible',
];

export const commsRegister = (rotate: number): string =>
  `${pick(COMMS_MOOD, rotate)} ${pick(COMMS_LEAN, rotate)}`;

export const commsAnchorLean = (rotate: number, channel?: string): string => {
  const allowed = (channel && CHANNEL_ANCHOR_KINDS[channel]) || null;
  const pool = allowed ? COMMS_ANCHOR.filter((a) => allowed.includes(a.kind)) : COMMS_ANCHOR;
  return pick(pool.length ? pool : COMMS_ANCHOR, rotate).text;
};

export const sceneEnergy = (rotate: number): string => pick(SCENE_ENERGY, rotate);

// ------------------------------------------------------------------ news

/** The angle a story is written from. 13 entries. */
const NEWS_ANGLE: readonly string[] = [
  'Lead with the detail nobody would put in a press release.',
  'Lead with a number, then undercut it.',
  'Write it as the third time this has happened.',
  'Write it as though the reader already knows the background.',
  'Quote somebody who should not have said that out loud.',
  'Report what changed, then note what conspicuously did not.',
  'Treat the official explanation as the least interesting part.',
  'Write it short. The story does not deserve more than it gets.',
  'Open on the consequence and let the cause trail in late.',
  'Write it from the dockside, not the boardroom.',
  'Note who benefits, without quite accusing anyone.',
  'Let the story be smaller than the headline implies, and own that.',
  'Write it as a correction to what everyone has been saying.',
];

/** A lede rule for the prose itself. 11 entries. */
const NEWS_LEDE: readonly string[] = [
  'First sentence under ten words.',
  'No names in the first sentence.',
  'Open with the time of day it happened.',
  'Open with what somebody was doing when they noticed.',
  'One direct quote, attributed vaguely.',
  'No quotes at all this time.',
  'End on a question the desk cannot answer.',
  'End flat, as if the reporter got bored.',
  'Include one figure and doubt it.',
  'Mention conditions on the docks in passing.',
  'Let the second sentence contradict the mood of the first.',
];

export const newsAngle = (rotate: number): string =>
  `${pick(NEWS_ANGLE, rotate)} ${pick(NEWS_LEDE, rotate)}`;

// -------------------------------------------------------------- operator

/** What the operator leans on this time. Never changes what is true. */
const OPERATOR_ANGLE: readonly string[] = [
  'Lead with the thing that actually matters right now, not the tidiest summary.',
  'Be concrete. One specific beats three generalities.',
  'If there is nothing worth saying, say the small thing and stop.',
  'Assume the commander already knows the basics. Skip to the part they do not.',
  'Say the inconvenient part first.',
  'Keep it to what you would say on a headset, not in a briefing room.',
];

export const operatorAngle = (rotate: number): string => pick(OPERATOR_ANGLE, rotate);

/** For tests: the raw pools, and the guaranteed-distinct cycle lengths. */
export const TONE_POOLS = {
  COMMS_MOOD,
  COMMS_LEAN,
  COMMS_ANCHOR: COMMS_ANCHOR.map((a) => a.text),
  SCENE_ENERGY,
  NEWS_ANGLE,
  NEWS_LEDE,
  OPERATOR_ANGLE,
} as const;

/** Distinct outputs before the composed register repeats: lcm(13, 11). */
export const COMMS_REGISTER_CYCLE = 143;
export const NEWS_ANGLE_CYCLE = 143;
/** Register × energy before the pair recurs: lcm(143, 25). */
export const COMMS_MOMENT_CYCLE = 3575;
