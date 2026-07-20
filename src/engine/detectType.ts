/**
 * Mission type detection from the internal `Name` string (SPEC.md §3.1.4).
 *
 * ED encodes the type in Name, e.g. "Mission_PassengerVIP_CEO_EXPANSION" or
 * "MISSION_Salvage_Illegal". There is no clean enum in the game.
 */
import type { MissionCategory } from './types.ts';

const BGS_STATES = [
  'expansion',
  'war',
  'civilwar',
  'boom',
  'election',
  'bust',
  'outbreak',
  'conflict',
  'democracy',
  'famine',
  'lockdown',
  'retreat',
  'investment',
];

/** Ordered longest-first so multi-word families win over their prefixes.
 *  On-foot (Odyssey) missions all normalize to `onfoot_...`; they win first so
 *  e.g. `Mission_OnFoot_Salvage` maps to OnFoot rather than Salvage. */
const FAMILY_RULES: Array<[RegExp, MissionCategory]> = [
  [/^onfoot/, 'OnFoot'],
  [/^longdistanceexpedition/, 'LongDistanceExpedition'],
  [/^deliverywing/, 'DeliveryWing'],
  [/^passengervip/, 'PassengerVIP'],
  [/^passengerbulk/, 'PassengerBulk'],
  [/^passenger/, 'PassengerBulk'],
  [/^sightseeing/, 'Sightseeing'],
  [/^assassinate/, 'Assassinate'],
  [/^massacre/, 'Massacre'],
  [/^salvage/, 'Salvage'],
  [/^collect/, 'Collect'],
  [/^mining/, 'Mining'],
  [/^rescue/, 'Rescue'],
  [/^smuggle/, 'Smuggle'],
  [/^altruism/, 'Donation'], // Mission_AltruismCredits / Mission_Altruism
  [/^scan/, 'Scan'],
  [/^hack/, 'Hack'],
  [/^sabotage/, 'Disable'],
  [/^disable/, 'Disable'],
  [/^delivery/, 'Delivery'],
  [/^courier/, 'Courier'],
];

/** Normalize a raw Name to lowercase tokens, dropping prefix/suffix noise. */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mission_/, '')
    .replace(/_name$/, '')
    .replace(/;$/, '');
}

export function detectCategory(name: string): MissionCategory {
  const n = normalize(name);
  for (const [re, cat] of FAMILY_RULES) {
    if (re.test(n)) return cat;
  }
  return 'Other';
}

/** Parse the BGS-state modifier (e.g. "Expansion", "CivilWar") if present. */
export function detectBgsState(name: string): string | undefined {
  const tokens = normalize(name).split('_');
  // Scan right-to-left: the specific state (e.g. "CivilWar") trails the generic
  // grouping token (e.g. "Conflict") in names like Mission_Massacre_Conflict_CivilWar.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (BGS_STATES.includes(t)) {
      if (t === 'civilwar') return 'CivilWar'; // keep readable casing
      return t.charAt(0).toUpperCase() + t.slice(1);
    }
  }
  return undefined;
}
