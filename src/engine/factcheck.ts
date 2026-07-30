/**
 * A scoped guard against the one small-model failure that breaks trust:
 * naming a PLACE that doesn't exist. Not general NER — just place-suffix names
 * (station/dock/hub/…) checked against the set the copilot was actually given.
 * High precision on purpose: a false positive silences a good beat, so we would
 * rather miss a fabrication than gag the operator. The store resamples once on a
 * hit, then falls back to NO_BEAT.
 */

// A proper-looking place name: a Title-Case head (1–4 words) + a place suffix.
const PLACE_RE =
  /\b([A-Z][A-Za-z0-9''-]*(?:\s+[A-Z0-9][A-Za-z0-9''-]*){0,3})\s+(Station|Dock|Hub|Terminal|Port|Orbital|Enterprise|Market|Installation|Depot|Base|Outpost|City|Quarry|Mines|Habitat|Holdings|Refinery|Gateway|Ring|Beacon|Settlement|Colony|Reach|Landing|Vision|Prospect)\b/g;

const norm = (s: string): string => s.toLowerCase().replace(/[''`]/g, "'").replace(/\s+/g, ' ').trim();

/** Every place-suffix name mentioned in a chunk of text (e.g. a journal event
 *  line, or a generated beat), returned verbatim. */
export function extractPlaces(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(PLACE_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(`${m[1]} ${m[2]}`);
  return out;
}

/**
 * The first place named in `beat` that is NOT among the allowed places (matched
 * loosely, either direction, so "Marigold City" ⊇ "marigold" passes), or null
 * when the beat invents no place. `allowed` should be built generously — the
 * current location, mission destinations, the plotted route, in-system stations,
 * and everything the copilot was already told about this session.
 */
export function findFabricatedPlace(beat: string, allowed: Iterable<string>): string | null {
  const hay = [...allowed].map(norm).filter(Boolean);
  for (const place of extractPlaces(beat)) {
    const c = norm(place);
    if (!hay.some((a) => a.includes(c) || c.includes(a))) return place;
  }
  return null;
}

/**
 * Collective pronouns — the copilot's oldest bad habit.
 *
 * "We're docked", "let's get moving", "keep us moving" turn a person on the
 * other end of the channel into a disembodied narrator of shared state. The
 * operator watches and advises; the commander flies. The prompt bans this, but
 * a small local model backslides under pressure, so gate it mechanically too.
 *
 * Deliberately NOT matched: "we" inside quoted speech from someone else, and
 * possessives about a third party ("their haul"). Only the operator claiming to
 * share the cockpit is wrong.
 */
const COLLECTIVE =
  // Contractions must carry the apostrophe: an optional one makes "we'?ll"
  // match "well" and "we'?d" match "wed", which drops perfectly good beats.
  // Longest alternatives first so "we're" is reported whole, not as "we".
  /(?:^|[^\p{L}])(we['’](?:re|ve|ll|d|s)|let['’]s|ourselves|ours|our|we|us)(?![\p{L}'’])/iu;

/** The offending pronoun, or null when the beat speaks in its own voice. */
export function findCollectivePronoun(beat: string): string | null {
  const m = COLLECTIVE.exec(beat);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Phrases that appear inside the operator's own instructions as examples.
 *
 * Small models parrot them. Observed live: told "a wry impression of a place is
 * welcome (“big berth for a big crowd, this one”)", gemma-4-e4b served that exact
 * line back twice in eight beats — at an OUTPOST, the smallest berth there is,
 * so the borrowed words were also wrong. The instructions say not to lift
 * example phrasing; this enforces it, the way the fact fence enforces grounding.
 *
 * Only distinctive multi-word fragments belong here: matching on short common
 * phrasing would gag ordinary speech.
 */
const LIFTED_EXAMPLES = [
  'big berth for a big crowd',
  'quiet little outpost',
  'gravity well',
  'chewed ships since',
  'the docks here are unforgiving',
  'smells of synth-coffee',
  'the starfield means',
  'best haul yet',
  'home in one piece',
  'carrier will thank',
];

const flatten = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The lifted phrase, or null when the beat is in the model's own words. */
export function findLiftedExample(beat: string): string | null {
  const flat = flatten(beat);
  // Normalise the needles too: "synth-coffee" flattens to "synth coffee", so an
  // un-normalised needle would never match its own example.
  for (const ex of LIFTED_EXAMPLES) if (flat.includes(flatten(ex))) return ex;
  return null;
}

/**
 * A habitual claim — "X always …", "Y never …" — which the operator cannot
 * possibly know and which the prompt already bans twice ("Skip empty
 * generalities", "never invent … sensory claims you cannot have").
 *
 * It bans them and the model does it anyway, in the shape of the very example
 * it is warned off: told not to say "pad seven smells of synth-coffee", it
 * produced "Jaques Station always smells like recycled air", "Paxton Landing
 * always has a decent flow to it" and "Pad seven always gets the traffic,
 * doesn't it". Three of three glance beats at one station opened this way.
 *
 * The tell is what it correlates with. Across a session where the beat context
 * carried real material — ship, client, system economy, memory — this fired on
 * 0 of 16 lines. Where the context was thin it fired on most of them. It is the
 * sound of a model with nothing true to say reaching for atmosphere, so
 * catching it is really catching an empty beat, and dropping it is right.
 *
 * Returns the offending phrase, or null.
 */
export function findHabitualGenerality(beat: string): string | null {
  // "always"/"never" as a claim about how something habitually IS. A few words
  // of slack covers "always seems to", "never really", "always a good spot".
  const m = beat.match(
    /\b(?:it|that|this|there|[A-Z][\w'’-]*(?:\s+[A-Z][\w'’-]*){0,3}|\bpad\s+\w+)\s+(?:is\s+|are\s+|has\s+|have\s+)?\b(always|never)\b(?:\s+\w+){0,3}/i,
  );
  if (m) return m[0].trim();
  // Clause-initial "Always a good spot…" — the same claim with the subject
  // dropped, or smuggled in after a comma ("…a bartender's jump in 3302,
  // always smells faintly of old synth-whiskey"), which a live run produced
  // the moment the subject pattern above stopped matching.
  const lead = beat.match(/(?:^|[.!?,;—-]\s*)(always|never)\b(?:\s+\w+){0,3}/i);
  return lead ? lead[0].replace(/^[.!?,;—-]\s*/, '').trim() : null;
}
