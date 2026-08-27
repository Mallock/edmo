/**
 * The briefing handed to the comms writer — what is actually in this system.
 *
 * This replaced a flat list of licensed nouns and figures, and the difference is
 * the point of the whole tier. That list was a fence: the model was forbidden to
 * name anything outside it and a verifier discarded whole scenes that did. It
 * produced timid dialogue that read facts aloud like labels, because a bare list
 * of strings gives a model nothing to write ABOUT — only things it is permitted
 * to mention.
 *
 * This is background instead. A faction sitting on 42% and expanding, a hazardous
 * extraction site, a station 900 ls out, a low security rating — those are
 * situations people have opinions about, and a model handed situations writes
 * dialogue. Invention on top is explicitly allowed; the dossier is what makes the
 * invention belong to THIS system rather than to any system.
 *
 * Pure, and separate from the store, so the shape of the briefing can be tested
 * without booting a HUD.
 */
import { isFleetCarrier } from '../operator.ts';
import { rotateWindow } from '../rotate.ts';
import { describeSignal, stateGlossary } from '../gloss.ts';
import type { SystemIntel } from '../types.ts';

/** Lines cap. The prompt shares an output budget with a rolling transcript. */
const MAX_LINES = 14;

export interface DossierInput {
  system: string;
  intel?: SystemIntel;
  docked: boolean;
  stationName?: string | null;
  onFoot?: boolean;
  supercruise?: boolean;
  /** Distance to the nearest port, when the commander is not sitting on one. */
  portSeparationLs?: number | null;
  /** Overrides the generic commander-state line with WHERE they really are —
   *  "on approach to Gcobani's Medicines, a planetary construction site". */
  place?: string;
  /** Scanned worlds for the "out the window" line — see WorldFact. */
  worlds?: readonly WorldFact[];
  /** Summaries from the fact briefs — construction depots, markets, events. */
  extra?: readonly string[];
  /**
   * The last few ACCEPTED scenes, as plain text, for the noun-cooling pass.
   *
   * Rotation alone could not stop a 40-scene audit putting one station in
   * half the air: every scene that names a place enters the writer's rolling
   * transcript, the transcript teaches the next scene, and the token
   * snowballs — 21% over the first fourteen scenes, 65% over the rest. The
   * brake is on the DATA side: a place named in 3 of the last 6 scenes drops
   * out of the briefing until the air clears. The model may still echo its
   * history, but the prompt stops seconding the motion.
   */
  recentAir?: readonly string[];
  /**
   * Which slice of each capped list to show, so the briefing is not identical
   * on every call.
   *
   * A system with six factions used to show the same four for ever, and the
   * writer saw byte-identical input every time it wrote for that system — which
   * is the one condition under which temperature buys nothing. The caller hands
   * over a counter; see rotate.ts.
   */
  rotate?: number;
}

const plus = (more: number): string => (more ? ` (+${more} more)` : '');

const pct = (influence: number): string => `${(influence * 100).toFixed(1)}%`;

/** A name is "on the air" in a text if any listener-recognisable form of it
 *  appears: the full name, its first word, or its last word — the clip forms
 *  the name-shrinking rule deliberately produces ("the Gateway"). */
const escRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GENERIC_WORD =
  /^(the|new|old|los|las|san|port|nav|deep|point|site|zone|city|base|camp|ring|star|world|beacon)$/i;

function airPattern(name: string): RegExp {
  const words = name.split(/\s+/);
  const alts = [escRe(name)];
  const first = words[0];
  if (words.length > 1 && first.length >= 4 && !GENERIC_WORD.test(first)) alts.push(escRe(first));
  const last = words[words.length - 1];
  if (words.length > 1 && last.length >= 4 && !GENERIC_WORD.test(last) && last !== first) {
    alts.push(escRe(last));
  }
  return new RegExp(`\\b(?:${alts.join('|')})\\b`, 'i');
}

/** Does a listener-recognisable form of `name` appear in `text`? */
export const airedIn = (text: string, name: string): boolean => airPattern(name).test(text);

/**
 * A scanned world, reduced to what a person on the radio would notice.
 *
 * The orrery holds every scanned body's class, gravity, temperature,
 * volcanism, rings and whether anyone has ever stood on it — and none of it
 * reached a single prompt. An icy moon at 0.08 G is better small talk than
 * any influence figure; this is the composer that turns the scan data into
 * briefing lines, rotated so a different pair of worlds is out the window
 * each scene.
 */
export interface WorldFact {
  /** The body's short label — "5 a", "A 2". */
  label: string;
  /** Journal PlanetClass — "Icy body", "High metal content body", "Gas giant…". */
  planetClass?: string;
  moon?: boolean;
  landable?: boolean;
  ringed?: boolean;
  gravityG?: number;
  tempK?: number;
  volcanism?: string;
  tidalLock?: boolean;
  terraformable?: boolean;
  /** Landable and never footfalled — nobody has ever stood there. */
  virgin?: boolean;
}

/** "Icy body" → "an icy world" / "an icy moon"; giants keep their grandeur. */
function classPhrase(f: WorldFact): string {
  const c = (f.planetClass ?? '').toLowerCase();
  const noun = f.moon ? 'moon' : 'world';
  if (c.includes('gas giant')) return f.ringed ? 'a ringed gas giant' : 'a gas giant';
  if (c.includes('icy')) return `an icy ${noun}`;
  if (c.includes('water world')) return 'a water world';
  if (c.includes('ammonia')) return `an ammonia ${noun}`;
  if (c.includes('earth')) return 'an Earth-like world';
  if (c.includes('metal rich')) return `a metal-rich ${noun}`;
  if (c.includes('high metal')) return `a high-metal ${noun}`;
  if (c.includes('rocky ice')) return `a rock-and-ice ${noun}`;
  if (c.includes('rocky')) return `a rocky ${noun}`;
  return `a ${noun}`;
}

/** One line per world, at most `cap`, rotated. Every clause is a scan fact. */
export function worldNotes(worlds: readonly WorldFact[], rotate = 0, cap = 2): string[] {
  const notes = worlds
    .filter((f) => f.planetClass)
    .map((f) => {
      const bits: string[] = [];
      if (f.gravityG != null && f.gravityG > 0) bits.push(`${f.gravityG.toFixed(2)} G`);
      if (f.volcanism) {
        const v = f.volcanism.replace(/\s*volcanism\s*$/i, '').replace(/^minor\s+|^major\s+/i, '');
        if (v) bits.push(v.trim());
      }
      if (f.tidalLock) bits.push('one face forever to its star');
      if (f.terraformable) bits.push('terraformable');
      if (f.tempK != null && (f.tempK < 120 || f.tempK > 700)) bits.push(`${Math.round(f.tempK)} K`);
      if (f.virgin) bits.push('nobody has ever set foot there');
      const tail = bits.slice(0, 2).join(', ');
      return `${f.label} — ${classPhrase(f)}${tail ? `, ${tail}` : ''}`;
    });
  return rotateWindow(notes, cap, rotate).shown;
}

/** Names hot enough to sit the next briefing out: aired in 3+ of the recent
 *  scene texts. Exported for the accept-time gate, the audit harness and the
 *  tests. */
export function hotNouns(recentAir: readonly string[], names: readonly string[]): Set<string> {
  const hot = new Set<string>();
  if (recentAir.length < 3) return hot;
  for (const name of names) {
    const re = airPattern(name);
    let hits = 0;
    for (const text of recentAir) if (re.test(text)) hits++;
    if (hits >= 3) hot.add(name);
  }
  return hot;
}

export function buildDossier(input: DossierInput): string {
  const s = input.intel;
  const lines: string[] = [];
  const rot = input.rotate ?? 0;
  const trim = <T>(xs: readonly T[], cap: number): { shown: T[]; more: number } =>
    rotateWindow(xs, cap, rot);

  // Who and what this place is.
  const props: string[] = [];
  if (s?.security) props.push(`${s.security.replace(/\s*security$/i, '')} security`);
  if (s?.allegiance) props.push(s.allegiance);
  if (s?.government) props.push(s.government);
  if (s?.economy) props.push(`${s.economy} economy`);
  if (typeof s?.population === 'number' && s.population > 0) {
    props.push(`population ${s.population.toLocaleString('en-US')}`);
  }
  lines.push(`System: ${input.system}${props.length ? ` — ${props.join(', ')}` : ''}`);

  // The cooling set covers BOTH kinds of proper noun. It started as signals
  // only, and a live session promptly proved the gap: with every station
  // brake working, one FACTION still rode nearly every scene, because faction
  // names could neither cool nor gate.
  const hot = hotNouns(input.recentAir ?? [], [
    ...(s?.signals ?? []).map((x) => x.name),
    ...(s?.factions ?? []).map((f) => f.name),
    ...(s?.controllingFaction ? [s.controllingFaction] : []),
  ]);
  const cool = (names: string[]): string[] => {
    const kept = names.filter((n) => !hot.has(n));
    return kept.length ? kept : names;
  };

  // Factions ride SOME scenes, not all. The board sat in every prompt and its
  // biggest name sat in every scene — a briefing line present every time is an
  // instruction to use it. Phase by the rotation: one scene in three carries
  // the full politics, one carries only the board's tail, and one carries NO
  // faction lines at all, so the anchors fall back to stations, signals,
  // moods-of-place and the commander, and the air stops being a bulletin.
  const factionPhase = rot % 3;

  if (factionPhase === 0 && s?.controllingFaction && !hot.has(s.controllingFaction)) {
    const ruling = s.factions?.find((f) => f.name === s.controllingFaction);
    lines.push(`Runs this system: ${s.controllingFaction}${ruling ? ` (${pct(ruling.influence)})` : ''}`);
  }

  // The influence board, minus whoever already appeared as the controller,
  // minus anyone the air is already saturated with. A faction's government
  // rides along — Anarchy, Corporate, Theocracy is an AGENDA.
  const boardSource = (s?.factions ?? [])
    .filter((f) => f.name !== s?.controllingFaction)
    .filter((f) => !hot.has(f.name))
    .slice()
    .sort((a, b) => b.influence - a.influence);
  const others = boardSource.map((f) => {
    const bits = [pct(f.influence)];
    if (f.state && f.state !== 'None') bits.push(f.state);
    if (f.government) bits.push(f.government);
    return `${f.name} (${bits.join(', ')})`;
  });
  if (others.length && factionPhase !== 2) {
    const { shown, more } = trim(others, factionPhase === 0 ? 4 : 2);
    lines.push(`Also here: ${shown.join(' · ')}${plus(more)}`);
  }

  // Faction states carry the mood even when the full board is unknown.
  if (factionPhase !== 2 && !s?.factions?.length && s?.factionStates?.length) {
    const { shown, more } = trim(s.factionStates.map((f) => `${f.name} (${f.state})`), 4);
    lines.push(`Going on locally: ${shown.join(' · ')}${plus(more)}`);
  }

  // What those state words MEAN — the journal's code for "Expansion" or
  // "Lockdown" explains nothing by itself, and a model that does not know
  // writes around it or invents (gloss.ts).
  if (factionPhase !== 2) {
    const glossary = stateGlossary([
      ...(s?.factions ?? []).flatMap((f) => [f.state, ...(f.pending ?? []), ...(f.recovering ?? [])]),
      ...(s?.factionStates ?? []).map((f) => f.state),
    ]);
    if (glossary) lines.push(glossary);
  }

  // Mood on the ground. The journal reports every faction's happiness and the
  // briefing dropped it on the floor — and a despondent populace is worth
  // more to a radio scene than any influence figure. Rotated pair.
  const moods = (s?.factions ?? [])
    .filter((f) => f.happiness && !hot.has(f.name))
    .map((f) => `${f.name}'s people are ${f.happiness!.toLowerCase()}`);
  if (moods.length && factionPhase !== 2) {
    const { shown } = trim(moods, 2);
    lines.push(`Mood on the ground: ${shown.join(' · ')}`);
  }

  // The town's forward gossip: states that have not LANDED yet, and ones just
  // climbed out of — also captured all along, also never briefed. What is
  // about to happen is better conversation than what already did.
  const turning: string[] = [];
  for (const f of s?.factions ?? []) {
    if (hot.has(f.name)) continue;
    for (const p of f.pending ?? []) turning.push(`${f.name} is heading into ${p}`);
    for (const r of f.recovering ?? []) turning.push(`${f.name} is just out of ${r}`);
  }
  if (turning.length && factionPhase !== 2) {
    const { shown } = trim(turning, 2);
    lines.push(`Coming and going: ${shown.join(' · ')}`);
  }

  // Places. Carriers are COUNTED, never named — a hub system carries a dozen
  // XXX-XXX registrations and they crowd out the names that mean something.
  // And a place that has RIDDEN the air lately sits this briefing out (see
  // recentAir above) — unless cooling would empty the list, because a
  // briefing with no places at all is worse than a warm one.
  const stationSignals = (s?.signals ?? []).filter((x) => x.isStation);
  const stations = cool(stationSignals.filter((x) => !isFleetCarrier(x)).map((x) => x.name));
  const carriers = stationSignals.filter(isFleetCarrier).length;
  if (stations.length) {
    const { shown, more } = trim([...new Set(stations)], 5);
    lines.push(`Stations: ${shown.join(' · ')}${plus(more)}`);
  }
  if (carriers) lines.push(`Fleet carriers parked here: ${carriers}`);

  // Plain nav beacons are left OUT — same law as carriers being counted, not
  // named. A beacon is scenery in every system, worth nothing to a scene, and
  // two model families independently kept electing it as the thing that must
  // malfunction. It stays in the news and operator intel, where it is a fact
  // rather than a prop. Compromised and tourist beacons are situations and stay.
  const isPlainBeacon = (x: { name: string; type?: string }): boolean =>
    (x.type === 'NavBeacon' || /\bbeacon\b/i.test(x.name)) && !/compromised|tourist/i.test(x.name);
  const siteSignals = (s?.signals ?? []).filter((x) => !x.isStation && !isPlainBeacon(x));
  const keptSites = new Set(cool(siteSignals.map((x) => x.name)));
  const sites = siteSignals.filter((x) => keptSites.has(x.name)).map(describeSignal);
  if (sites.length) {
    const { shown, more } = trim([...new Set(sites)], 6);
    lines.push(`Signals detected: ${shown.join(' · ')}${plus(more)}`);
  }

  // What is OUT THE WINDOW — the scanned worlds themselves, rotated two at a
  // time. Scenery is the one kind of material that cannot start a faction
  // bulletin, and an icy moon nobody has ever stood on is conversation.
  const worlds = worldNotes(input.worlds ?? [], rot);
  if (worlds.length) lines.push(`Out the window: ${worlds.join(' · ')}`);

  // How far out things are — the most complained-about fact in the game.
  const sep = input.portSeparationLs;
  if (!input.docked && typeof sep === 'number' && sep > 0) {
    lines.push(`Nearest port: ${Math.round(sep).toLocaleString('en-US')} ls out`);
  }

  // Where the commander is, so the crew channel has something to react to.
  // `place` overrides the generic state — live sessions showed scenes about
  // the distant orbital while the commander hung 47 km over a planetary
  // construction site: the prompt simply did not know they had left the lanes.
  const where =
    input.place ??
    (input.docked
      ? `docked at ${input.stationName ?? 'a station'}`
      : input.onFoot
        ? 'on foot'
        : input.supercruise
          ? 'in supercruise'
          : 'in normal space');
  lines.push(`The commander: ${where}`);

  // Anything the briefs know that the intel does not. Summaries only: the nouns
  // and figures underneath them were the fence, and are not wanted here.
  // Rotating the ORDER was not enough — with few briefs every one of them
  // still sat in every single prompt, and a live session watched one build
  // shortfall anchor three scenes running. One brief now sits each call OUT,
  // rotating which, so every fact gets scenes it is absent from — absence is
  // the only rotation a model actually notices.
  const extras = (input.extra ?? [])
    .map((s) => s.trim())
    .filter((s) => s && s !== 'atmosphere')
    // An extra that carries a hot noun sits out too — the campaign patron
    // line was re-seeding a saturated faction every scene.
    .filter((e) => ![...hot].some((n) => airedIn(e, n)));
  const shownExtras =
    extras.length > 1 ? rotateWindow(extras, extras.length - 1, rot).shown : extras;
  for (const line of shownExtras) {
    if (lines.includes(line)) continue;
    lines.push(line);
    if (lines.length >= MAX_LINES) break;
  }

  // Nothing known at all still says something. An empty briefing reads to a
  // model as an instruction to name nothing, which is the exact failure this
  // whole approach replaced.
  const bare = !s?.signals?.length && !s?.controllingFaction && !props.length;
  if (bare && !(input.extra ?? []).length) {
    return `System: ${input.system} — unsurveyed. Nobody here knows much about this place yet.`;
  }

  return lines.slice(0, MAX_LINES).join('\n');
}
