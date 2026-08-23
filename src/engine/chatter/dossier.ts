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
  /** Summaries from the fact briefs — construction depots, markets, events. */
  extra?: readonly string[];
}

const trim = <T>(xs: readonly T[], cap: number): { shown: T[]; more: number } => ({
  shown: xs.slice(0, cap),
  more: Math.max(0, xs.length - cap),
});

const plus = (more: number): string => (more ? ` (+${more} more)` : '');

const pct = (influence: number): string => `${(influence * 100).toFixed(1)}%`;

export function buildDossier(input: DossierInput): string {
  const s = input.intel;
  const lines: string[] = [];

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

  if (s?.controllingFaction) {
    const ruling = s.factions?.find((f) => f.name === s.controllingFaction);
    lines.push(`Runs this system: ${s.controllingFaction}${ruling ? ` (${pct(ruling.influence)})` : ''}`);
  }

  // The influence board, minus whoever already appeared as the controller.
  const others = (s?.factions ?? [])
    .filter((f) => f.name !== s?.controllingFaction)
    .slice()
    .sort((a, b) => b.influence - a.influence)
    .map((f) => {
      const bits = [pct(f.influence)];
      if (f.state && f.state !== 'None') bits.push(f.state);
      return `${f.name} (${bits.join(', ')})`;
    });
  if (others.length) {
    const { shown, more } = trim(others, 4);
    lines.push(`Also here: ${shown.join(' · ')}${plus(more)}`);
  }

  // Faction states carry the mood even when the full board is unknown.
  if (!s?.factions?.length && s?.factionStates?.length) {
    const { shown, more } = trim(s.factionStates.map((f) => `${f.name} (${f.state})`), 4);
    lines.push(`Going on locally: ${shown.join(' · ')}${plus(more)}`);
  }

  // Places. Carriers are COUNTED, never named — a hub system carries a dozen
  // XXX-XXX registrations and they crowd out the names that mean something.
  const stationSignals = (s?.signals ?? []).filter((x) => x.isStation);
  const stations = stationSignals.filter((x) => !isFleetCarrier(x)).map((x) => x.name);
  const carriers = stationSignals.filter(isFleetCarrier).length;
  if (stations.length) {
    const { shown, more } = trim([...new Set(stations)], 5);
    lines.push(`Stations: ${shown.join(' · ')}${plus(more)}`);
  }
  if (carriers) lines.push(`Fleet carriers parked here: ${carriers}`);

  const sites = (s?.signals ?? []).filter((x) => !x.isStation).map((x) => x.name);
  if (sites.length) {
    const { shown, more } = trim([...new Set(sites)], 6);
    lines.push(`Signals detected: ${shown.join(' · ')}${plus(more)}`);
  }

  // How far out things are — the most complained-about fact in the game.
  const sep = input.portSeparationLs;
  if (!input.docked && typeof sep === 'number' && sep > 0) {
    lines.push(`Nearest port: ${Math.round(sep).toLocaleString('en-US')} ls out`);
  }

  // Where the commander is, so the crew channel has something to react to.
  const where = input.docked
    ? `docked at ${input.stationName ?? 'a station'}`
    : input.onFoot
      ? 'on foot'
      : input.supercruise
        ? 'in supercruise'
        : 'in normal space';
  lines.push(`The commander: ${where}`);

  // Anything the briefs know that the intel does not. Summaries only: the nouns
  // and figures underneath them were the fence, and are not wanted here.
  for (const summary of input.extra ?? []) {
    const line = summary.trim();
    if (!line || line === 'atmosphere' || lines.includes(line)) continue;
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
