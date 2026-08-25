/**
 * What the journal's nouns actually MEAN — because the model is not a
 * crystal ball.
 *
 * The journal speaks in proper nouns and code words: "Henry Beacon",
 * "Resource Extraction Site [Hazardous]", a faction "in Expansion". A small
 * model handed a noun it cannot look up either writes around it or invents
 * what it might be — a live session watched two scenes of failure drama
 * about a "beacon relay flickering", and the thing is a parked navigation
 * marker. So the data explains itself: signals carry a note saying what the
 * thing IS, and the states on the faction board get a one-line meaning. The
 * cure for a fixation is an explanation, not a rule — same law as the
 * dossier itself.
 *
 * Shared by every voice — comms dossier, news brief, operator intel — so no
 * voice runs blind and no two voices are told different truths.
 */
import type { SystemSignal } from './types.ts';

/** Ordered: the first matching note wins, so "Tourist Beacon" is a plaque
 *  before "beacon" makes it a nav stop, and a compromised beacon is named
 *  for what is wrong with it. */
const SIGNAL_NOTES: ReadonlyArray<[RegExp, string]> = [
  [/tourist beacon/i, 'a sightseeing plaque for visitors, nothing operational'],
  [/compromised nav beacon/i, 'the navigation stop, currently overrun by pirates hunting arrivals'],
  // Deliberately BORING, and as short as it can be. Every longer wording
  // here made the beacon the most salient entry in the list, and salience is
  // an attractor: two model families independently took the reliable thing
  // and broke it for drama. Dull data draws no plot.
  [/\bbeacon\b/i, 'the routine navigation stop'],
  [/extraction site \[?(hazardous|haz)/i, 'ring mining with no security patrols — miners work it, pirates hunt it'],
  [/extraction site/i, 'a patrolled mining spot in the rings'],
  [/conflict zone|combat zone/i, 'a battlefield of the local war — warships only'],
  [/distress/i, 'someone out there is in trouble'],
  [/megaship/i, 'a working giant on a fixed route'],
  [/installation/i, 'a fixed orbital facility going about its business'],
];

/** Journal SignalType codes, for signals whose NAME says nothing. */
const TYPE_NOTES: Record<string, string> = {
  NavBeacon: 'the routine navigation stop',
  TouristBeacon: 'a sightseeing plaque for visitors, nothing operational',
  ResourceExtraction: 'a patrolled mining spot in the rings',
  Combat: 'a battlefield of the local war — warships only',
};

/** A signal with a note saying what the thing is; unknown kinds stay bare. */
export function describeSignal(x: SystemSignal): string {
  for (const [re, note] of SIGNAL_NOTES) {
    if (re.test(x.name)) return `${x.name} (${note})`;
  }
  const byType = x.type ? TYPE_NOTES[x.type] : undefined;
  return byType ? `${x.name} (${byType})` : x.name;
}

/** BGS states, keyed by the journal's code word normalised (lowercase, no
 *  spaces) so "Civil unrest" and "CivilUnrest" read as one thing. */
const STATE_NOTES: Record<string, string> = {
  expansion: 'pushing into a neighbouring system',
  war: 'a shooting war with a rival over an asset here',
  civilwar: 'a shooting war with a rival faction here',
  boom: 'the economy is surging — trade and hauling pay well',
  bust: 'the economy has slumped',
  election: 'a leadership contest with an allied faction',
  outbreak: 'disease on the stations — medicines in demand',
  famine: 'short of food',
  drought: 'short of water',
  lockdown: 'a security clampdown, station services curtailed',
  civilunrest: 'protests and crime in the streets',
  infrastructurefailure: 'basic services are failing',
  pirateattack: 'under raids by organised pirates',
  publicholiday: 'the stations are on holiday',
  terrorism: 'terror attacks on the stations',
  terroristattack: 'terror attacks on the stations',
  blight: 'crops are failing',
  naturaldisaster: 'digging out from a natural disaster',
  investment: 'money flowing in ahead of growth',
  retreat: 'losing its footing in this system',
  civilliberty: 'good order and good times — crime is down',
};

/**
 * One line explaining the states actually present, or null when none need
 * it. Capped — a board in five states gets the first four; the point is
 * grounding, not an almanac.
 */
export function stateGlossary(states: Iterable<string | undefined>): string | null {
  const seen = new Set<string>();
  const bits: string[] = [];
  for (const raw of states) {
    const label = raw?.trim();
    if (!label || label === 'None') continue;
    const key = label.toLowerCase().replace(/[\s_-]/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const note = STATE_NOTES[key];
    if (!note) continue;
    bits.push(`${label} = ${note}`);
    if (bits.length >= 4) break;
  }
  return bits.length ? `(state meanings: ${bits.join('; ')})` : null;
}
