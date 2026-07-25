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
