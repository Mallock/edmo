/**
 * Flavor generator — the operator's off-duty voice. Invents SHORT fictional
 * stories (rumors, backstories, station gossip) about the commander's active
 * missions and how they connect. Pure fiction layered over real mission facts;
 * deliberately separate from guidance so it can never pollute accuracy.
 *
 * Two layers, same philosophy as the rest of the engine:
 *  - buildFlavorChat(): prompt for the local LLM (creative temperature).
 *  - ruleBasedFlavor(): seeded template generator, works fully offline.
 */
import type { ChatMessage } from './lmstudio.ts';
import type { Mission, OperatorState } from './types.ts';
import { describeSystemIntel, formatCredits } from './operator.ts';
import { GROUNDING_RULES, LORE_PRIMER, OPERATOR_VOICE } from './lore.ts';

/** Deterministic PRNG (mulberry32) so stories are testable and seedable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SINGLE_ANGLES = [
  "the target's past and why they went rogue",
  'what dock workers whisper about this job',
  "the mission giver's hidden motive",
  'a rumor the locals tell about this contract',
  'a previous commander who took this job and never reported back',
  'why the pay is suspiciously good',
  'what the cargo manifest does not say',
];

const PASSENGER_ANGLES = [
  'what one of the passengers said in the galley last night',
  'why these passengers are really making this trip',
  'the life one of the passengers left behind',
  "what the passengers think of the commander's flying",
  'the strange thing one passenger insisted on bringing aboard',
];

const PLACE_ANGLES = [
  'what kind of place the destination really is, once you get past the brochure',
  "the destination system's reputation among haulers",
  'a story the dockhands tell about the destination station',
];

const COMBO_ANGLES = [
  'how these contracts secretly connect',
  'the bigger scheme behind all these jobs',
  'why so many contracts point at the same corner of space',
  'which of these employers is lying',
];

export interface StoryPlan {
  subjects: Mission[];
  angle: string;
}

const pick = <T,>(arr: readonly T[], rng: () => number): T =>
  arr[Math.floor(rng() * arr.length) % arr.length];

/** Angle pool for a single mission — passengers and places get their own stories. */
function anglesFor(m: Mission, rng: () => number): readonly string[] {
  if (m.passengers && rng() < 0.6) return PASSENGER_ANGLES;
  if (m.destination && rng() < 0.35) return PLACE_ANGLES;
  return SINGLE_ANGLES;
}

/** Choose story subjects (one mission, or a combination) and an angle. */
export function planStory(
  missions: Mission[],
  rng: () => number,
  focus?: Mission,
): StoryPlan | null {
  if (!missions.length) return null;
  if (focus) return { subjects: [focus], angle: pick(anglesFor(focus, rng), rng) };
  if (missions.length >= 2 && rng() < 0.45) {
    const shuffled = [...missions].sort(() => rng() - 0.5);
    return { subjects: shuffled.slice(0, 3), angle: pick(COMBO_ANGLES, rng) };
  }
  const m = pick(missions, rng);
  return { subjects: [m], angle: pick(anglesFor(m, rng), rng) };
}

function factLine(m: Mission): string {
  const bits = [`${m.category}: "${m.title}"`];
  if (m.target) bits.push(`target ${m.target.name} (${m.target.type})`);
  if (m.faction) bits.push(`for ${m.faction}`);
  if (m.targetFaction) bits.push(`against ${m.targetFaction}`);
  if (m.commodity) bits.push(`${m.commodity.count}t of ${m.commodity.localised}`);
  if (m.passengers) bits.push(`${m.passengers.count} ${m.passengers.type} passengers`);
  if (m.destination)
    bits.push(
      `to ${m.destination.station ? `${m.destination.station}, ` : ''}${m.destination.system}`,
    );
  bits.push(`pays ${formatCredits(m.reward)}`);
  return `- ${bits.join('; ')}`;
}

/** Prompt for the LLM story path (use a high temperature, ~0.9).
 *  `seeds` are TRUE recent happenings (completions, BGS shifts, comms) the
 *  story may weave in — grounded callbacks land better than pure invention. */
export function buildFlavorChat(
  plan: StoryPlan,
  state: OperatorState,
  seeds: string[] = [],
  avoid?: string,
  comms: string[] = [],
): ChatMessage[] {
  const facts = plan.subjects.map(factLine).join('\n');
  const avoidBlock = avoid
    ? `\nYour previous story was: "${avoid.slice(0, 240)}" — tell something DIFFERENT: new topic, new angle, no repeated themes.\n`
    : '';
  const commsBlock = comms.length
    ? `\nOverheard on local comms recently (all real transmissions):\n${comms
        .slice(-4)
        .map((c) => `- ${c}`)
        .join('\n')}\n`
    : '';
  const seedBlock = seeds.length
    ? `\nRecent true events (you may reference at most one, as a callback):\n${seeds
        .slice(-6)
        .map((s) => `- ${s}`)
        .join('\n')}\n`
    : '';
  const intel = describeSystemIntel(state);
  return [
    {
      role: 'system',
      content:
        "You are the ship's Mission Operator on a private comm channel with your commander" +
        `${state.cmdr ? ` (Commander ${state.cmdr})` : ''}. ${LORE_PRIMER} ${OPERATOR_VOICE} ` +
        'Tell one short piece of scuttlebutt from the angle given — about the passengers aboard, ' +
        'a place on the route, or the job itself. Two to three spoken sentences, first person, ' +
        'addressed to the commander. If ONE recent true event connects naturally to the current ' +
        'job — cause and effect, or quiet irony, like hauling refugees right after clearing out ' +
        'the pirates who displaced them — build on that connection briefly. You may also weave ' +
        'in at most one overheard comm transmission as background texture. ' +
        `${GROUNDING_RULES} Never give instructions or advice, and never contradict the facts. ` +
        'No markdown, no preamble — just talk.',
    },
    {
      role: 'user',
      content:
        `Fact sheet:\n${facts}\n` +
        `Commander is currently at ${state.location.station ? `${state.location.station}, ` : ''}${state.location.system}.\n` +
        (intel ? `${intel}\n` : '') +
        seedBlock +
        commsBlock +
        avoidBlock +
        `Angle: ${plan.angle}.\nTell the story now.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Offline template generator
// ---------------------------------------------------------------------------

type Tmpl = (m: Mission, state: OperatorState, rng: () => number) => string;

const who = (m: Mission): string => m.target?.name ?? m.targetFaction ?? 'the target';
const giver = (m: Mission): string => m.faction ?? 'your employer';
const destSys = (m: Mission): string => m.destination?.system ?? 'that system';
const cargoName = (m: Mission): string => m.commodity?.localised ?? 'that cargo';

const KILL_TMPLS: Tmpl[] = [
  (m) =>
    `Word on the docks is ${who(m)} used to fly escort for ${giver(m)} before things went sour. Nobody walks away from ${giver(m)} and keeps their transponder clean.`,
  (m) =>
    `They say ${who(m)} has a bounty ledger longer than a Lakon manifest, and half of ${destSys(m)} has stopped asking questions. ${giver(m)} just happens to pay the loudest.`,
  (m) =>
    `A miner in the lounge swears ${who(m)} jumped a fuel convoy at the edge of ${destSys(m)} last month. That is why this one pays ${formatCredits(m.reward)} — it is personal now.`,
];

const HAUL_TMPLS: Tmpl[] = [
  (m) =>
    `Third shipment of ${cargoName(m)} through this lane this month, commander. ${giver(m)} is stockpiling for something they are not announcing.`,
  (m) =>
    `The dockhand who sealed those crates of ${cargoName(m)} would not look me in the eye. Manifest says routine — the escort fee says otherwise.`,
  (m) =>
    `They whisper ${giver(m)} lost the last courier on this route to an interdiction that was never logged. The pay went up. Draw your own conclusions.`,
];

const PAX_TMPLS: Tmpl[] = [
  (m) =>
    `${m.passengers?.count ?? 'Your'} souls in the cabins, every one with a reason to leave in a hurry. In my experience, commander, nobody pays ${formatCredits(m.reward)} for scenery.`,
  (m) =>
    `One of your passengers booked this route three times and cancelled twice. Whatever finally made them board tonight, it was not wanderlust.`,
  (m) =>
    `Cabin report, commander: your ${m.passengers?.type ?? 'passengers'} go quiet every time the frame shift spools up. Twenty-two thousand light-years from the Bubble, everyone still counts the jumps.`,
  (m) =>
    `One of the ${m.passengers?.type ?? 'passengers'} asked the service drone whether ${destSys(m)} has a proper med bay. Out here that is not an idle question, commander.`,
];

const GENERIC_TMPLS: Tmpl[] = [
  (m, s) =>
    `Every contract in ${s.location.system} has two stories: the one on the board and the one that gets you paid. "${m.title}" smells like it has three.`,
  (m) =>
    `Old spacers say never trust a job from ${giver(m)} that pays ${formatCredits(m.reward)} without a footnote. I checked, commander — there is no footnote.`,
  (m) =>
    `${destSys(m)} is a long way from anyone's navy, commander. Out here the only law that answers a distress call is the one you bring with you.`,
  (m) =>
    `The board in ${destSys(m)} lists work by tonnage or by blood. Whatever the slip says, "${m.title}" pays like the second kind.`,
];

const COMBO_TMPLS: ((a: Mission, b: Mission, s: OperatorState) => string)[] = [
  (a, b) =>
    `Funny thing, commander — "${a.title}" and "${b.title}" both trace back to the same corner of space. Coincidence does not usually pay this well.`,
  (a, b) =>
    `The clerk who posted "${a.title}" was seen drinking with the one behind "${b.title}". Two contracts, one tab. Make of that what you will.`,
  (a, b, s) =>
    `Word in ${s.location.system} is that these jobs are one cleanup wearing different badges — "${a.title}" opens the door and "${b.title}" sweeps the floor.`,
];

function templFor(m: Mission): Tmpl[] {
  switch (m.category) {
    case 'Assassinate':
    case 'Massacre':
      return [...KILL_TMPLS, ...GENERIC_TMPLS];
    case 'Delivery':
    case 'DeliveryWing':
    case 'Courier':
    case 'Collect':
    case 'Salvage':
    case 'Mining':
      return [...HAUL_TMPLS, ...GENERIC_TMPLS];
    case 'PassengerBulk':
    case 'PassengerVIP':
    case 'Sightseeing':
    case 'LongDistanceExpedition':
      return [...PAX_TMPLS, ...GENERIC_TMPLS];
    default:
      return GENERIC_TMPLS;
  }
}

/** Offline story — always returns something for at least one active mission. */
export function ruleBasedFlavor(
  missions: Mission[],
  state: OperatorState,
  rng: () => number,
  focus?: Mission,
): string | null {
  if (!missions.length) return null;
  if (!focus && missions.length >= 2 && rng() < 0.45) {
    const shuffled = [...missions].sort(() => rng() - 0.5);
    return pick(COMBO_TMPLS, rng)(shuffled[0], shuffled[1], state);
  }
  const m = focus ?? pick(missions, rng);
  return pick(templFor(m), rng)(m, state, rng);
}

// ---------------------------------------------------------------------------
// Afterglow — stories between contracts (mission board empty, seeds available)
// ---------------------------------------------------------------------------

const AFTERGLOW_ANGLES = [
  'the aftermath of the recent work',
  "how the commander's reputation travels ahead of the ship",
  'what dock workers now whisper when this ship requests clearance',
  'who might come looking for the commander next',
];

const MINING_ANGLES = [
  'prospector superstitions and whether they actually work',
  'what the refinery hum does to a mind on a long shift',
  'the ring itself — how old it is and what else might be hiding in these rocks',
  'miners who struck it rich out here, and what happened to them afterwards',
  'the strange beauty of cracking rocks nobody has ever touched',
];

/** LLM prompt when no contracts are active — talks about what the commander
 *  is DOING right now (e.g. mining) when known, recent deeds otherwise. */
export function buildAfterglowChat(
  seeds: string[],
  state: OperatorState,
  rng: () => number,
  opts: { activity?: string | null; avoid?: string; comms?: string[] } = {},
): ChatMessage[] {
  const mining = !!opts.activity && /mining/i.test(opts.activity);
  const angle = pick(mining ? MINING_ANGLES : AFTERGLOW_ANGLES, rng);
  const avoid = opts.avoid
    ? `\nYour previous story was: "${opts.avoid.slice(0, 240)}" — tell something DIFFERENT: new topic, new angle, no repeated themes.`
    : '';
  return [
    {
      role: 'system',
      content:
        "You are the ship's Mission Operator during downtime between contracts" +
        `${state.cmdr ? `, on a private comm channel with Commander ${state.cmdr}` : ''}. ` +
        `${LORE_PRIMER} ${OPERATOR_VOICE} ` +
        (mining
          ? 'The commander is out mining for themselves right now — talk about THAT: the rocks, ' +
            'the haul, the rhythm of the work, ring lore. Recent deeds are background at most. '
          : 'Share one short piece of scuttlebutt that grows out of the true recent events ' +
            'listed — how the word travels, what the locals make of it, who noticed. ') +
        'Two to three spoken sentences, first person, addressed to the commander. ' +
        `${GROUNDING_RULES} Never give instructions or advice, and never contradict the listed ` +
        'facts. No markdown, no preamble — just talk.',
    },
    {
      role: 'user',
      content:
        `No active contracts. Commander is at ${state.location.station ? `${state.location.station}, ` : ''}${state.location.system}.\n` +
        (opts.activity ? `Current activity: ${opts.activity}.\n` : '') +
        `Recent true events:\n${seeds.slice(-6).map((s) => `- ${s}`).join('\n')}\n` +
        (opts.comms?.length
          ? `Overheard on local comms (real): ${opts.comms.slice(-3).join(' · ')}\n`
          : '') +
        avoid +
        `\nAngle: ${angle}.\nTell the story now.`,
    },
  ];
}

/** Offline afterglow line. */
export function afterglowFlavor(
  state: OperatorState,
  rng: () => number,
  activity?: string | null,
): string {
  const sys = state.location.system;
  if (activity && /mining/i.test(activity)) {
    const mine = [
      `Nothing on the board, so it's just us and the rocks, commander. ${activity}. The old prospectors say every ring keeps one motherlode for the patient — I choose to believe them.`,
      `Refinery's humming, hold is filling. ${activity}. Honest work, commander — nobody shoots at gravel.`,
      `I ran the numbers on the haul so far — ${activity}. At this rate the dock crews will start calling us "the quarry".`,
    ];
    return pick(mine, rng);
  }
  const tmpls = [
    `Quiet board tonight, commander. Word of your last jobs is still making the rounds in ${sys} — enjoy the silence while it lasts.`,
    `No contracts on the wire. The dock crews in ${sys} have started telling your stories for you, and they are only half wrong.`,
    `Board's empty. In my experience that means someone important is deciding how much your next job is worth.`,
  ];
  return pick(tmpls, rng);
}
