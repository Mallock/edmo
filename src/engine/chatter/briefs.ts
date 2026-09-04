/**
 * Turning what the app knows into what a transmission may say.
 *
 * Each builder takes a real data structure the app already maintains and
 * produces a Brief: the exact nouns and figures a scene about it may use, each
 * tagged with where it came from. Anything a builder does not put in the brief
 * cannot be spoken, which is what makes ambient chatter safe to trust.
 *
 * One thing had to be added rather than read. `MarketMemory.record()` replaces
 * a market by `marketId`, so there is exactly one snapshot per station and no
 * history — the app has never needed one, because a route planner only cares
 * what a price IS. But "they have knocked another 380 off" is the line worth
 * hearing, and it needs a before. `PriceWatch` below keeps that before, for a
 * small watchlist, without touching trade.ts.
 */
import type { DepotState } from '../architect.ts';
import type { MarketRecord } from '../trade.ts';
import type { OrreryPort, OrrerySystem } from '../orrery.ts';
import type {
  Location,
  Mission,
  PassengerManifestEntry,
  SystemIntel,
} from '../types.ts';
import {
  freshnessOf,
  type Brief,
  type BriefFigure,
  type BriefNoun,
  type FactSource,
} from './brief.ts';
import { rotateWindow } from '../rotate.ts';

const noun = (value: string, source: FactSource): BriefNoun => ({ value, source });
const figure = (value: string | number, source: FactSource): BriefFigure => ({
  value: String(value),
  source,
});

// ---------------------------------------------------------------------------
// Price history
// ---------------------------------------------------------------------------

export interface PriceMove {
  commodity: string;
  station: string;
  system: string;
  /** What it is now. */
  price: number;
  /** What it was, at `sinceIso`. */
  was: number;
  sinceIso: string;
  atIso: string;
  side: 'buy' | 'sell';
}

/** Below this the movement is noise, not news. */
export const MIN_MOVE_PCT = 4;
/** Commodities tracked per station. */
const WATCH_PER_STATION = 12;
/** Stations tracked. */
const WATCH_STATIONS = 24;

interface Seen {
  price: number;
  at: string;
}

/**
 * Remembers what a price WAS, so a change can be reported as a change.
 *
 * Deliberately small: the most-traded handful of commodities at each of the
 * last two dozen stations. A full price history would be a database, and the
 * only question this needs to answer is "has anything moved enough to grumble
 * about since the commander last looked".
 */
export class PriceWatch {
  private seen = new Map<string, Seen>();

  private static key(marketId: number, commodity: string, side: 'buy' | 'sell'): string {
    return `${marketId}|${side}|${commodity.toLowerCase()}`;
  }

  load(json: unknown): void {
    if (!json || typeof json !== 'object') return;
    for (const [k, v] of Object.entries(json as Record<string, Seen>)) {
      if (v && typeof v.price === 'number' && typeof v.at === 'string') this.seen.set(k, v);
    }
  }

  toJSON(): Record<string, Seen> {
    return Object.fromEntries(this.seen);
  }

  /**
   * Fold a market snapshot in, returning any movements worth reporting.
   *
   * Called with the record BEFORE MarketMemory overwrites it, or after — it
   * does not matter, because the comparison is against this class's own
   * previous observation, not against MarketMemory's.
   */
  observe(rec: MarketRecord): PriceMove[] {
    const moves: PriceMove[] = [];
    // The busiest lines first, so the watchlist spends its slots on things
    // anybody would actually mention.
    const items = [...rec.items]
      .sort((a, b) => b.demand + b.stock - (a.demand + a.stock))
      .slice(0, WATCH_PER_STATION);

    for (const item of items) {
      for (const side of ['buy', 'sell'] as const) {
        const price = side === 'buy' ? item.buy : item.sell;
        if (price <= 0) continue;
        const key = PriceWatch.key(rec.marketId, item.name, side);
        const before = this.seen.get(key);
        this.seen.set(key, { price, at: rec.at });
        if (!before || before.price <= 0) continue;
        const pct = Math.abs((price - before.price) / before.price) * 100;
        if (pct < MIN_MOVE_PCT) continue;
        if (before.at === rec.at) continue;
        moves.push({
          commodity: item.name,
          station: rec.station,
          system: rec.system,
          price,
          was: before.price,
          sinceIso: before.at,
          atIso: rec.at,
          side,
        });
      }
    }
    this.trim();
    return moves;
  }

  private trim(): void {
    const cap = WATCH_STATIONS * WATCH_PER_STATION * 2;
    if (this.seen.size <= cap) return;
    const entries = [...this.seen.entries()].sort(
      (a, b) => Date.parse(b[1].at) - Date.parse(a[1].at),
    );
    this.seen = new Map(entries.slice(0, cap));
  }
}

// ---------------------------------------------------------------------------
// Market briefs
// ---------------------------------------------------------------------------

/**
 * A brief about a price that moved.
 *
 * The figure carried is the DIFFERENCE, not both prices, because "they have
 * taken 380 off" is how a person says it and "it went from 1,240 to 860" is
 * how a spreadsheet says it. Both endpoints are licensed too, in case the
 * generated line wants them.
 */
export function marketMoveBrief(move: PriceMove, nowMs: number): Brief | null {
  const ageMs = Math.max(0, nowMs - Date.parse(move.atIso));
  if (freshnessOf(ageMs) === 'expired') return null;

  const src: FactSource = {
    kind: 'market',
    station: move.station,
    observedAt: move.atIso,
  };
  const delta = Math.abs(move.price - move.was);
  const direction = move.price > move.was ? 'up' : 'down';

  return {
    kind: 'market',
    nouns: [
      noun(move.commodity, src),
      noun(move.station, src),
      noun(move.system, src),
    ],
    figures: [
      figure(delta, src),
      figure(move.price, src),
      figure(move.was, src),
    ],
    tokens: {
      commodity: move.commodity,
      station: move.station,
      system: move.system,
      price: String(delta),
      priceNow: String(move.price),
      priceWas: String(move.was),
      direction,
    },
    ageMs,
    subjectKey: `price:${move.commodity.toLowerCase()}@${move.station.toLowerCase()}`,
    summary: `${move.commodity} at ${move.station} ${direction} ${delta}`,
  };
}

/** A brief about what a station simply pays right now — no history needed. */
export function marketPriceBrief(
  rec: MarketRecord,
  commodity: string,
  nowMs: number,
): Brief | null {
  const item = rec.items.find((i) => i.name.toLowerCase() === commodity.toLowerCase());
  if (!item) return null;
  const price = item.sell > 0 ? item.sell : item.buy;
  if (price <= 0) return null;
  const ageMs = Math.max(0, nowMs - Date.parse(rec.at));
  if (freshnessOf(ageMs) === 'expired') return null;

  const src: FactSource = { kind: 'market', station: rec.station, observedAt: rec.at };
  return {
    kind: 'market',
    nouns: [noun(item.name, src), noun(rec.station, src), noun(rec.system, src)],
    figures: [figure(price, src), figure(item.demand, src), figure(item.stock, src)],
    tokens: {
      commodity: item.name,
      station: rec.station,
      system: rec.system,
      price: String(price),
    },
    ageMs,
    subjectKey: `price:${item.name.toLowerCase()}@${rec.station.toLowerCase()}`,
    summary: `${item.name} at ${rec.station} is ${price}`,
  };
}

// ---------------------------------------------------------------------------
// Faction briefs
// ---------------------------------------------------------------------------

/**
 * A brief about who runs this place and how the balance is shifting.
 *
 * Only factions the journal actually reported are licensed. A system with no
 * faction board yields null rather than a generic line about "the locals",
 * because a generic line is exactly what makes the reference implementation's
 * chatter feel like set dressing.
 */
export function factionBrief(
  intel: SystemIntel | undefined,
  system: string,
  pick: (n: number) => number,
): Brief | null {
  const factions = intel?.factions;
  if (!factions?.length) return null;

  // Prefer somebody in an active state — that is where the story is.
  const active = factions.filter((f) => f.state && f.state !== 'None');
  const pool = active.length ? active : factions;
  const f = pool[pick(pool.length) % pool.length];
  if (!f) return null;

  const src: FactSource = { kind: 'faction', system };
  const influence = (f.influence * 100).toFixed(1);
  const nouns = [noun(f.name, src), noun(system, src)];
  if (f.state) nouns.push(noun(f.state, src));
  if (intel?.controllingFaction) nouns.push(noun(intel.controllingFaction, src));

  return {
    kind: 'faction',
    nouns,
    figures: [figure(influence, src), figure(Math.round(f.influence * 100), src)],
    tokens: {
      faction: f.name,
      system,
      influence,
      state: f.state ?? 'holding',
    },
    subjectKey: `faction:${f.name.toLowerCase()}@${system.toLowerCase()}`,
    summary: `${f.name} at ${influence}%${f.state ? ` (${f.state})` : ''}`,
  };
}

// ---------------------------------------------------------------------------
// Construction briefs
// ---------------------------------------------------------------------------

/** A brief about what a build is still short of. */
export function constructionBrief(depot: DepotState | null, rotate = 0): Brief | null {
  if (!depot || depot.complete || depot.failed) return null;
  const open = depot.resources
    .filter((r) => r.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);
  if (!open.length) return null;
  // Rotate among the biggest open lines. The single top figure used to ride
  // EVERY briefing while a build was on the books, and a live session watched
  // one aluminium shortfall anchor three scenes running — the same fact in
  // every prompt is an instruction to write about it.
  const short = rotateWindow(open.slice(0, 3), 1, rotate).shown[0];

  const site = depot.station ?? 'the construction site';
  const src: FactSource = { kind: 'construction', site };
  const nouns = [noun(short.name, src), noun(site, src)];
  if (depot.system) nouns.push(noun(depot.system, src));

  return {
    kind: 'construction',
    nouns,
    figures: [
      figure(short.remaining, src),
      figure(short.required, src),
      figure(Math.round(depot.progress * 100), src),
    ],
    tokens: {
      commodity: short.name,
      site,
      qty: String(short.remaining),
      system: depot.system ?? '',
      progress: String(Math.round(depot.progress * 100)),
    },
    ageMs: Math.max(0, Date.now() - Date.parse(depot.at)),
    subjectKey: `build:${site.toLowerCase()}:${short.key}`,
    // Not "short of" — a build order is a shopping list somebody will fill for
    // money, and the data says so, or the writer dresses it as a crisis.
    // And NO tonnage: atmosphere does not need "2,483 t", and a precise figure
    // in the prompt became a precise figure in scene after scene — nobody on a
    // working channel quotes the manifest twice. The number stays with the
    // architect, the operator and the wire, where numbers are the point.
    summary:
      `${site} (${Math.round(depot.progress * 100)}% built) is buying ${short.name} for the ` +
      `build — a construction site's shopping list, routine dock business any hauler can sell into`,
  };
}

// ---------------------------------------------------------------------------
// Manifest and contract briefs — the commander's own business, overheard
// ---------------------------------------------------------------------------
//
// Both builders speak ONLY about work already accepted. The journal never
// records what a station's board is offering — no such event exists — so no
// brief may imply the radio knows. And neither carries the reward, the step
// list or a progress counter: briefing and chasing a contract is the private
// Operator's job, and a lounge attendant who quotes your fee is a lounge
// attendant reading your mail.

/** "Tourist" → "Tourists"; count 1 keeps the singular. */
const paxPlural = (type: string, count: number): string =>
  count === 1 ? type : /s$/i.test(type) ? type : `${type}s`;

/** "a Colonia Council charter", "an Explorer on Tour charter". Initial U is
 *  treated as a consonant — "a Ukraine…", "a United…" — because the yoo-sound
 *  names dominate that letter. */
const article = (word: string): string => (/^[aeio]/i.test(word) ? 'an' : 'a');

/**
 * Time-to-expiry as words a person would say, never digits — number words
 * under twenty assert nothing the verifier polices, and "due in 47 minutes"
 * is the Operator's register, not the radio's.
 */
const SMALL_WORDS = [
  '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
export function timeLeftPhrase(expiry: string | null, nowMs: number): string | undefined {
  if (!expiry) return undefined;
  const ms = Date.parse(expiry) - nowMs;
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  const hours = ms / 3_600_000;
  if (hours < 1) return 'under an hour';
  if (hours < 2) return 'about an hour';
  if (hours < 20) return `about ${SMALL_WORDS[Math.round(hours)]} hours`;
  if (hours < 36) return 'about a day';
  const days = Math.round(hours / 24);
  return days < 20 ? `about ${SMALL_WORDS[days]} days` : 'weeks yet';
}

/**
 * What is aboard THIS ship: passengers first, mission cargo when the cabins
 * are empty, nothing when the hold is. One mission's load per call, rotated,
 * so a commander stacking eight charters does not put all eight on the air.
 *
 * `manifest` fills the gap where a mission survived a restart without its
 * passenger block and reconciliation has not yet decorated it; a manifest row
 * whose mission is unknown is never aired.
 */
export function manifestBrief(
  missions: readonly Mission[],
  manifest: readonly PassengerManifestEntry[] = [],
  rotate = 0,
): Brief | null {
  const byId = new Map(manifest.map((e) => [e.missionId, e]));
  const live = missions.filter((m) => m.state === 'ACTIVE' || m.state === 'REDIRECTED');

  const carrying = live
    .map((m) => ({ m, pax: m.passengers ?? byId.get(m.id) }))
    .filter((x): x is { m: Mission; pax: NonNullable<Mission['passengers']> } => !!x.pax);
  if (carrying.length) {
    const { m, pax } = rotateWindow(carrying, 1, rotate).shown[0];
    const src: FactSource = { kind: 'mission', missionId: m.id };
    const nouns: BriefNoun[] = [];
    if (m.faction) nouns.push(noun(m.faction, src));
    if (m.destination?.station) nouns.push(noun(m.destination.station, src));
    if (m.destination?.system) nouns.push(noun(m.destination.system, src));

    const tokens: Record<string, string> = {
      paxcount: String(pax.count),
      paxtype: pax.type,
      paxtypes: paxPlural(pax.type, pax.count),
    };
    // Presence-gated: a template naming <paxvip> or <paxwanted> binds only
    // when the flag is true, so the false case costs nothing to author around.
    if (pax.vip) tokens.paxvip = 'VIP';
    if (pax.wanted) tokens.paxwanted = 'wanted';
    if (m.faction) tokens.employer = m.faction;
    if (m.destination?.station) tokens.destport = m.destination.station;
    if (m.destination?.system) tokens.destsystem = m.destination.system;

    const bound = m.destination?.station ?? m.destination?.system;
    return {
      kind: 'manifest',
      nouns,
      figures: [figure(pax.count, src)],
      tokens,
      subjectKey: `manifest:${m.id}`,
      summary:
        `aboard right now: ${pax.count} ${paxPlural(pax.type, pax.count).toLowerCase()}` +
        (pax.vip ? ' (VIP cabins)' : '') +
        (bound ? `, bound for ${bound}` : '') +
        (m.faction ? ` — ${article(m.faction)} ${m.faction} charter` : '') +
        (pax.wanted ? '; they are WANTED, and they know it' : ''),
    };
  }

  // No passengers: mission cargo physically in the hold is still a load.
  const hauling = live.filter(
    (m) => m.commodity && m.cargo && m.cargo.collected > m.cargo.delivered,
  );
  if (!hauling.length) return null;
  const m = rotateWindow(hauling, 1, rotate).shown[0];
  const src: FactSource = { kind: 'mission', missionId: m.id };
  const aboard = m.cargo!.collected - m.cargo!.delivered;
  const tokens: Record<string, string> = {
    cargo: m.commodity!.localised,
    cargoqty: String(aboard),
  };
  if (m.faction) tokens.employer = m.faction;
  if (m.destination?.station) tokens.destport = m.destination.station;
  if (m.destination?.system) tokens.destsystem = m.destination.system;
  const nouns: BriefNoun[] = [noun(m.commodity!.localised, src)];
  if (m.faction) nouns.push(noun(m.faction, src));
  if (m.destination?.station) nouns.push(noun(m.destination.station, src));
  return {
    kind: 'manifest',
    nouns,
    figures: [figure(aboard, src)],
    tokens,
    subjectKey: `manifest:${m.id}`,
    summary:
      `in the hold: ${aboard} t of ${m.commodity!.localised} under contract` +
      (m.faction ? ` for ${m.faction}` : '') +
      (m.destination?.station ? `, headed to ${m.destination.station}` : ''),
  };
}

/**
 * Is this contract live in the CURRENT moment? Docked where it starts or
 * ends, standing in its destination system, or inside the last hour before
 * expiry. Anywhere else, an off-moment contract line is worse than silence —
 * so the brief is never built, rather than built and ranked low.
 */
export function contractRelevance(
  m: Mission,
  where: { location: Location; docked: boolean },
  nowMs: number,
): boolean {
  if (m.state !== 'ACTIVE' && m.state !== 'REDIRECTED') return false;
  const eq = (a?: string, b?: string): boolean =>
    !!a && !!b && a.toLowerCase() === b.toLowerCase();

  if (where.docked && eq(where.location.station, m.origin?.station)) return true;
  if (where.docked && eq(where.location.station, m.destination?.station)) return true;
  if (eq(where.location.system, m.destination?.system)) return true;

  if (m.expiry) {
    const left = Date.parse(m.expiry) - nowMs;
    if (!Number.isNaN(left) && left > 0 && left <= 3_600_000) return true;
  }
  return false;
}

/** One line of category colour for the contract summary — never the briefing. */
function contractWork(m: Mission): string {
  switch (m.category) {
    case 'Courier': return 'a courier run';
    case 'Delivery':
    case 'DeliveryWing': return 'a delivery';
    case 'PassengerBulk': return 'a passenger charter';
    case 'PassengerVIP': return 'a VIP charter';
    case 'Sightseeing': return 'a sightseeing tour';
    case 'LongDistanceExpedition': return 'a long-haul expedition';
    case 'Massacre':
    case 'Assassinate': return 'contract work';
    case 'Salvage': return 'a salvage job';
    case 'Mining': return 'a mining contract';
    case 'Rescue': return 'a rescue run';
    case 'Smuggle': return 'a quiet delivery';
    default: return 'a contract';
  }
}

/**
 * An accepted mission as a working relationship: who hired the commander,
 * against whom, to where, by when. Deliberately no reward, no steps, no
 * progress — that is the Operator's desk. Null whenever the contract is not
 * live in the current moment (see contractRelevance).
 */
export function contractBrief(
  m: Mission,
  where: { location: Location; docked: boolean },
  nowMs: number,
): Brief | null {
  if (!contractRelevance(m, where, nowMs)) return null;
  const src: FactSource = { kind: 'mission', missionId: m.id };
  const nouns: BriefNoun[] = [];
  if (m.faction) nouns.push(noun(m.faction, src));
  if (m.targetFaction) nouns.push(noun(m.targetFaction, src));
  if (m.destination?.system) nouns.push(noun(m.destination.system, src));
  if (m.destination?.station) nouns.push(noun(m.destination.station, src));

  const tokens: Record<string, string> = {};
  if (m.faction) tokens.employer = m.faction;
  if (m.targetFaction) tokens.targetfaction = m.targetFaction;
  if (m.destination?.station) tokens.destport = m.destination.station;
  if (m.destination?.system) tokens.destsystem = m.destination.system;
  const left = timeLeftPhrase(m.expiry, nowMs);
  if (left) tokens.timeleft = left;

  const dest = m.destination?.station ?? m.destination?.system;
  return {
    kind: 'contract',
    nouns,
    figures: [], // no reward, ever — see the module comment
    tokens,
    subjectKey: `contract:${m.id}`,
    summary:
      `the commander is working ${contractWork(m)}` +
      (m.faction ? ` for ${m.faction}` : '') +
      (m.targetFaction ? ` against ${m.targetFaction}` : '') +
      (dest ? `, bound for ${dest}` : '') +
      (left ? `, due in ${left}` : ''),
  };
}

// ---------------------------------------------------------------------------
// Geography briefs
// ---------------------------------------------------------------------------

/**
 * A brief about where things are.
 *
 * Ports come from the orrery's RESOLVED list, so a station the app could not
 * place is never named. `origin` is the system the commander actually came
 * from — the one token the reference implementation fakes outright with
 * `<randomstarsystem>`, and the easiest place to be better than it.
 */
export function geographyBrief(
  sys: OrrerySystem | null,
  system: string,
  origin: string | null,
  pick: (n: number) => number,
): Brief | null {
  // `ports` is a Map keyed by BodyID, not an array — the orrery resolves docks
  // by id so it can hang them off their parent body.
  const ports: OrreryPort[] = [...(sys?.ports.values() ?? [])].filter((p) => !!p.name);
  if (!ports.length) return null;

  const port = ports[pick(ports.length) % ports.length];
  const src: FactSource = { kind: 'geography', system };
  const nouns = [noun(port.name, src), noun(system, src)];
  if (origin) nouns.push(noun(origin, src));

  const tokens: Record<string, string> = {
    station: port.name,
    system,
    callsign: port.name,
  };
  if (origin) tokens.origin = origin;
  if (port.type) {
    nouns.push(noun(port.type, src));
    tokens.stationType = port.type;
  }

  // The one positional fact a station actually reports. Rounded, because
  // "eight hundred and twelve point four light seconds" is not radio.
  const figures: BriefFigure[] = [];
  if (port.distanceLs !== undefined && Number.isFinite(port.distanceLs)) {
    const ls = Math.round(port.distanceLs);
    figures.push(figure(ls, src));
    tokens.distanceLs = String(ls);
  }

  return {
    kind: 'geography',
    nouns,
    figures,
    tokens,
    subjectKey: `geo:${port.name.toLowerCase()}`,
    summary: `${port.name} in ${system}`,
  };
}

// ---------------------------------------------------------------------------
// Event briefs
// ---------------------------------------------------------------------------

export interface EventFact {
  /** What happened, already phrased by the caller. */
  summary: string;
  atIso: string;
  /** Proper nouns the summary contains and a scene may reuse. */
  nouns?: string[];
  /** Figures the summary contains and a scene may reuse. */
  figures?: Array<string | number>;
  /** Stable subject for arcs and anti-repetition. */
  subjectKey: string;
}

/**
 * A brief about something the commander actually did.
 *
 * This is what lets the world react — the salvage tugs going out after a fight,
 * the wire noticing a rebuy. The caller supplies the nouns and figures it used
 * in the summary, because only the caller knows which parts of its own sentence
 * were facts.
 */
export function eventBrief(fact: EventFact, nowMs: number): Brief | null {
  const ageMs = Math.max(0, nowMs - Date.parse(fact.atIso));
  if (freshnessOf(ageMs) === 'expired') return null;
  const src: FactSource = { kind: 'event', at: fact.atIso };

  return {
    kind: 'event',
    nouns: (fact.nouns ?? []).map((n) => noun(n, src)),
    figures: (fact.figures ?? []).map((f) => figure(f, src)),
    tokens: Object.fromEntries(
      (fact.nouns ?? []).map((n, i) => [`noun${i}`, n]),
    ),
    ageMs,
    subjectKey: fact.subjectKey,
    summary: fact.summary,
  };
}

// ---------------------------------------------------------------------------
// Framing by freshness
// ---------------------------------------------------------------------------

/**
 * How a scene should be allowed to phrase this brief's figures.
 *
 * The distinction is not cosmetic. A week-old price stated as current is a
 * false statement about the world dressed as a helpful tip, which is worse
 * than saying nothing — and the commander has no way to tell the difference by
 * ear. Anything genuinely too old builds no scene at all (the builders above
 * return null), so this only ever chooses between "now" and "when I last
 * looked".
 */
export type Framing = 'current' | 'hearsay';

export function framingFor(brief: Brief): Framing {
  return freshnessOf(brief.ageMs) === 'fresh' ? 'current' : 'hearsay';
}

/** Words a scene may use to hedge a stale figure, for the grammar tier. */
export function hedgeToken(brief: Brief): string {
  if (framingFor(brief) === 'current') return '';
  const ageMs = brief.ageMs ?? 0;
  const days = Math.floor(ageMs / 86_400_000);
  if (days >= 2) return `last I looked, ${days} days back,`;
  return 'last I looked,';
}

// ---------------------------------------------------------------------------
// The system, in full
// ---------------------------------------------------------------------------

/**
 * Everything true about where the commander is standing.
 *
 * The other builders in this file each answer one narrow question — what did a
 * price do, what is a build short of. That was enough to keep a template
 * supplied and nowhere near enough to make a model interesting: handed a
 * station name and one faction, it wrote the same scene in every system in the
 * galaxy, because as far as it could tell every system WAS the same.
 *
 * This is the fix. Economy and government and security say what kind of place
 * this is. The faction board says who is winning and who resents it. The FSS
 * signals say what people actually DO here — a system with three hazardous
 * extraction sites and a compromised nav beacon is a different place to work
 * than a high-tech world with a nav beacon and nothing else, and the traffic
 * on its channels should sound like it.
 *
 * Everything here comes from the journal. Nothing is inferred, nothing is
 * fetched, and every noun the model is allowed to say is in the list.
 */
export function systemBrief(
  system: string,
  intel: SystemIntel | undefined,
  sys: OrrerySystem | null,
  origin: string | null,
  opts: { docked?: boolean; stationName?: string | null } = {},
): Brief | null {
  if (!system || system === 'unknown') return null;

  const src: FactSource = { kind: 'geography', system };
  const nouns: BriefNoun[] = [noun(system, src)];
  const figures: BriefFigure[] = [];
  const tokens: Record<string, string> = { system };
  // Plain-language lines the model reads as context. Everything named in here
  // is also licensed above, so nothing in the brief is unsayable.
  const facts: string[] = [];

  // --- what kind of place is this -----------------------------------------
  const fsrc: FactSource = { kind: 'faction', system };
  if (intel?.economy) {
    nouns.push(noun(intel.economy, src));
    facts.push(`Economy: ${intel.economy}.`);
    tokens.economy = intel.economy;
  }
  if (intel?.government) {
    nouns.push(noun(intel.government, fsrc));
    facts.push(`Government: ${intel.government}.`);
  }
  if (intel?.security) {
    nouns.push(noun(intel.security, fsrc));
    facts.push(`Security: ${intel.security}.`);
    tokens.security = intel.security;
  }
  if (intel?.allegiance) {
    nouns.push(noun(intel.allegiance, fsrc));
    facts.push(`Allegiance: ${intel.allegiance}.`);
  }
  if (typeof intel?.population === 'number' && intel.population > 0) {
    figures.push(figure(intel.population, fsrc));
    facts.push(`Population: ${intel.population.toLocaleString('en-US')}.`);
  }

  // --- who runs it, and what they are trying to do -------------------------
  //
  // The board alone is a table of percentages. `factionPolitics` turns it into
  // the thing people on a channel would actually be discussing: the margin,
  // whether two superpowers are involved, what is about to land, and whether
  // anybody is happy about any of it.
  const board = (intel?.factions ?? []).slice(0, 4);
  if (board.length) {
    const parts: string[] = [];
    for (const f of board) {
      nouns.push(noun(f.name, fsrc));
      const pct = (f.influence * 100).toFixed(1);
      figures.push(figure(pct, fsrc));
      figures.push(figure(Math.round(f.influence * 100), fsrc));
      if (f.state && f.state !== 'None') nouns.push(noun(f.state, fsrc));
      if (f.allegiance) nouns.push(noun(f.allegiance, fsrc));
      if (f.government) nouns.push(noun(f.government, fsrc));
      if (f.happiness) nouns.push(noun(f.happiness, fsrc));
      for (const st of [...(f.pending ?? []), ...(f.recovering ?? [])]) {
        nouns.push(noun(st, fsrc));
      }
      parts.push(`${f.name} ${pct}%${f.state && f.state !== 'None' ? ` (${f.state})` : ''}`);
    }
    facts.push(`Faction board: ${parts.join('; ')}.`);
    facts.push(...factionPolitics(intel));
    tokens.faction = board[0].name;
    tokens.influence = (board[0].influence * 100).toFixed(1);
    if (board[0].state) tokens.state = board[0].state;
  }
  if (intel?.controllingFaction) {
    nouns.push(noun(intel.controllingFaction, fsrc));
    facts.push(`Controlling faction: ${intel.controllingFaction}.`);
  }

  // --- what people DO here -------------------------------------------------
  //
  // The single most system-specific thing the journal gives us, and the piece
  // that was being discarded entirely. Signals are why one system sounds like
  // a mining camp and the next like a border post.
  const signals = (intel?.signals ?? []).filter((sg) => !sg.isStation && sg.name);
  if (signals.length) {
    const counts = new Map<string, number>();
    for (const sg of signals) counts.set(sg.name, (counts.get(sg.name) ?? 0) + 1);
    const listed: string[] = [];
    for (const [name, n] of [...counts.entries()].slice(0, 8)) {
      nouns.push(noun(name, src));
      if (n > 1) figures.push(figure(n, src));
      // "x2" is a tally, not something anybody says. A 4B model handed
      // "Resource Extraction Site [Hazardous] x2" repeats it verbatim,
      // punctuation and all.
      listed.push(n > 1 ? `${name} (${n} of them)` : name);
    }
    facts.push(`Signal sources detected: ${listed.join('; ')}.`);
    tokens.signal = listed[0].replace(/ x\d+$/, '');
  }

  // --- the ports -----------------------------------------------------------
  const ports = [...(sys?.ports.values() ?? [])].filter((p) => p.name);
  if (ports.length) {
    const listed: string[] = [];
    for (const port of ports.slice(0, 6)) {
      nouns.push(noun(port.name, src));
      if (port.type) nouns.push(noun(port.type, src));
      const ls =
        typeof port.distanceLs === 'number' && Number.isFinite(port.distanceLs)
          ? Math.round(port.distanceLs)
          : null;
      if (ls !== null) figures.push(figure(ls, src));
      listed.push(`${port.name}${port.type ? ` (${port.type})` : ''}${ls !== null ? `, ${ls} ls out` : ''}`);
    }
    facts.push(`Ports: ${listed.join('; ')}.`);
    tokens.station = opts.stationName ?? ports[0].name;
    tokens.callsign = tokens.station;
  }

  // --- the sky -------------------------------------------------------------
  const bodies = [...(sys?.bodies.values() ?? [])];
  if (bodies.length) {
    figures.push(figure(bodies.length, src));
    const landable = bodies.filter((b) => (b as { landable?: boolean }).landable).length;
    if (landable > 0) figures.push(figure(landable, src));
    facts.push(
      `Charted here: ${bodies.length} bodies${landable ? `, ${landable} landable` : ''}.`,
    );
  }

  if (origin) {
    nouns.push(noun(origin, src));
    tokens.origin = origin;
    facts.push(`The commander arrived from ${origin}.`);
  }
  if (opts.docked && opts.stationName) {
    nouns.push(noun(opts.stationName, src));
    facts.push(`The commander is docked at ${opts.stationName} right now.`);
  }

  // A brief with nothing but the system's own name teaches the model nothing.
  if (facts.length < 2) return null;

  return {
    kind: 'geography',
    nouns,
    figures,
    tokens,
    subjectKey: `system:${system.toLowerCase()}`,
    summary: facts.join(' '),
  };
}

/**
 * What a background-simulation state MEANS to somebody standing there.
 *
 * "Expansion" is a word on a panel. What a haulier notices is that everyone is
 * suddenly hiring and half the docks are arguing about it. The model cannot
 * infer that from the token, and told only the token it writes a scene that
 * would fit any system with any state — which is the failure the whole rich
 * brief exists to avoid.
 *
 * Deliberately about consequences rather than mechanics: nothing here explains
 * the BGS, because nobody on a radio channel explains the BGS.
 */
const STATE_AGENDA: Readonly<Record<string, string>> = {
  Expansion: 'pushing outward — hiring haulers, shipping materials, and not everyone is pleased about it',
  Boom: 'flush with money — everyone is busy, the yards are full, and the prices show it',
  Bust: 'broke — contracts drying up, crews idle, people talking about leaving',
  War: 'at war — combat zones, supply runs, and nobody flying anywhere casually',
  CivilWar: 'fighting its own — the split runs through the docks and people watch what they say',
  Election: 'mid-election — rival claims, campaigning on the concourse, everyone sick of it',
  Famine: 'short of food — rationing, priority cargo, tempers going',
  Outbreak: 'dealing with an outbreak — medical shipments and quarantine paperwork',
  Lockdown: 'locked down — security everywhere, manifests checked twice, nothing moves fast',
  CivilUnrest: 'restive — strikes, patrols, and a lot of people not at their posts',
  Retreat: 'pulling out — abandoned contracts and staff who do not know where they stand',
  Investment: 'being built up — construction contracts and cautious optimism',
  Drought: 'short of water — hydration runs and rationing',
  Blight: 'losing its crops — agricultural shipments and worried farmers',
  PirateAttack: 'being raided — the lanes are not safe and everybody knows it',
  Terrorism: 'on edge after attacks — checks everywhere, nobody relaxed',
  NaturalDisaster: 'cleaning up after a disaster — relief cargo and long shifts',
  InfrastructureFailure: 'with its infrastructure down — everything slower and improvised',
};

/** How a government type behaves, in words a scene can act on. */
const GOVERNMENT_AGENDA: Readonly<Record<string, string>> = {
  Anarchy: 'no law worth the name',
  Corporate: 'run as a business, and it shows in the paperwork',
  Democracy: 'run by committee, slowly',
  Dictatorship: 'run by one office nobody argues with',
  Communism: 'run collectively, with the meetings that implies',
  Confederacy: 'loosely governed and proud of it',
  Cooperative: 'run by its own workers',
  Feudal: 'run on obligation and old favours',
  Patronage: 'run on who owes whom',
  Theocracy: 'run on doctrine',
  Prison: 'a prison, and the traffic reflects it',
  PrisonColony: 'a prison colony, and the traffic reflects it',
  Imperial: 'imperial, formal, and conscious of rank',
};

/**
 * The politics of a system, as something to talk about.
 *
 * The board on its own is a table of percentages. What makes a channel sound
 * like THIS system is the relationships in it: who is close enough to worry
 * the leader, whether the two of them answer to different superpowers, what is
 * about to land, and whether anybody is actually happy.
 */
export function factionPolitics(intel: SystemIntel | undefined): string[] {
  const board = intel?.factions ?? [];
  if (!board.length) return [];
  const lines: string[] = [];
  const [lead, second] = board;

  if (lead) {
    const bits = [`${lead.name} holds ${(lead.influence * 100).toFixed(1)}%`];
    if (lead.government && GOVERNMENT_AGENDA[lead.government]) {
      bits.push(GOVERNMENT_AGENDA[lead.government]);
    }
    // "aligned to the Independent" is not English. Independent is a state of
    // being; the superpowers take the article.
    if (lead.allegiance) {
      bits.push(
        /^independent$/i.test(lead.allegiance)
          ? 'independent'
          : `aligned to the ${lead.allegiance}`,
      );
    }
    if (lead.happiness) bits.push(`the population is ${lead.happiness.toLowerCase()}`);
    lines.push(`${bits.join(', ')}.`);
  }

  // The margin is the story. Two points apart is a knife fight; forty is a
  // formality, and people talk about them completely differently.
  if (second) {
    const gap = (lead.influence - second.influence) * 100;
    const how =
      gap < 3
        ? 'close enough that it could turn'
        : gap < 12
          ? 'gaining, and it is being noticed'
          : 'well behind and not seriously contesting it';
    lines.push(
      `${second.name} sits second on ${(second.influence * 100).toFixed(1)}% — ${how}.`,
    );
    if (lead.allegiance && second.allegiance && lead.allegiance !== second.allegiance) {
      lines.push(
        `They answer to different powers — ${lead.allegiance} against ${second.allegiance} — so this is not only local.`,
      );
    }
  }

  for (const f of board.slice(0, 4)) {
    if (f.state && STATE_AGENDA[f.state]) {
      lines.push(`${f.name} is ${STATE_AGENDA[f.state]}.`);
    }
    if (f.pending?.length) {
      const known = f.pending.filter((x) => STATE_AGENDA[x]);
      if (known.length) lines.push(`${f.name} has ${known.join(' and ')} coming.`);
    }
    if (f.recovering?.length) {
      const known = f.recovering.filter((x) => STATE_AGENDA[x]);
      if (known.length) lines.push(`${f.name} is still coming out of ${known.join(' and ')}.`);
    }
    if (f.happiness && /discontent|unhappy|despondent/i.test(f.happiness)) {
      lines.push(`${f.name}'s people are ${f.happiness.toLowerCase()}.`);
    }
  }
  return lines;
}

/**
 * The tower calling THIS ship — the one brief that is about the commander.
 *
 * Every other brief describes the world; this one describes a transmission
 * addressed to the player, so it carries the two things such a transmission
 * cannot do without: what their ship is called, and the pad number the game
 * actually assigned. Both come from the journal — `Loadout` names the ship,
 * `DockingGranted` gives the pad — so the tower can be exactly right about
 * the one detail the commander is about to act on.
 */
export function towerBrief(fact: {
  station: string;
  system: string;
  ship: string;
  pad?: number | null;
  /** What the tower is actually calling about. */
  moment: 'granted' | 'denied' | 'requested' | 'departure' | 'arrival';
  /** Why, when the game refused — already in plain words. */
  reason?: string | null;
}): Brief {
  const src: FactSource = { kind: 'geography', system: fact.system };
  const nouns = [noun(fact.station, src), noun(fact.ship, src)];
  const figures: BriefFigure[] = [];
  const tokens: Record<string, string> = {
    station: fact.station,
    system: fact.system,
    callsign: fact.station,
    myship: fact.ship,
  };
  if (fact.pad != null && fact.pad > 0) {
    tokens.pad = String(fact.pad);
    figures.push(figure(fact.pad, src));
  }
  if (fact.reason) tokens.reason = fact.reason;
  return {
    kind: 'geography',
    nouns,
    figures,
    tokens,
    subjectKey: `tower:${fact.station.toLowerCase()}:${fact.moment}`,
    summary: `${fact.station} tower to ${fact.ship}`,
  };
}
