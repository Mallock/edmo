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
