/**
 * Turn something the commander tells the operator — "I'm looking for tritium
 * asteroids with min 20% content" — into a prospecting target the operator then
 * watches for, calling out matching rocks as they prospect. A light intent
 * parse: a mining verb + a known mineable + an optional percentage.
 */

export interface ProspectTarget {
  /** Display name, e.g. "Tritium". */
  commodity: string;
  /** Lowercase substring used to match ProspectedAsteroid material names. */
  key: string;
  /** Minimum proportion (%) worth flagging. */
  minPct: number;
}

/** Mineable commodities the operator can be pointed at, with spoken aliases. */
const MINEABLE: { name: string; key: string; aliases: string[] }[] = [
  { name: 'Tritium', key: 'tritium', aliases: ['tritium'] },
  { name: 'Painite', key: 'painite', aliases: ['painite'] },
  { name: 'Platinum', key: 'platinum', aliases: ['platinum'] },
  { name: 'Osmium', key: 'osmium', aliases: ['osmium'] },
  { name: 'Palladium', key: 'palladium', aliases: ['palladium'] },
  { name: 'Gold', key: 'gold', aliases: ['gold'] },
  { name: 'Silver', key: 'silver', aliases: ['silver'] },
  { name: 'Low Temperature Diamonds', key: 'diamond', aliases: ['low temperature diamond', 'ltd', 'diamond'] },
  { name: 'Void Opals', key: 'opal', aliases: ['void opal', 'opal'] },
  { name: 'Alexandrite', key: 'alexandrite', aliases: ['alexandrite'] },
  { name: 'Grandidierite', key: 'grandidierite', aliases: ['grandidierite'] },
  { name: 'Monazite', key: 'monazite', aliases: ['monazite'] },
  { name: 'Musgravite', key: 'musgravite', aliases: ['musgravite'] },
  { name: 'Serendibite', key: 'serendibite', aliases: ['serendibite'] },
  { name: 'Benitoite', key: 'benitoite', aliases: ['benitoite'] },
  { name: 'Rhodplumsite', key: 'rhodplumsite', aliases: ['rhodplumsite'] },
  { name: 'Bromellite', key: 'bromellite', aliases: ['bromellite'] },
];

const INTENT = /\b(look(?:ing)?|search(?:ing)?|hunt(?:ing)?|find|want|after|prospect(?:ing)?|mine|mining|watch(?:ing)?)\b/;

/** Parse a prospecting target from a commander utterance, or null if it isn't
 *  one. Percentage defaults to a modest 15% when the commander gives no floor. */
export function parseProspectTarget(text: string): ProspectTarget | null {
  const s = text.toLowerCase();
  if (!INTENT.test(s)) return null;
  const hit = MINEABLE.find((m) => m.aliases.some((a) => s.includes(a)));
  if (!hit) return null;
  const pct =
    /(\d{1,3})\s*(?:%|percent|per\s*cent)/.exec(s) ??
    /\b(?:min(?:imum)?|at\s*least|over|above|>=?)\s*(\d{1,3})\b/.exec(s);
  const minPct = pct ? Math.min(100, Math.max(0, Number(pct[1]))) : 15;
  return { commodity: hit.name, key: hit.key, minPct };
}

/** Does a prospected material (name + proportion %) satisfy the target? */
export function matchesProspect(name: string, proportionPct: number, t: ProspectTarget): boolean {
  return proportionPct >= t.minPct && name.toLowerCase().includes(t.key);
}
