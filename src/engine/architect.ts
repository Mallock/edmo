/**
 * The system architect's shopping list.
 *
 * A colonisation build is a haulage problem the game states exactly once, on a
 * panel the commander can only read while docked at the site — and then never
 * again from the cockpit. The depot at HIP 71120 wants 6,721 t across seventeen
 * commodities, and the only place that list exists is inside the construction
 * contribution screen.
 *
 * Everything here is folded from the real events of that build:
 *
 *   Docked                          StationType SpaceConstructionDepot,
 *                                   services include colonisationcontribution,
 *                                   LandingPads Small 3 / Medium 11 / Large 0
 *   ColonisationConstructionDepot   ResourcesRequired[17], ConstructionProgress
 *                                   0.002678 — Steel 2542, Titanium 1525,
 *                                   Aluminium 1322, Liquid oxygen 678 …
 *   ColonisationContribution        Contributions[{Liquid oxygen 2, Water 16}]
 *   Cargo.json                      Inventory[{Name:'methaneclathrate', …}]
 *
 * The three name each commodity a different way — `$aluminium_name;` in the
 * depot, `$LiquidOxygen_name;` (capitalised!) in the contribution, plain
 * `methaneclathrate` in the hold, "Liquid oxygen" in a market. commodityKey()
 * is what lets one shopping list be built across all four.
 *
 * Pure module — unit-tested in tests/architect.test.ts.
 */
import type { JournalEvent } from './types.ts';
import type { MarketRecord } from './trade.ts';
import { rankMarketRows, reportAgeDays, STALE_DAYS, type MarketLookupRow } from './tools.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * One commodity, one key, whatever wrapper the game put around the name.
 *
 * `$aluminium_name;` (depot), `$LiquidOxygen_name;` (contribution),
 * `methaneclathrate` (Cargo.json), "Liquid oxygen" (market listing) and
 * "Fruit and Vegetables" (Ardent) must all collapse onto the same string or the
 * list silently double-counts and the hold never matches the requirement.
 */
export function commodityKey(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/^\$/, '')
    .replace(/_name;?$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** One line of the requirement, as the depot states it. */
export interface DepotResource {
  key: string;
  name: string;
  required: number;
  provided: number;
  /** Still wanted. Never negative — an over-delivered commodity is just done. */
  remaining: number;
  /** What the depot pays per ton, which is not what it costs to buy. */
  payment: number;
}

export interface DepotState {
  marketId: number;
  station: string | null;
  system: string | null;
  /** 0–1, as the game reports it (0.002678 on the first day of a build). */
  progress: number;
  complete: boolean;
  failed: boolean;
  /** ISO timestamp of the depot event this was folded from. */
  at: string;
  resources: DepotResource[];
}

/** A construction site is the only station type that asks for contributions. */
export function isConstructionDepot(ev: JournalEvent): boolean {
  const type = str(ev.StationType).toLowerCase();
  if (type.includes('constructiondepot')) return true;
  const services = Array.isArray(ev.StationServices) ? ev.StationServices : [];
  return services.some((s) => String(s).toLowerCase() === 'colonisationcontribution');
}

/**
 * DO NOT reintroduce a landing-pad check from `LandingPads`.
 *
 * The Docked event at a construction site reports its pads, and for these
 * stations it is WRONG. "Orbital Construction Site: Perga's Progress" reports
 * `{Small: 3, Medium: 11, Large: 0}` on every single docking — while the
 * commander docks there repeatedly in a Panther Clipper Mk II, a 1,046 t
 * large-pad-only hauler. Orbital construction sites take large ships.
 *
 * A warning built on that field told a commander their ship could not dock at
 * a pad they were already standing on, which is worse than saying nothing.
 *
 * @see tests/architect.test.ts — "the site's own pad count is not trusted"
 */

/**
 * Folds the depot events into one state.
 *
 * The depot event itself carries no station name — only a MarketID — so the
 * Docked event is what gives the list a place. Without pairing them the panel
 * can tell the commander what to buy but not where to bring it.
 */
export class ConstructionTracker {
  private depotState: DepotState | null = null;
  /** Where each MarketID was docked, so a depot event can be given a name. */
  private places = new Map<number, { station: string; system: string }>();

  get depot(): DepotState | null {
    return this.depotState;
  }

  /** True when this event changed the list — the caller may want to react. */
  apply(ev: JournalEvent): boolean {
    switch (ev.event) {
      case 'Docked': {
        if (!isConstructionDepot(ev)) return false;
        const marketId = num(ev.MarketID);
        if (!marketId) return false;
        this.places.set(marketId, {
          station: str(ev.StationName) || 'Construction site',
          system: str(ev.StarSystem) || '?',
        });
        // A depot event we already hold gains its name the moment we dock.
        if (this.depotState?.marketId === marketId) {
          const at = this.places.get(marketId)!;
          this.depotState = { ...this.depotState, station: at.station, system: at.system };
          return true;
        }
        return false;
      }
      case 'ColonisationConstructionDepot': {
        const marketId = num(ev.MarketID);
        const raw = Array.isArray(ev.ResourcesRequired) ? ev.ResourcesRequired : [];
        if (!marketId || !raw.length) return false;
        const resources: DepotResource[] = [];
        for (const r of raw as Array<Record<string, unknown>>) {
          const name = str(r.Name_Localised) || str(r.Name);
          const key = commodityKey(str(r.Name) || name);
          if (!key) continue;
          const required = num(r.RequiredAmount);
          const provided = num(r.ProvidedAmount);
          resources.push({
            key,
            name: name.replace(/^\$|_name;?$/g, '') || key,
            required,
            provided,
            remaining: Math.max(0, required - provided),
            payment: num(r.Payment),
          });
        }
        if (!resources.length) return false;
        const at = this.places.get(marketId);
        this.depotState = {
          marketId,
          station: at?.station ?? this.depotState?.station ?? null,
          system: at?.system ?? this.depotState?.system ?? null,
          progress: num(ev.ConstructionProgress),
          complete: ev.ConstructionComplete === true,
          failed: ev.ConstructionFailed === true,
          at: str(ev.timestamp) || new Date(0).toISOString(),
          resources,
        };
        return true;
      }
      case 'ColonisationContribution': {
        // The depot event normally follows a contribution, but not always
        // before the commander undocks and flies away — so credit the delivery
        // immediately rather than showing them a list they have already filled.
        const marketId = num(ev.MarketID);
        const given = Array.isArray(ev.Contributions) ? ev.Contributions : [];
        if (!this.depotState || this.depotState.marketId !== marketId || !given.length) return false;
        const by = new Map<string, number>();
        for (const c of given as Array<Record<string, unknown>>) {
          const key = commodityKey(str(c.Name) || str(c.Name_Localised));
          if (key) by.set(key, (by.get(key) ?? 0) + num(c.Amount));
        }
        if (!by.size) return false;
        this.depotState = {
          ...this.depotState,
          at: str(ev.timestamp) || this.depotState.at,
          resources: this.depotState.resources.map((r) => {
            const add = by.get(r.key);
            if (!add) return r;
            const provided = Math.min(r.required, r.provided + add);
            return { ...r, provided, remaining: Math.max(0, r.required - provided) };
          }),
        };
        return true;
      }
      default:
        return false;
    }
  }

  toJSON(): { depot: DepotState | null } {
    return { depot: this.depotState };
  }

  load(d: { depot?: DepotState | null } | null): void {
    if (!d?.depot || !Array.isArray(d.depot.resources)) return;
    this.depotState = d.depot;
    if (d.depot.marketId && d.depot.station && d.depot.system) {
      this.places.set(d.depot.marketId, { station: d.depot.station, system: d.depot.system });
    }
  }
}

// ------------------------------------------------------------ the shopping list

/** Where a commodity can be got, ranked into the tree. */
export interface Source {
  station: string;
  system: string;
  distanceLy: number | null;
  price: number | null;
  stock: number | null;
  pad: string | null;
  carrier: boolean;
  updatedAt?: string | null;
  /** Days since the community last saw it; null when undated. */
  ageDays: number | null;
  /** The commander read this price off the board themselves. */
  own?: boolean;
  /** Same system as the build — a haul with no jump in it. */
  inSystem?: boolean;
  /**
   * Supercruise distance from the star, when known.
   *
   * Inside one system this is the ONLY distance that matters, and it is not a
   * small difference: HIP 71120's stations run from 743 Ls to well past
   * 200,000. "No jump" does not mean "next door".
   */
  distanceLs?: number | null;
}

export type Bucket = 'deliver' | 'here' | 'system' | 'nearby' | 'unknown' | 'done';

export interface ShoppingItem {
  key: string;
  name: string;
  required: number;
  provided: number;
  remaining: number;
  payment: number;
  /** Tons of it in the hold right now. */
  inHold: number;
  /** What can be handed over on this docking without flying anywhere. */
  deliverNow: number;
  /** Best place to buy the rest, and the runners-up. */
  best: Source | null;
  alternatives: Source[];
  /** Full holds needed to shift what remains, when the capacity is known. */
  trips: number | null;
  /** A galaxy lookup has been run for this commodity. */
  scanned: boolean;
  bucket: Bucket;
  /**
   * The other lines the same stop covers.
   *
   * Crippen Reach sells both the steel and the titanium of the HIP 71120 build
   * — 4,067 t of the 6,703 t outstanding, from one pad. A per-commodity list
   * hides that completely and sends the commander back and forth.
   */
  stop: { station: string; system: string; lines: number; tons: number } | null;
}

export interface ShoppingGroup {
  bucket: Bucket;
  title: string;
  /** The one-line reason this group sits where it does. */
  hint: string;
  items: ShoppingItem[];
  /** Tons outstanding across the group. */
  tons: number;
}

export interface ShoppingInput {
  /** Commodity key → tons in the hold (from Cargo.json). */
  cargo?: ReadonlyMap<string, number>;
  /** The market at the station the commander is docked at, when there is one. */
  localMarket?: MarketRecord | null;
  /**
   * Every market the commander has actually docked at and read.
   *
   * The whole reason this exists: Ardent knows nothing about HIP 71120, because
   * a system colonised last week has never been reported to EDDN. The community
   * cannot see the commander's own build site — but the commander can, one
   * docking at a time, and those readings are both first-hand and in-system.
   */
  visited?: readonly MarketRecord[];
  /** Commodity key → galaxy rows, as scanned. A present-but-empty array means
   *  "looked, found nobody" — which is not the same as "not looked yet". */
  sources?: ReadonlyMap<string, readonly MarketLookupRow[]>;
  /** Hold size, for the trip count. */
  cargoCapacity?: number | null;
  nowMs?: number;
}

/**
 * Distance rings rather than raw light-years.
 *
 * Only ever a tie-break. Ranking a shopping list by distance puts a 9 t errand
 * thirteen light-years away above the 2,542 t of steel that IS the build —
 * which is what the first cut of this module did against the real HIP 71120
 * data. Tonnage decides; the ring separates two hauls of similar size.
 */
const ring = (ly: number | null): number =>
  ly == null ? 5 : ly <= 1 ? 0 : ly <= 20 ? 1 : ly <= 50 ? 2 : ly <= 150 ? 3 : 4;

/** Where a row would be bought, as a grouping key. */
const stopKey = (i: ShoppingItem): string =>
  i.best ? `${i.best.station} ${i.best.system}` : '';

/**
 * Order the buy list as a trip, not as an inventory.
 *
 * Commodities cluster by seller — Crippen Reach has the steel AND the titanium,
 * Hayashi Engineering Forge has the polymers, ceramics and superconductors — so
 * the useful unit of planning is the stop, not the commodity. Clusters are
 * ranked by how much of the build they clear (with distance breaking ties
 * between similar hauls), and inside a cluster the big line leads.
 */
function byStop(items: readonly ShoppingItem[]): ShoppingItem[] {
  const stops = new Map<string, ShoppingItem[]>();
  for (const i of items) {
    const k = stopKey(i);
    const at = stops.get(k);
    if (at) at.push(i);
    else stops.set(k, [i]);
  }
  const clusters = [...stops.values()].map((group) => {
    const sorted = [...group].sort((a, b) => b.remaining - a.remaining);
    return {
      items: sorted,
      tons: sorted.reduce((n, i) => n + i.remaining, 0),
      ring: Math.min(...sorted.map((i) => ring(i.best?.distanceLy ?? null))),
    };
  });
  clusters.sort((a, b) => b.tons - a.tons || a.ring - b.ring);
  return clusters.flatMap((c) => c.items);
}

const toSource = (r: MarketLookupRow, nowMs: number, home = '', own = false): Source => ({
  station: r.station,
  system: r.system,
  distanceLy: r.distanceLy,
  price: r.price,
  stock: r.stock,
  pad: r.pad,
  carrier: r.carrier,
  updatedAt: r.updatedAt ?? null,
  ageDays: reportAgeDays(r.updatedAt, nowMs),
  own,
  inSystem: !!home && r.system.toLowerCase() === home,
  // Only the whole-system sweep carries this; a nearby row has no Ls figure.
  distanceLs: (r as { distanceLs?: number | null }).distanceLs ?? null,
});

/**
 * Turn the depot requirement into an ordered plan.
 *
 * The order is the whole point. A flat alphabetical list of seventeen
 * commodities — which is what the game itself shows — tells the commander
 * nothing about what to do next, and the answer is rarely "the first one".
 * Tons already in the hold outrank everything (that is progress for free),
 * then whatever the site's own market sells, then the near cluster, and only
 * then the commodities nobody nearby stocks.
 */
export function buildShoppingList(
  depot: DepotState | null,
  input: ShoppingInput = {},
): ShoppingGroup[] {
  if (!depot) return [];
  const nowMs = input.nowMs ?? Date.now();
  const cargo = input.cargo ?? new Map<string, number>();
  const sources = input.sources ?? new Map<string, readonly MarketLookupRow[]>();
  const capacity = input.cargoCapacity && input.cargoCapacity > 0 ? input.cargoCapacity : null;

  // What the station under the ship sells, keyed the same way as everything else.
  const local = new Map<string, { price: number; stock: number }>();
  for (const i of input.localMarket?.items ?? []) {
    if (i.buy > 0 && i.stock > 0) local.set(commodityKey(i.name), { price: i.buy, stock: i.stock });
  }
  const localAt = input.localMarket
    ? { station: input.localMarket.station, system: input.localMarket.system, at: input.localMarket.at }
    : null;

  // Markets read first-hand, indexed by commodity. A station the commander has
  // stood on outranks any report about it, and in a freshly colonised system it
  // is the ONLY source of truth — Ardent has never heard of the place.
  const home = (depot.system ?? '').toLowerCase();
  const seen = new Map<string, Source[]>();
  const seenEmpty = new Set<string>();
  for (const m of input.visited ?? []) {
    const sameSystem = m.system.toLowerCase() === home;
    const stocked = new Set<string>();
    for (const i of m.items) {
      const key = commodityKey(i.name);
      if (!(i.buy > 0 && i.stock > 0)) continue;
      stocked.add(key);
      const at: Source = {
        station: m.station,
        system: m.system,
        // Inside the build's own system there is no jump to make at all; from
        // anywhere else our memory carries no light-year figure.
        distanceLy: sameSystem ? 0 : null,
        price: i.buy,
        stock: i.stock,
        pad: null,
        carrier: false,
        updatedAt: m.at,
        ageDays: reportAgeDays(m.at, nowMs),
        own: true,
        inSystem: sameSystem,
      };
      const list = seen.get(key);
      if (list) list.push(at);
      else seen.set(key, [at]);
    }
    // "I looked and it had none" is a fact about that station, and it must beat
    // a stranger's older claim that it was full.
    for (const r of depot.resources) if (!stocked.has(r.key)) seenEmpty.add(`${m.station}|${m.system}|${r.key}`);
  }

  const items: ShoppingItem[] = depot.resources.map((r) => {
    const inHold = cargo.get(r.key) ?? 0;
    const deliverNow = Math.min(inHold, r.remaining);
    const rows = sources.get(r.key);
    const scanned = rows != null;
    const here = local.get(r.key);
    const mine = seen.get(r.key) ?? [];
    // Drop community rows for stations we have read ourselves — ours is both
    // first-hand and, by definition, from the last time we were actually there.
    const mineAt = new Set(mine.map((s) => `${s.station}|${s.system}`.toLowerCase()));
    const community = (rows ?? []).filter(
      (x) =>
        !mineAt.has(`${x.station}|${x.system}`.toLowerCase()) &&
        !seenEmpty.has(`${x.station}|${x.system}|${r.key}`),
    );
    // No jump beats everything except our own eyes on the same trip: a station
    // in the build's own system is supercruise, not a route. Inside each tier
    // the usual ranking applies — can it fill the order, then price.
    const rank = (rows: MarketLookupRow[]): Source[] =>
      rankMarketRows(rows, 'buy', r.remaining || null, nowMs).map((x) => toSource(x, nowMs, home));
    const cheapest = (a: Source, b: Source): number => (a.price ?? Infinity) - (b.price ?? Infinity);
    const ranked = [
      ...mine.filter((s) => s.inSystem).sort(cheapest),
      ...rank(community.filter((x) => x.system.toLowerCase() === home)),
      ...mine.filter((s) => !s.inSystem).sort(cheapest),
      ...rank(community.filter((x) => x.system.toLowerCase() !== home)),
    ];
    // The market we are standing on beats anything a stranger reported: no
    // travel, and the price is on the board rather than days old.
    const hereSource: Source | null =
      here && localAt
        ? {
            station: localAt.station,
            system: localAt.system,
            distanceLy: 0,
            price: here.price,
            stock: here.stock,
            pad: null,
            carrier: false,
            updatedAt: localAt.at,
            ageDays: reportAgeDays(localAt.at, nowMs),
            own: true,
          }
        : null;
    const best = hereSource ?? ranked[0] ?? null;
    const bucket: Bucket =
      r.remaining <= 0
        ? 'done'
        : deliverNow > 0
          ? 'deliver'
          : hereSource
            ? 'here'
            : best?.inSystem
              ? 'system'
              : ranked.length
                ? 'nearby'
                : 'unknown';
    return {
      key: r.key,
      name: r.name,
      required: r.required,
      provided: r.provided,
      remaining: r.remaining,
      payment: r.payment,
      inHold,
      deliverNow,
      best,
      alternatives: hereSource ? ranked.slice(0, 4) : ranked.slice(1, 5),
      trips: capacity ? Math.ceil(r.remaining / capacity) : null,
      scanned,
      bucket,
      stop: null,
    };
  });

  // What else each stop covers — computed across the whole list, since the
  // point is precisely that two different lines share one pad.
  const atStop = new Map<string, ShoppingItem[]>();
  for (const i of items) {
    if (!i.best || i.remaining <= 0) continue;
    const k = stopKey(i);
    const at = atStop.get(k);
    if (at) at.push(i);
    else atStop.set(k, [i]);
  }
  for (const i of items) {
    const together = atStop.get(stopKey(i));
    if (!i.best || !together) continue;
    i.stop = {
      station: i.best.station,
      system: i.best.system,
      lines: together.length,
      tons: together.reduce((n, x) => n + x.remaining, 0),
    };
  }

  const byTons = (a: ShoppingItem, b: ShoppingItem): number => b.remaining - a.remaining;
  const groups: ShoppingGroup[] = [
    {
      bucket: 'deliver',
      title: 'In your hold — hand it over now',
      hint: 'Already bought and already here. Contribute before you fly anywhere.',
      items: items.filter((i) => i.bucket === 'deliver').sort((a, b) => b.deliverNow - a.deliverNow),
      tons: 0,
    },
    {
      bucket: 'here',
      title: 'On sale at this station',
      hint: 'Buy it where you are standing — no jump, and the price is on the board.',
      items: items.filter((i) => i.bucket === 'here').sort(byTons),
      tons: 0,
    },
    {
      bucket: 'system',
      title: `In ${depot.system ?? 'this system'} — no jump`,
      hint: 'Stations you have docked at in the build’s own system. Supercruise, not a route.',
      items: byStop(items.filter((i) => i.bucket === 'system')),
      tons: 0,
    },
    {
      bucket: 'nearby',
      title: 'Found nearby',
      hint: 'Grouped by seller — the stop that clears the most of the build first.',
      items: byStop(items.filter((i) => i.bucket === 'nearby')),
      tons: 0,
    },
    {
      bucket: 'unknown',
      title: 'No source found',
      hint: 'Nobody nearby stocks these — widen the search, or mine/refine them.',
      items: items.filter((i) => i.bucket === 'unknown').sort(byTons),
      tons: 0,
    },
    {
      bucket: 'done',
      title: 'Delivered in full',
      hint: 'Nothing left to buy.',
      items: items.filter((i) => i.bucket === 'done').sort((a, b) => b.required - a.required),
      tons: 0,
    },
  ];
  for (const g of groups) {
    g.tons = g.items.reduce((n, i) => n + (g.bucket === 'deliver' ? i.deliverNow : i.remaining), 0);
  }
  return groups.filter((g) => g.items.length);
}

// ----------------------------------------------------------------- the summary

/**
 * What the market just read covers of the build.
 *
 * Called on every Market.json the game writes, which is every docking. In a
 * newly colonised system this is the only way the list ever learns anything:
 * nobody has reported these stations to EDDN, so until the commander docks
 * there the panel cannot know the hub two hundred Ls away sells the steel.
 */
export function coversFromMarket(
  depot: DepotState | null,
  market: MarketRecord | null,
): Array<{ name: string; needed: number; price: number; stock: number }> {
  if (!depot || !market) return [];
  const wanted = new Map(depot.resources.filter((r) => r.remaining > 0).map((r) => [r.key, r]));
  const out: Array<{ name: string; needed: number; price: number; stock: number }> = [];
  for (const i of market.items) {
    if (!(i.buy > 0 && i.stock > 0)) continue;
    const r = wanted.get(commodityKey(i.name));
    if (r) out.push({ name: r.name, needed: r.remaining, price: i.buy, stock: i.stock });
  }
  return out.sort((a, b) => b.needed - a.needed);
}

/** One line for the feed when a docking turns up something the build needs. */
export function describeCoverage(
  station: string,
  covers: ReadonlyArray<{ name: string; needed: number; stock: number }>,
  inSystem: boolean,
): string | null {
  if (!covers.length) return null;
  const named = covers
    .slice(0, 3)
    .map((c) => `${c.name} (${tons(Math.min(c.needed, c.stock))} of the ${tons(c.needed)} wanted)`);
  const more = covers.length > 3 ? `, and ${covers.length - 3} more` : '';
  return `${station} sells ${named.join(', ')}${more} — ${
    inSystem ? 'and it is in the build’s own system, so no jump' : 'noted for the shopping list'
  }.`;
}

/** Tons outstanding across the whole build. */
export function tonsRemaining(depot: DepotState | null): number {
  return depot ? depot.resources.reduce((n, r) => n + r.remaining, 0) : 0;
}

/** Tons the build asked for in total. */
export function tonsRequired(depot: DepotState | null): number {
  return depot ? depot.resources.reduce((n, r) => n + r.required, 0) : 0;
}

const tons = (n: number): string => `${Math.round(n).toLocaleString('en-US')} t`;

/**
 * The spoken/feed line when the list first appears.
 *
 * Leads with what can be done this minute (cargo in the hold the site wants),
 * because that is the difference between a status report and an instruction.
 */
export function describeDepot(
  depot: DepotState | null,
  groups: readonly ShoppingGroup[],
): string | null {
  if (!depot) return null;
  if (depot.complete) return `${depot.station ?? 'The construction site'} is complete.`;
  if (depot.failed) return `${depot.station ?? 'The construction site'} has failed.`;
  const left = tonsRemaining(depot);
  if (left <= 0) return `${depot.station ?? 'The site'} has everything it asked for.`;
  const pct = Math.round(depot.progress * 1000) / 10;
  const wanted = depot.resources.filter((r) => r.remaining > 0).length;
  const head = `${depot.station ?? 'Construction site'}: ${tons(left)} still wanted across ${wanted} commodit${
    wanted === 1 ? 'y' : 'ies'
  }, ${pct}% built.`;
  const deliver = groups.find((g) => g.bucket === 'deliver');
  if (deliver?.items.length) {
    const names = deliver.items.slice(0, 3).map((i) => `${Math.round(i.deliverNow)} t of ${i.name}`);
    return `${head} You are carrying ${names.join(', ')} it wants — hand that over first.`;
  }
  const biggest = [...depot.resources].sort((a, b) => b.remaining - a.remaining)[0];
  return `${head} The long pole is ${biggest.name}, ${tons(biggest.remaining)}.`;
}

/** Rows worth putting in front of the model when it is asked about the build. */
export function architectFacts(
  depot: DepotState | null,
  groups: readonly ShoppingGroup[],
): string | null {
  if (!depot) return null;
  const lines: string[] = [];
  lines.push(
    `CONSTRUCTION: ${depot.station ?? 'site'} in ${depot.system ?? '?'} — ${Math.round(
      depot.progress * 1000,
    ) / 10}% built, ${tons(tonsRemaining(depot))} outstanding.`,
  );
  for (const g of groups) {
    if (g.bucket === 'done' || !g.items.length) continue;
    const items = g.items
      .slice(0, 6)
      .map((i) => {
        const where =
          i.bucket === 'deliver'
            ? `${Math.round(i.deliverNow)} t in your hold`
            : i.best
              ? `${i.best.station}${i.best.system !== depot.system ? ` (${i.best.system}${
                  i.best.distanceLy != null ? `, ${Math.round(i.best.distanceLy)} ly` : ''
                })` : ''}${i.best.price != null ? ` at ${i.best.price.toLocaleString('en-US')} cr` : ''}`
              : 'no source found';
        return `${i.name} ${tons(i.remaining)} — ${where}`;
      })
      .join('; ');
    lines.push(`${g.title}: ${items}.`);
  }
  const stale = groups
    .flatMap((g) => g.items)
    .filter((i) => i.best && !i.best.own && (i.best.ageDays ?? 0) > STALE_DAYS).length;
  if (stale) lines.push(`${stale} of these sources are community reports over ${STALE_DAYS} days old — may be wrong.`);
  return lines.join('\n');
}
