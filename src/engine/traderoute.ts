/**
 * Trade-route finder — the Inara-style search, built on Ardent Insight (EDDN).
 *
 * The Spansh planner we already had looks for a closed multi-hop LOOP, and when
 * no loop clears its threshold it returns nothing at all. That is what the
 * commander hit while docked at Tir: Spansh said "no profitable loop", while
 * Inara's plain best-pair search over the same region found a 44,000 cr/t
 * bauxite run 30 ly away. A loop is a nice-to-have; a profitable next leg is
 * the thing actually being asked for.
 *
 * So this module does what Inara does: pair what you can BUY where you are
 * against the best place to SELL it within range, honour the landing-pad and
 * supply floors a real ship needs, and rank by credits per trip for the hold
 * you actually have.
 *
 * Pure module (no DOM/Tauri/fetch): the store injects the fetched rows, so the
 * pairing, filtering and honesty about search limits are all unit-tested in
 * tests/traderoute.test.ts.
 */

/** One market row as Ardent reports it, trimmed to what routing needs. */
export interface MarketRow {
  commodity: string;
  station: string;
  system: string;
  stationType: string | null;
  /** 1 = small, 2 = medium, 3 = large. */
  pad: number | null;
  /** Ly from the origin system. Absent/0 for rows in the origin itself. */
  distanceLy: number | null;
  /** Ls from the system's arrival point — the part that eats real time. */
  distanceLs: number | null;
  buyPrice: number | null;
  sellPrice: number | null;
  stock: number | null;
  demand: number | null;
  /** ISO timestamp of the last EDDN report for this market. */
  updatedAt: string | null;
  /** Galactic coordinates, when the endpoint supplies them. */
  x?: number | null;
  y?: number | null;
  z?: number | null;
}

export interface RouteFilters {
  /** Smallest pad the ship can use: 2 for medium, 3 for large-pad-only hulls. */
  minPad: number;
  /** Floor on stock at the source and demand at the sink. */
  minVolume: number;
  /** Tons the hold can take. */
  cargo: number;
  /** Ignore markets whose last EDDN report is older than this. */
  maxAgeDays: number;
}

export const DEFAULT_FILTERS: RouteFilters = {
  // Medium: an outpost pad. Plenty of the best sinks are outposts — Neugebauer
  // Mines, the 44k bauxite buyer, is one — so defaulting to large would hide
  // exactly the routes worth having.
  minPad: 2,
  // A thousand tons either side. Below that a 400 t hold makes one trip and the
  // market is dry, which is not a route, it is a coincidence.
  minVolume: 1000,
  cargo: 400,
  maxAgeDays: 14,
};

export interface TradeLeg {
  commodity: string;
  fromStation: string;
  fromSystem: string;
  toStation: string;
  toSystem: string;
  distanceLy: number;
  /** Supercruise legs at each end, which is where the time actually goes. */
  fromLs: number | null;
  toLs: number | null;
  buyPrice: number;
  sellPrice: number;
  profitPerTon: number;
  /** Tons actually movable: hold, stock and demand, whichever binds first. */
  tons: number;
  profitPerTrip: number;
  stock: number;
  demand: number;
  fromPad: number | null;
  toPad: number | null;
  /** Age in hours of the STALER of the two market reports. */
  dataAgeH: number | null;
}

export interface TradeFind {
  legs: TradeLeg[];
  /**
   * False when the origin is absent from the market data entirely. Distinct
   * from "searched and found nothing" — usually a misheard or mistyped name,
   * and saying "no profitable run" would send the commander looking for a
   * market problem that does not exist.
   */
  originKnown: boolean;
  /** Commodities probed for a sink, and how many were buyable in total. */
  checked: number;
  candidates: number;
  filters: RouteFilters;
  origin: string;
  /**
   * Set when the commander named where they are GOING. A directed search is a
   * different question from "what pays best anywhere" — they have a reason to
   * be heading there, and a smaller profit on the way is worth more than a
   * bigger one in the opposite direction.
   */
  destination?: string;
  /** False when the destination is absent from the market data entirely. */
  destinationKnown?: boolean;
  /**
   * The station the commander is standing on, when docked.
   *
   * The cheapest source is frequently a DIFFERENT station in the same system,
   * and "a run out of here" then gets read as "a run out of this station".
   * Told military grade fabrics were 371 while the board in front of them said
   * 3,691, the commander reasonably concluded the operator was inventing
   * numbers — both were correct, and they belonged to different outposts.
   */
  atStation?: string;
}

/**
 * Work out what the commander meant by a name.
 *
 * Asked "find a profitable trade run for rahtari", a model will put "rahtari"
 * in the system slot — but Rahtari is the commander's Type-8, not a place.
 * Looking it up as a system produces a 404 and an answer about missing market
 * data, when the actual request was "a run for the ship I am flying". Ship
 * names, idents and hull types all resolve to "here, in this ship".
 */
export function resolveOrigin(
  requested: string | null | undefined,
  currentSystem: string,
  ship: { ship?: string; shipName?: string; shipIdent?: string } | null,
): { origin: string; namedTheShip: boolean } {
  const norm = (v: string | null | undefined): string =>
    (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const asked = norm(requested);
  if (!asked) return { origin: currentSystem, namedTheShip: false };
  const aliases = [ship?.shipName, ship?.shipIdent, ship?.ship].map(norm).filter(Boolean);
  if (aliases.includes(asked)) return { origin: currentSystem, namedTheShip: true };
  return { origin: (requested ?? '').trim(), namedTheShip: false };
}

/**
 * Straight-line distance between two markets' systems, in light years.
 *
 * The `nearby/` endpoints hand back a `distance`; the plain per-system ones do
 * not, so a directed search had nothing and rendered "Tir, 0 ly" — which reads
 * as "you are already there" for a system forty-three light years away. The
 * coordinates are in every row, so compute it.
 */
export function systemDistanceLy(a: MarketRow, b: MarketRow): number | null {
  if (a.x == null || a.y == null || a.z == null) return null;
  if (b.x == null || b.y == null || b.z == null) return null;
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

const hoursSince = (iso: string | null, nowMs: number): number | null =>
  iso ? Math.max(0, Math.round((nowMs - Date.parse(iso)) / 3_600_000)) : null;

const fresh = (row: MarketRow, nowMs: number, maxAgeDays: number): boolean => {
  const h = hoursSince(row.updatedAt, nowMs);
  return h == null || h <= maxAgeDays * 24;
};

/**
 * Cheapest buyable source per commodity at the origin, after the pad and stock
 * floors. Several stations in one system often sell the same thing; only the
 * cheapest matters, and only if the ship can actually land there.
 */
export function cheapestSources(
  rows: readonly MarketRow[],
  f: RouteFilters,
  nowMs: number,
): Map<string, MarketRow> {
  const best = new Map<string, MarketRow>();
  for (const r of rows) {
    if ((r.pad ?? 0) < f.minPad) continue;
    if ((r.stock ?? 0) < f.minVolume) continue;
    if (!r.buyPrice || r.buyPrice <= 0) continue;
    if (!fresh(r, nowMs, f.maxAgeDays)) continue;
    const cur = best.get(r.commodity);
    if (!cur || r.buyPrice < (cur.buyPrice ?? Infinity)) best.set(r.commodity, r);
  }
  return best;
}

/** Dearest reachable sink for one commodity, or null when none qualifies. */
export function bestSink(
  rows: readonly MarketRow[],
  f: RouteFilters,
  originSystem: string,
  nowMs: number,
): MarketRow | null {
  let best: MarketRow | null = null;
  for (const r of rows) {
    if ((r.pad ?? 0) < f.minPad) continue;
    if ((r.demand ?? 0) < f.minVolume) continue;
    if (!r.sellPrice || r.sellPrice <= 0) continue;
    if (!fresh(r, nowMs, f.maxAgeDays)) continue;
    // Selling back into the system you bought from is not a route.
    if (r.system === originSystem) continue;
    if (!best || r.sellPrice > (best.sellPrice ?? 0)) best = r;
  }
  return best;
}

/**
 * Best sink per commodity, for a directed search into one system. Unlike
 * `bestSink`, which answers "where does this one good pay most", this answers
 * "of everything sold here, what does that system pay most for" — the shape of
 * the question when the commander has already decided where they are going.
 */
export function bestSinksByCommodity(
  rows: readonly MarketRow[],
  f: RouteFilters,
  originSystem: string,
  nowMs: number,
): Map<string, MarketRow> {
  const best = new Map<string, MarketRow>();
  for (const r of rows) {
    if ((r.pad ?? 0) < f.minPad) continue;
    if ((r.demand ?? 0) < f.minVolume) continue;
    if (!r.sellPrice || r.sellPrice <= 0) continue;
    if (!fresh(r, nowMs, f.maxAgeDays)) continue;
    if (r.system === originSystem) continue;
    const cur = best.get(r.commodity);
    if (!cur || r.sellPrice > (cur.sellPrice ?? 0)) best.set(r.commodity, r);
  }
  return best;
}

/** Every profitable pairing between what is on sale here and what they buy there. */
export function legsToDestination(
  sources: ReadonlyMap<string, MarketRow>,
  sinks: ReadonlyMap<string, MarketRow>,
  f: RouteFilters,
  nowMs: number,
): TradeLeg[] {
  const legs: Array<TradeLeg | null> = [];
  for (const [commodity, src] of sources) {
    const sink = sinks.get(commodity);
    if (sink) legs.push(buildLeg(src, sink, f, nowMs));
  }
  return rankLegs(legs);
}

/** Pair one source with one sink into a costed leg, or null if it loses money. */
export function buildLeg(
  source: MarketRow,
  sink: MarketRow,
  f: RouteFilters,
  nowMs: number,
): TradeLeg | null {
  const buyPrice = source.buyPrice ?? 0;
  const sellPrice = sink.sellPrice ?? 0;
  const profitPerTon = sellPrice - buyPrice;
  if (profitPerTon <= 0) return null;
  const stock = source.stock ?? 0;
  const demand = sink.demand ?? 0;
  const tons = Math.max(0, Math.min(f.cargo, stock, demand));
  if (tons <= 0) return null;
  const ages = [hoursSince(source.updatedAt, nowMs), hoursSince(sink.updatedAt, nowMs)].filter(
    (h): h is number => h != null,
  );
  return {
    commodity: source.commodity,
    fromStation: source.station,
    fromSystem: source.system,
    toStation: sink.station,
    toSystem: sink.system,
    distanceLy: Math.round(sink.distanceLy ?? systemDistanceLy(source, sink) ?? 0),
    fromLs: source.distanceLs == null ? null : Math.round(source.distanceLs),
    toLs: sink.distanceLs == null ? null : Math.round(sink.distanceLs),
    buyPrice,
    sellPrice,
    profitPerTon,
    tons,
    profitPerTrip: profitPerTon * tons,
    stock,
    demand,
    fromPad: source.pad,
    toPad: sink.pad,
    dataAgeH: ages.length ? Math.max(...ages) : null,
  };
}

/**
 * Rank the origin's buyable commodities by the best spread the galaxy could
 * possibly give them, so a bounded number of sink lookups goes to the
 * commodities most likely to pay. `galaxyMaxSell` is the galaxy-wide ceiling
 * per commodity; a commodity whose ceiling is below the local buy price cannot
 * profit anywhere and is dropped without spending a request on it.
 */
export function probeOrder(
  sources: Map<string, MarketRow>,
  galaxyMaxSell: ReadonlyMap<string, number>,
): string[] {
  return [...sources.values()]
    .map((r) => ({
      commodity: r.commodity,
      ceiling: (galaxyMaxSell.get(r.commodity) ?? 0) - (r.buyPrice ?? 0),
    }))
    .filter((x) => x.ceiling > 0)
    .sort((a, b) => b.ceiling - a.ceiling)
    .map((x) => x.commodity);
}

/** Assemble and rank the finished legs. Richest trip first. */
export function rankLegs(legs: readonly (TradeLeg | null)[]): TradeLeg[] {
  return legs.filter((l): l is TradeLeg => l != null).sort((a, b) => b.profitPerTrip - a.profitPerTrip);
}

const cr = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`;

const padName = (p: number | null): string =>
  p === 3 ? 'large' : p === 2 ? 'medium' : p === 1 ? 'small' : 'unknown';

/** One speakable line for a single leg. */
export function describeLeg(l: TradeLeg, atStation?: string): string {
  // Where the run STARTS is the first thing that matters when it is not under
  // the commander's feet — otherwise the price reads as the board they are
  // looking at, and every figure after it looks like a lie.
  const elsewhere =
    atStation && key(atStation) !== key(l.fromStation)
      ? `NOT here — fly to ${l.fromStation}${l.fromLs != null ? ` (${l.fromLs.toLocaleString('en-US')} Ls)` : ''} first — `
      : '';
  return (
    `${l.commodity} — ${elsewhere}buy at ${l.buyPrice.toLocaleString('en-US')} from ${l.fromStation} (${l.fromSystem}` +
    `${l.fromLs != null ? `, ${l.fromLs.toLocaleString('en-US')} Ls` : ''}), sell at ` +
    `${l.sellPrice.toLocaleString('en-US')} to ${l.toStation} (${l.toSystem}, ${l.distanceLy} ly` +
    `${l.toLs != null ? `, ${l.toLs.toLocaleString('en-US')} Ls` : ''}). ` +
    `${l.profitPerTon.toLocaleString('en-US')} cr a ton, ${cr(l.profitPerTrip)} for ${l.tons} t. ` +
    `Pads ${padName(l.fromPad)}/${padName(l.toPad)}, stock ${l.stock.toLocaleString('en-US')}, ` +
    `demand ${l.demand.toLocaleString('en-US')}` +
    `${l.dataAgeH != null ? `, prices ${l.dataAgeH < 48 ? `${l.dataAgeH} h` : `${Math.round(l.dataAgeH / 24)} days`} old` : ''}.`
  );
}

/**
 * The whole answer, for the model to speak from. Says plainly how much of the
 * search space was covered: a bounded probe that reports "the best of 8 I
 * checked" is honest, while one that says "the best route" is not.
 */
export function describeTradeFind(find: TradeFind, max = 3): string {
  const { filters: f } = find;
  const constraints =
    `${padName(f.minPad)} pad or better, at least ${f.minVolume.toLocaleString('en-US')} t either side, ` +
    `${f.cargo} t hold`;
  if (find.destination && find.destinationKnown === false) {
    return (
      `I have no market data for "${find.destination}" — check the name, or nobody has reported a ` +
      `market there. I can still find you the best-paying run in any direction.`
    );
  }
  if (find.destination) {
    // A directed answer must never quietly become an undirected one: telling a
    // commander headed for Tir about a good run to Luchtaine answers a question
    // they did not ask.
    if (!find.legs.length) {
      return (
        `Nothing on sale around ${find.origin} sells for more at ${find.destination} — not on ` +
        `${constraints}. You would be flying there empty, or hauling at a loss. Want the ` +
        `best-paying run in any direction instead?`
      );
    }
    const body = find.legs.slice(0, max).map((l, i) => `${i + 1}. ${describeLeg(l, find.atStation)}`);
    return (
      `Best cargo for the run to ${find.destination} (${constraints}):\n${body.join('\n')}\n` +
      `Community prices, so verify stock on arrival.`
    );
  }
  if (!find.originKnown) {
    return (
      `I have no market data for "${find.origin}" — check the name, or it may be a system nobody has ` +
      `reported a market in. Say it again and I will look, or I can search from where we are.`
    );
  }
  if (!find.legs.length) {
    return (
      `No profitable run out of ${find.origin} within range on ${constraints}. ` +
      `I checked the ${find.checked} most promising of ${find.candidates} commodities buyable there. ` +
      `Widening the range, or dropping the ${f.minVolume.toLocaleString('en-US')} t floor, would open it up.`
    );
  }
  const head =
    `Best runs from ${find.origin} (${constraints}; checked the ${find.checked} likeliest of ` +
    `${find.candidates} buyable commodities):`;
  const body = find.legs.slice(0, max).map((l, i) => `${i + 1}. ${describeLeg(l, find.atStation)}`);
  const note = find.atStation
    ? `\nThe commander is docked at ${find.atStation}. A leg marked "NOT here" starts at a DIFFERENT ` +
      `station — say so, rather than implying the price is on the board in front of them.`
    : '';
  return `${head}\n${body.join('\n')}${note}\nCommunity prices, so verify stock on arrival.`;
}

/**
 * Should an AUTOMATIC route search run right now?
 *
 * The docking trigger fires on its own, and firing it while something is
 * already on screen is worse than useless: a run or route card the commander
 * has not acted on yet gets silently replaced by a different one, and the
 * suggestion they were halfway through reading is gone. Active missions say
 * the same thing louder — they have work in hand and did not dock here looking
 * for cargo.
 *
 * Returns why it is blocked, or null to go ahead. Manual searches never consult
 * this; pressing the button means asking.
 */
export function autoRouteBlocked(state: {
  /** A found trade run is on screen. */
  hasRunCard: boolean;
  /** A Spansh loop is on screen. */
  hasRouteCard: boolean;
  /** Missions the commander is carrying. */
  activeMissions: number;
}): string | null {
  if (state.hasRunCard) return 'a trade run is already on the board';
  if (state.hasRouteCard) return 'a route is already on the board';
  if (state.activeMissions > 0) {
    return `${state.activeMissions} mission(s) in hand`;
  }
  return null;
}

/** A market the commander personally docked at — first-hand, and complete. */
export interface OwnObservation {
  station: string;
  system: string;
  /** ISO timestamp of the snapshot. */
  at: string;
  /** Only commodities actually buyable or sellable there when we looked. */
  items: ReadonlyArray<{ name: string; buy: number; sell: number; stock: number; demand: number }>;
}

/** "Basic Medicines" and "basicmedicines" are the same thing. */
const key = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Correct community data with what the commander saw themselves.
 *
 * EDDN rows can be days old, and the operator sent someone thirty light years
 * for bauxite that was not on the board when they arrived. A market we have
 * docked at is better evidence than a stranger's report from last week, in two
 * directions:
 *
 *  - Prices and volumes we recorded REPLACE the community ones for that
 *    station, when our visit is the more recent of the two.
 *  - A commodity ABSENT from our snapshot vetoes the community row entirely.
 *    Snapshots keep every commodity that was buyable or sellable, so absence
 *    means we looked and it was not for sale — not that we failed to record it.
 *
 * Metadata the snapshot lacks (pad size, coordinates, distance) is kept from
 * the community row, which is where it comes from.
 */
export function applyOwnObservations(
  rows: readonly MarketRow[],
  own: readonly OwnObservation[],
): MarketRow[] {
  if (!own.length) return rows.slice();
  // Newest visit per station wins, and index its goods for absence checks.
  const visits = new Map<string, { at: number; goods: Map<string, OwnObservation['items'][number]> }>();
  for (const o of own) {
    const id = `${key(o.system)}|${key(o.station)}`;
    const at = Date.parse(o.at);
    if (!Number.isFinite(at)) continue;
    const prev = visits.get(id);
    if (prev && prev.at >= at) continue;
    visits.set(id, { at, goods: new Map(o.items.map((i) => [key(i.name), i])) });
  }

  const out: MarketRow[] = [];
  for (const r of rows) {
    const visit = visits.get(`${key(r.system)}|${key(r.station)}`);
    if (!visit) {
      out.push(r);
      continue;
    }
    const theirs = Date.parse(r.updatedAt ?? '');
    // Only override when OUR look is the fresher one; a community report from
    // this morning beats our visit from last week.
    if (Number.isFinite(theirs) && theirs > visit.at) {
      out.push(r);
      continue;
    }
    const seen = visit.goods.get(key(r.commodity));
    if (!seen) continue; // we were there, it was not on the board
    out.push({
      ...r,
      buyPrice: seen.buy || null,
      sellPrice: seen.sell || null,
      stock: seen.stock,
      demand: seen.demand,
      updatedAt: new Date(visit.at).toISOString(),
    });
  }
  return out;
}
