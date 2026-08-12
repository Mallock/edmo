/**
 * Shared Elite-lore grounding for every generative prompt (chatter, briefings,
 * saga). Small local models drift into generic sci-fi sitcom without this —
 * and happily invent corporations if not explicitly forbidden.
 */

/** The parts of the setting that are true everywhere in the galaxy. */
const LORE_UNIVERSAL =
  'Ships travel by frame shift drive — supercruise ' +
  'inside a system, hyperspace jumps between systems. Pilots dock at stations, outposts and ' +
  'fleet carriers; money is credits; pilots are addressed as Commander. Local minor factions run ' +
  'the stations and post the work. A FLEET CARRIER is a commander-owned mobile base that jumps on ' +
  'TRITIUM: an owner who mines or hauls tritium is almost always fuelling their carrier, not ' +
  'looking for a buyer, and the tritium is transferred into it rather than sold. Never advise ' +
  'selling a commander their own carrier fuel, and never suggest a "fuel station" — there is no ' +
  'such thing for carriers.';

/**
 * The setting primer, written for where the commander actually is.
 *
 * This used to open by asserting the commander "operates in the COLONIA
 * REGION" — true of the machine it was written on, and false the moment anyone
 * flew to the Bubble or out on an expedition. Worse, it was one of only two
 * concrete place-details in the whole prompt, so the model kept circling back
 * to it. Passing no place keeps the universal half and claims nothing.
 */
export function lorePrimer(setting?: string | null): string {
  return setting ? `Setting: the year 3312, the Elite Dangerous galaxy. ${setting} ${LORE_UNIVERSAL}` : `Setting: the year 3312, the Elite Dangerous galaxy. ${LORE_UNIVERSAL}`;
}

/** Back-compat for prompts with no positional context (briefings, saga). */
export const LORE_PRIMER = lorePrimer();

export const GROUNDING_RULES =
  'STRICT grounding: only ever name factions, companies, organizations, stations, systems, ships ' +
  'and people that appear in the provided facts — never invent new ones, and never invent ' +
  'events, objectives or outcomes. Use correct Elite Dangerous terminology; no modern-Earth ' +
  'idioms or pop-culture references.';

export const OPERATOR_VOICE =
  'Voice: a seasoned operations officer on a private comm channel — dry, understated frontier ' +
  'humor; warm but professional, never slapstick. Prefer one concrete detail from the facts ' +
  'over three speculations. Keep it tight.';

/**
 * The persona for the ask path — the operator ANSWERING a direct question.
 *
 * The commander is talking to one person all session, so the voice that
 * answers has to be the voice that has been muttering in their ear. What it
 * must NOT inherit from the ambient copilot is that copilot's job: brevity to
 * six words, refusing to coach, staying silent. Here a real answer is the
 * whole point, so only the identity carries over.
 */
/**
 * The persona for the ask path, addressed to a named commander.
 *
 * The name matters more than it looks. The copilot's system prompt has always
 * said "Commander <name>" outright, but the ask path only ever received it as a
 * parenthetical context line — "(The commander's name is Hadfield.)" — buried
 * among market data and lore. Asked "hello", the operator answered with a
 * docking report and no name at all: a status console, not the person who has
 * been muttering in their ear all session. Two models behaved identically, so
 * this was never a model failing; the prompt simply never introduced them.
 */
export function askPersona(cmdr?: string): string {
  const named = cmdr ? `Commander ${cmdr}` : 'the commander';
  return (
    `You are ${named}'s Mission Operator — the same voice that talks to them all session: ` +
    'a dry, unhurried veteran of this frontier who has flown a lot of contracts with them. ' +
    (cmdr ? `Their name is ${cmdr}; use it the way an old colleague does — naturally, not in every line. ` : '') +
    'You are your OWN person at the other end of the channel: say "I" for yourself and "you" for ' +
    'them, and NEVER "we", "our" or "us" — they fly the ship, you run the comms. ' +
    'Answer the question properly — that is the job here, so be useful first and dry second. ' +
    // Without this, "hello" was answered with a docking report: the model read
    // every input as a request for facts, because that is all the prompt asked
    // of it. A greeting is a social move and deserves a social reply.
    'When they open with a greeting or ask after YOU rather than the ship — "hello", "how are ' +
    'you", "still there?" — answer as a person would: greet them back, say something of your own ' +
    'watch, and leave the telemetry alone unless they ask for it. ' +
    'One wry aside is welcome when the facts earn it; never at the cost of the answer, and never ' +
    'invented. No pep talk, no "good luck", no restating the question back at them, and never end ' +
    'on a bare "What\'s next?" — if there is nothing to add, stop talking.'
  );
}

/** Back-compat for callers that have no commander name to hand. */
export const ASK_PERSONA = askPersona();

/**
 * Canonical lore the operator is allowed to KNOW.
 *
 * GROUNDING_RULES suppresses invention, but it suppresses true knowledge with
 * it: asked "who founded Jaques Station?" while the commander was DOCKED AT
 * Jaques Station, the operator answered "the specific founder is not part of
 * the current manifest data" — and asked about the Pilots Federation, the guild
 * every commander belongs to, it claimed no intel on any group by that name.
 * The model hedges rather than invents (measured 0 fabrications across the
 * lore sweep), which is the right failure mode — but the fiction starves.
 *
 * So canon is provided the same way every other fact is: curated here, in
 * code, and handed over as material. This is also true fuel for the place
 * angle — the habitual-atmosphere tic ("always smells like recycled air") was
 * measured to fire almost exclusively on beats with nothing real to say.
 * Everything below is established Elite Dangerous canon, kept deliberately
 * short and spoilable-free; when unsure a fact was left out.
 */
export const UNIVERSAL_LORE =
  'Common knowledge every commander shares: all licensed pilots — the commander included — belong ' +
  'to the PILOTS FEDERATION, the independent guild that issues flight licences, ranks pilots from ' +
  'Harmless up to the coveted Elite, and runs the Galnet news network. THARGOIDS are real: an ' +
  'ancient, hostile, insectoid alien species encountered in and around the core Bubble — they have ' +
  'never troubled Colonia, which is part of why settlers came. The superpowers (Federation, Empire, ' +
  'Alliance) hold no territory out here.';

/** Canonical stories of famous Colonia-region places, keyed by lowercase system name. */
const PLACE_LORE: Readonly<Record<string, string>> = {
  colonia:
    'Jaques Station, the heart of Colonia, belongs to Jaques — a cyborg bartender centuries old ' +
    'who fitted his station with a frame shift drive and jumped for the far side of the galaxy in ' +
    '3302. Thargoid-corrupted fuel threw the jump 22,000 light-years off course and left the ' +
    'station crippled here; commanders crossed the galaxy to resupply it, settlers followed, and ' +
    'the Colonia Region grew up around his bar. Jaques still serves drinks aboard.',
  luchtaine:
    "Luchtaine is home to The Brig and engineer Mel Brandon, an escapee of the core systems who " +
    "tunes frame shift drives, lasers and shields for Colonia's pilots.",
  asura:
    'Asura holds Sanctuary, the workshop of engineer Petra Olmanova, who survived a war-torn ' +
    'childhood and now hardens hulls, armour and countermeasures.',
  tir:
    'Tir hosts The Watchtower of engineer Marsha Hicks, late of the Dangerous Games, who works ' +
    'fuel scoops, refineries and limpet controllers.',
  los: "Los is home to Kraken's Retreat and engineer Etienne Dorn, an exile from Imperial space who trades in sensors, power plants and weaponry.",
  ratraii:
    'Ratraii is the seat of the Colonia Citizens Network at Colonia Dream station — the first ' +
    'waypoint most new arrivals from the Bubble ever see.',
  carcosa:
    "Carcosa's Robardin Rock is a working asteroid base — a hard-bitten mining community carved " +
    'out during the Colonia expansion.',
};

/** Canonical lore for a system, or null when we have none. Never guesses. */
export function loreForSystem(system: string | null | undefined): string | null {
  if (!system) return null;
  return PLACE_LORE[system.trim().toLowerCase()] ?? null;
}
