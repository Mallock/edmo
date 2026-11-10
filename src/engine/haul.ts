/**
 * The next load, spelled out — and how long the whole build has left.
 *
 * The shopping list says what the build wants and where it is sold. It stops
 * one step short of the question the commander actually asks at the pad, which
 * is "what do I put in the hold RIGHT NOW". Seventeen lines and a 784 t Panther
 * do not divide neatly: some lines are bigger than the ship, some are 12 t
 * errands, and the stop that sells four of them only has 300 t of one.
 *
 * So `planTrip` does the arithmetic the commander was doing on a notepad:
 * pick the stop that fills the most hold, then fill the hold, line by line,
 * against what that stop actually has in stock.
 *
 * And `haulClock` answers the other one. "20,464 t still wanted" is a number
 * without a horizon. Measured against the tonnage this commander has actually
 * been shifting — from their own ColonisationContribution history, not a
 * guess — it becomes "about nine hours of hauling", which is a thing a person
 * can plan an evening around.
 *
 * Pure module — unit-tested in tests/haul.test.ts.
 */
import type { JournalEvent } from './types.ts';
import { commodityKey, type ShoppingGroup, type ShoppingItem, type Source } from './architect.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ------------------------------------------------------------- the trip manifest

/** One commodity on one load. */
export interface ManifestLine {
  key: string;
  name: string;
  /** Tons to put aboard this trip. */
  tons: number;
  /** Unit buy price, when it is known. Null on a carrier shuttle. */
  price: number | null;
  /** Tons the stop is reported to hold, for the "it may be short" case. */
  stock: number | null;
  /** True when this load finishes the line for good. */
  closes: boolean;
}

/** Where a load comes from: a market, or the commander's own carrier. */
export type TripSource = 'market' | 'carrier';

export interface TripPlan {
  source: TripSource;
  station: string;
  system: string;
  inSystem: boolean;
  distanceLy: number | null;
  distanceLs: number | null;
  pad: string | null;
  lines: ManifestLine[];
  /** Tons this load puts in the hold. Never more than capacity. */
  tons: number;
  /** Hold capacity the plan was cut to. */
  capacity: number;
  /** Credits, when every line on the load had a price. Null on a shuttle. */
  cost: number | null;
  /** True when a price was missing and `cost` is therefore an under-count. */
  costPartial: boolean;
  /** Tons this stop could still supply after this load. */
  moreHere: number;
  /** Full loads this one stop is worth, this one included. */
  loadsHere: number;
}

/** A stop's candidate lines, before the hold is cut to size. */
interface StopCandidate {
  source: TripSource;
  station: string;
  system: string;
  inSystem: boolean;
  distanceLy: number | null;
  distanceLs: number | null;
  pad: string | null;
  /** Item, and tons of it this stop can actually supply. */
  rows: Array<{ item: ShoppingItem; available: number; price: number | null; stock: number | null }>;
}

/** Distance ring, matching the shopping list's — a tie-break, never a ranking. */
const ring = (ly: number | null): number =>
  ly == null ? 5 : ly <= 1 ? 0 : ly <= 20 ? 1 : ly <= 50 ? 2 : ly <= 150 ? 3 : 4;

export interface TripInput {
  /** Hold size. Without it there is no trip to plan. */
  capacity: number | null | undefined;
  /**
   * Tons already in the hold, so the plan fills the SPACE LEFT.
   *
   * A commander sitting on 300 t of steel bound for the site does not want a
   * 784 t manifest; they want the 484 t that will actually fit beside it.
   */
  holdUsed?: number | null;
  /** Where the carrier is parked, for the shuttle option. */
  carrierSystem?: string | null;
  carrierName?: string | null;
  /** The build's system — a stop here needs no jump. */
  depotSystem?: string | null;
}

/**
 * The best next load, or null when there is nothing to fetch.
 *
 * Stops are ranked by how much of the hold they can fill, not by how much they
 * stock in total: a depot 40 ly away with 9,000 t of steel and a station in
 * this system with 900 t are the same trip to a 784 t hauler, and the near one
 * wins. Only once two stops fill the hold equally does distance decide.
 *
 * A carrier parked in the build's own system beats every market, because the
 * tons are bought already — the trip costs fuel and minutes rather than tens
 * of millions of credits.
 */
export function planTrip(groups: readonly ShoppingGroup[], input: TripInput): TripPlan | null {
  const capacity = input.capacity && input.capacity > 0 ? Math.floor(input.capacity) : 0;
  if (!capacity) return null;
  const free = Math.max(0, capacity - Math.max(0, Math.floor(input.holdUsed ?? 0)));
  if (free <= 0) return null;

  const items = groups.flatMap((g) => g.items);
  const home = (input.depotSystem ?? '').toLowerCase();
  const carrierSystem = (input.carrierSystem ?? '').toLowerCase();
  const stops = new Map<string, StopCandidate>();

  // The carrier shuttle, when the carrier is parked where the build is. Out of
  // system it is not a trip at all — it is a carrier jump, and the panel says
  // so elsewhere rather than pretending a 300 ly haul is a load-out.
  const shuttle = items.filter((i) => i.onCarrier > 0 && i.remaining > 0);
  if (shuttle.length && carrierSystem && home && carrierSystem === home) {
    stops.set('|carrier', {
      source: 'carrier',
      station: input.carrierName ?? 'your fleet carrier',
      system: input.carrierSystem ?? '',
      inSystem: true,
      distanceLy: 0,
      distanceLs: null,
      pad: 'L',
      rows: shuttle.map((item) => ({
        item,
        available: Math.min(item.onCarrier, item.remaining),
        price: null,
        stock: item.onCarrier,
      })),
    });
  }

  for (const item of items) {
    if (item.toBuy <= 0 || !item.best) continue;
    const s = item.best;
    const key = `${s.station}|${s.system}`;
    // An unreported stock figure is not zero — it means nobody said. Treat it
    // as "enough", and let the manifest carry the caveat rather than silently
    // dropping a line the station probably does have.
    const available = Math.min(item.toBuy, s.stock ?? item.toBuy);
    if (available <= 0) continue;
    const at = stops.get(key);
    const row = { item, available, price: s.price, stock: s.stock };
    if (at) at.rows.push(row);
    else
      stops.set(key, {
        source: 'market',
        station: s.station,
        system: s.system,
        inSystem: !!s.inSystem,
        distanceLy: s.distanceLy,
        distanceLs: s.distanceLs ?? null,
        pad: s.pad,
        rows: [row],
      });
  }
  if (!stops.size) return null;

  const scored = [...stops.values()].map((c) => {
    const supply = c.rows.reduce((n, r) => n + r.available, 0);
    return { c, supply, fills: Math.min(free, supply) };
  });
  scored.sort(
    (a, b) =>
      // A free load beats a bought one of the same size, every time.
      Number(b.c.source === 'carrier') - Number(a.c.source === 'carrier') ||
      b.fills - a.fills ||
      Number(b.c.inSystem) - Number(a.c.inSystem) ||
      ring(a.c.distanceLy) - ring(b.c.distanceLy) ||
      b.supply - a.supply,
  );
  const pick = scored[0];
  const { c } = pick;

  // Fill the hold biggest line first. The long pole is what the build is
  // waiting on, and a hold spent on 12 t errands is a trip that changed
  // nothing.
  const rows = [...c.rows].sort((a, b) => b.available - a.available);
  const lines: ManifestLine[] = [];
  let left = free;
  let cost = 0;
  let costPartial = false;
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(r.available, left);
    if (take <= 0) continue;
    left -= take;
    if (r.price != null) cost += take * r.price;
    else if (c.source === 'market') costPartial = true;
    lines.push({
      key: r.item.key,
      name: r.item.name,
      tons: take,
      price: r.price,
      stock: r.stock,
      // Closing a line is worth marking: it is the only kind of progress that
      // shortens the list rather than shortening a bar.
      closes: take >= r.item.toBuy && (c.source === 'market' || take >= r.item.remaining),
    });
  }
  const loaded = free - left;
  if (loaded <= 0) return null;
  return {
    source: c.source,
    station: c.station,
    system: c.system,
    inSystem: c.inSystem,
    distanceLy: c.distanceLy,
    distanceLs: c.distanceLs,
    pad: c.pad,
    lines,
    tons: loaded,
    capacity,
    cost: c.source === 'carrier' ? null : Math.round(cost),
    costPartial,
    moreHere: Math.max(0, pick.supply - loaded),
    loadsHere: Math.max(1, Math.ceil(pick.supply / capacity)),
  };
}

/** The manifest as one spoken line. */
export function describeTrip(plan: TripPlan | null): string | null {
  if (!plan || !plan.lines.length) return null;
  const parts = plan.lines
    .slice(0, 4)
    .map((l) => `${Math.round(l.tons).toLocaleString('en-US')} t of ${l.name}`);
  const more = plan.lines.length > 4 ? `, and ${plan.lines.length - 4} more` : '';
  const where =
    plan.source === 'carrier'
      ? `off ${plan.station}`
      : `at ${plan.station}${plan.inSystem ? '' : ` in ${plan.system}`}`;
  const money =
    plan.source === 'carrier'
      ? ' — already paid for'
      : plan.cost
        ? ` — about ${Math.round(plan.cost / 1_000_000)} million credits`
        : '';
  return `Next load ${where}: ${parts.join(', ')}${more}${money}.`;
}

// ---------------------------------------------------------------- the whole run

/** One line of a stop's shopping list. */
export interface StopLine {
  key: string;
  name: string;
  /** Tons this stop can supply against what is still to buy. */
  tons: number;
  price: number | null;
  /** True when the stop cannot cover the whole line on its own. */
  short: boolean;
}

/** Everything one station can sell this build, in one visit. */
export interface StopPlan {
  station: string;
  system: string;
  inSystem: boolean;
  distanceLy: number | null;
  jumps: number | null;
  pad: string | null;
  carrier: boolean;
  lines: StopLine[];
  /** Tons of the outstanding requirement this stop can supply. */
  tons: number;
  /** Credits for all of it, when every line had a price. */
  cost: number | null;
  /** Full holds, at the ship's capacity. */
  loads: number | null;
  /** Share of everything still to buy, 0–1. */
  share: number;
}

export interface StopInput {
  capacity?: number | null;
  /** Most stops worth listing. Beyond a handful it stops being a plan. */
  limit?: number;
}

/**
 * The shopping run, by STOP rather than by commodity.
 *
 * The tree answers "where do I get titanium" seventeen times. It cannot answer
 * the question a commander actually has in front of the galaxy map, which is
 * "where do I go, and what do I buy when I get there" — and working that out
 * from the tree means opening every line in turn and keeping the overlaps in
 * your head.
 *
 * So this inverts it: every station we know of, with everything it can sell
 * this build in one visit. Gustard Watch turns out to cover eight of the
 * seventeen lines by itself, which is a fact the per-commodity view contains
 * and never states.
 *
 * Built from EVERY source on each line, not just the best one. A station that
 * is second-choice for six commodities can still be the best single trip, and
 * grouping only by the winner hides exactly that.
 */
export function stopPlans(groups: readonly ShoppingGroup[], input: StopInput = {}): StopPlan[] {
  const capacity = input.capacity && input.capacity > 0 ? input.capacity : null;
  const items = groups.flatMap((g) => g.items).filter((i) => i.toBuy > 0);
  const outstanding = items.reduce((n, i) => n + i.toBuy, 0);
  if (!outstanding) return [];

  const stops = new Map<string, { at: Source; lines: Map<string, StopLine> }>();
  for (const item of items) {
    const seen = item.best ? [item.best, ...item.alternatives] : item.alternatives;
    for (const s of seen) {
      const key = `${s.station.toLowerCase()}|${s.system.toLowerCase()}`;
      const tons = Math.min(item.toBuy, s.stock ?? item.toBuy);
      if (tons <= 0) continue;
      let stop = stops.get(key);
      if (!stop) {
        stop = { at: s, lines: new Map() };
        stops.set(key, stop);
      }
      // One line per commodity per stop: the first source we meet is the
      // best-ranked one, so a second listing for the same pad adds nothing.
      if (stop.lines.has(item.key)) continue;
      stop.lines.set(item.key, {
        key: item.key,
        name: item.name,
        tons,
        price: s.price,
        short: tons < item.toBuy,
      });
    }
  }

  const plans: StopPlan[] = [...stops.values()].map(({ at, lines }) => {
    const rows = [...lines.values()].sort((a, b) => b.tons - a.tons);
    const tons = rows.reduce((n, l) => n + l.tons, 0);
    const priced = rows.every((l) => l.price != null);
    return {
      station: at.station,
      system: at.system,
      inSystem: !!at.inSystem,
      distanceLy: at.distanceLy,
      jumps: at.jumps ?? null,
      pad: at.pad,
      carrier: at.carrier,
      lines: rows,
      tons,
      cost: priced ? Math.round(rows.reduce((n, l) => n + l.tons * (l.price ?? 0), 0)) : null,
      loads: capacity ? Math.ceil(tons / capacity) : null,
      share: tons / outstanding,
    };
  });

  // Most of the build cleared first — that is the whole question being asked.
  // Distance breaks ties, and is shown on every row so a long haul for a
  // marginal gain is visible rather than implied.
  plans.sort(
    (a, b) =>
      b.tons - a.tons ||
      (a.distanceLy ?? Infinity) - (b.distanceLy ?? Infinity) ||
      (a.cost ?? Infinity) - (b.cost ?? Infinity),
  );
  return plans.slice(0, Math.max(1, input.limit ?? 6));
}

// ------------------------------------------------------------- shopping here

/**
 * What has been bought at the pad the ship is standing on.
 *
 * The run says "Cleaver City: 2,070 t of steel, 371 t of water, 13 t of
 * medical equipment, 8 t of titanium". A 1,302 t hold does not take that in one
 * go, the commodities market shows one commodity at a time, and the commander
 * was keeping the difference in their head across two trips.
 *
 * So the purchases are counted. Reset on every docking, because a basket is
 * about THIS visit: what is still on the list is computed live from the build,
 * and this is the other half — what has already gone in.
 */
export class PurchaseLog {
  private marketId: number | null = null;
  private bought = new Map<string, number>();

  /** The market these purchases belong to, or null before any docking. */
  get at(): number | null {
    return this.marketId;
  }

  /** Commodity key → tons bought here since arriving. */
  get tons(): ReadonlyMap<string, number> {
    return this.bought;
  }

  apply(ev: JournalEvent): boolean {
    switch (ev.event) {
      case 'Docked': {
        const id = num(ev.MarketID);
        // Re-docking at the SAME market continues the same basket: the
        // commander undocks to shuffle cargo and comes straight back.
        if (!id || id === this.marketId) return false;
        this.marketId = id;
        this.bought.clear();
        return true;
      }
      case 'Undocked':
        return false;
      case 'MarketBuy':
      case 'MarketSell': {
        if (this.marketId == null || num(ev.MarketID) !== this.marketId) return false;
        const key = commodityKey(str(ev.Type));
        const count = num(ev.Count);
        if (!key || count <= 0) return false;
        // Selling back at the same pad is a correction, not a purchase.
        const sign = ev.event === 'MarketBuy' ? 1 : -1;
        const next = Math.max(0, (this.bought.get(key) ?? 0) + sign * count);
        this.bought.set(key, next);
        return true;
      }
      default:
        return false;
    }
  }
}

/**
 * Anything a basket can be built from: a stop on the run, or the pad itself.
 *
 * `StopPlan` satisfies this structurally, which is how the run's entry is used
 * when there is one — but a basket must NOT depend on the station placing in
 * the run's top few. The commander is standing on this pad; that it is only
 * the ninth-best stop in the galaxy does not make the list in front of them
 * less real.
 */
export interface StopLike {
  station: string;
  system: string;
  lines: ReadonlyArray<{ key: string; name: string; tons: number }>;
}

/**
 * The build's shopping list for the station under the ship, from its own board.
 *
 * Works at ANY station whose commodities market has been read — which the game
 * writes the moment the commander opens it. No ranking, no cap, no need for the
 * place to be one of the run's best stops.
 *
 * `sells` is commodity key → tons in stock, straight off Market.json.
 */
export function stopHere(
  station: string,
  system: string,
  sells: ReadonlyMap<string, number>,
  groups: readonly ShoppingGroup[],
): StopLike | null {
  if (!station) return null;
  const lines: Array<{ key: string; name: string; tons: number }> = [];
  for (const item of groups.flatMap((g) => g.items)) {
    if (item.toBuy <= 0) continue;
    const stock = sells.get(item.key);
    if (stock == null || stock <= 0) continue;
    // Never more than the board actually holds, and never more than the build
    // still wants — the same cap the run applies.
    lines.push({ key: item.key, name: item.name, tons: Math.min(item.toBuy, stock) });
  }
  if (!lines.length) return null;
  lines.sort((a, b) => b.tons - a.tons);
  return { station, system, lines };
}

/** One line of the basket at the pad. */
export interface BasketLine {
  key: string;
  name: string;
  /** Tons of it bought here on this visit. */
  bought: number;
  /** Tons this stop should still supply. */
  left: number;
  /** What the visit set out to buy — bought plus left. */
  wanted: number;
  /**
   * Tons of it already sitting on the commander's own carrier.
   *
   * Never part of `left` — the requirement nets carrier stock out before this
   * sees it. Shown because a line that is small for that reason looks exactly
   * like a line that is small because the build barely wants it, and at the
   * commodities market those are very different facts.
   */
  onCarrier: number;
  done: boolean;
}

export interface Basket {
  station: string;
  system: string;
  lines: BasketLine[];
  bought: number;
  left: number;
  wanted: number;
  /** Tons across these lines already on the commander's carrier. */
  onCarrier: number;
  /** Nothing left for this stop to give. */
  complete: boolean;
}

/**
 * The shopping list for the pad under the ship, with what is already in.
 *
 * `left` comes from the live requirement, which nets off the hold as it fills,
 * and `bought` from the purchase log — so the two always add up to what the
 * visit set out to buy and neither double-counts the other.
 */
export function basketAt(
  stop: StopLike | null | undefined,
  bought: ReadonlyMap<string, number>,
  onCarrier: ReadonlyMap<string, number> = new Map(),
): Basket | null {
  if (!stop) return null;
  const keys = new Set([...stop.lines.map((l) => l.key), ...bought.keys()]);
  const named = new Map(stop.lines.map((l) => [l.key, l.name]));
  const lines: BasketLine[] = [];
  for (const key of keys) {
    const left = stop.lines.find((l) => l.key === key)?.tons ?? 0;
    const got = bought.get(key) ?? 0;
    // A commodity bought here that this build never wanted is not a line.
    if (left <= 0 && got <= 0) continue;
    if (left <= 0 && !named.has(key)) continue;
    lines.push({
      key,
      name: named.get(key) ?? key,
      bought: got,
      left,
      wanted: got + left,
      onCarrier: onCarrier.get(key) ?? 0,
      done: left <= 0,
    });
  }
  if (!lines.length) return null;
  // Unfinished first — the list is a thing to work down, not a report.
  lines.sort((a, b) => Number(a.done) - Number(b.done) || b.left - a.left);
  return {
    station: stop.station,
    system: stop.system,
    lines,
    bought: lines.reduce((n, l) => n + l.bought, 0),
    left: lines.reduce((n, l) => n + l.left, 0),
    wanted: lines.reduce((n, l) => n + l.wanted, 0),
    onCarrier: lines.reduce((n, l) => n + l.onCarrier, 0),
    complete: lines.every((l) => l.done),
  };
}

/** One line when a commodity is finished at this pad, or null while it is not. */
export function describeBasketLine(before: Basket | null, after: Basket | null): string | null {
  if (!after) return null;
  const wasDone = new Set((before?.lines ?? []).filter((l) => l.done).map((l) => l.key));
  const justDone = after.lines.filter((l) => l.done && l.bought > 0 && !wasDone.has(l.key));
  if (!justDone.length) return null;
  const names = justDone.map((l) => l.name);
  const rest = after.lines.filter((l) => !l.done);
  const head = `${names.join(' and ')} done at ${after.station}.`;
  if (!rest.length) return `${head} That is everything this stop can give you.`;
  const next = rest[0];
  return `${head} Still here: ${Math.round(next.left).toLocaleString('en-US')} t of ${next.name}${
    rest.length > 1 ? ` and ${rest.length - 1} more` : ''
  }.`;
}

// ------------------------------------------------------------------- the cart

/** One commodity, measured against what the cart still has to gather. */
export interface CartLine {
  key: string;
  name: string;
  /** Tons the build still wants delivered. */
  needed: number;
  /** Tons of it on the carrier. */
  onCarrier: number;
  /** Tons of it in the ship's hold. */
  inHold: number;
  /** Tons nobody has yet — what is still to be bought. */
  missing: number;
  done: boolean;
}

export interface Cart {
  /** Every outstanding line, unfinished first. */
  lines: CartLine[];
  needed: number;
  onCarrier: number;
  inHold: number;
  missing: number;
  linesDone: number;
  ofLines: number;
  /** Everything the build still wants is gathered. Nothing left to buy. */
  complete: boolean;
}

/**
 * The carrier as a shopping trolley: what is in it, and what is still missing.
 *
 * A deep-space build is gathered before it is delivered. The commander buys
 * across several stations, transfers each load to the carrier, and only when
 * the carrier holds the WHOLE requirement does jumping it 464 ly make sense —
 * a carrier jumped one commodity short is a carrier that has to come back.
 *
 * Every other view here answers "what next". This one answers the question
 * asked at the end of an evening: is the cart full, or did I miss something.
 *
 * `missing` is `toBuy`, which already nets off both the hold and the carrier,
 * so the three columns never double-count each other.
 */
export function cartStatus(groups: readonly ShoppingGroup[]): Cart {
  const items = groups.flatMap((g) => g.items).filter((i) => i.remaining > 0);
  const lines: CartLine[] = items.map((i) => ({
    key: i.key,
    name: i.name,
    needed: i.remaining,
    onCarrier: i.onCarrier,
    inHold: i.inHold,
    missing: i.toBuy,
    done: i.toBuy <= 0,
  }));
  // The work to do leads; what is gathered sinks. Biggest gap first.
  lines.sort((a, b) => Number(a.done) - Number(b.done) || b.missing - a.missing);
  const sum = (pick: (l: CartLine) => number): number => lines.reduce((n, l) => n + pick(l), 0);
  return {
    lines,
    needed: sum((l) => l.needed),
    onCarrier: sum((l) => l.onCarrier),
    inHold: sum((l) => l.inHold),
    missing: sum((l) => l.missing),
    linesDone: lines.filter((l) => l.done).length,
    ofLines: lines.length,
    complete: lines.length > 0 && lines.every((l) => l.done),
  };
}

/**
 * The cart in one line — and the moment it is full is the one that matters.
 *
 * `carrier` names the ship so the answer is about a real thing the commander
 * owns; `destination` is where it has to go, because "you have everything" and
 * "so jump it to Floanth PW-G b16-3" are one thought.
 */
export function describeCart(
  cart: Cart,
  carrier: string | null,
  destination: string | null,
): string | null {
  if (!cart.ofLines) return null;
  const who = carrier ?? 'your carrier';
  const tons = (n: number): string => `${Math.round(n).toLocaleString('en-US')} t`;
  if (cart.complete) {
    const where = destination ? ` Jump it to ${destination} and shuttle it in.` : '';
    return `${who} has the whole of what this build still wants — ${tons(cart.needed)} across ${
      cart.ofLines
    } commodit${cart.ofLines === 1 ? 'y' : 'ies'}. Nothing left to buy.${where}`;
  }
  const short = cart.lines.filter((l) => !l.done);
  const named = short.slice(0, 3).map((l) => `${tons(l.missing)} of ${l.name}`);
  const more = short.length > 3 ? `, and ${short.length - 3} more` : '';
  return `${cart.linesDone} of ${cart.ofLines} lines gathered. Still to buy: ${named.join(', ')}${more}.`;
}

/** Said once, when the last missing line is finally covered. */
export function describeCartFilled(
  before: Cart | null,
  after: Cart,
  carrier: string | null,
  destination: string | null,
): string | null {
  if (!after.complete || before?.complete) return null;
  return describeCart(after, carrier, destination);
}

// ---------------------------------------------------------------- the haul clock

/** One delivery, as the game reported it. */
export interface Delivery {
  /** Epoch ms of the contribution. */
  at: number;
  marketId: number;
  tons: number;
}

/**
 * A gap longer than this is not hauling — it is sleep.
 *
 * Averaging tonnage over wall-clock time turns "1,400 t/hr while flying" into
 * "90 t/hr" the moment the commander goes to bed, and an ETA built on that is
 * worse than none. Only the gaps between deliveries that plausibly belong to
 * one sitting are counted.
 */
const SESSION_GAP_MS = 3 * 60 * 60 * 1000;

/** How long a delivery run is assumed to have taken when it is the only one. */
const LONE_RUN_MS = 20 * 60 * 1000;

export interface HaulClockReading {
  /** Deliveries recorded against this site. */
  runs: number;
  /** Tons handed over across them. */
  tonsDelivered: number;
  /** Tons per hour of actual hauling, or null with too little history. */
  tonsPerHour: number | null;
  /** Hours of hauling left at that rate, for the tonnage still wanted. */
  hoursLeft: number | null;
  /** Average tons per delivery — the real load size, not the hold size. */
  tonsPerRun: number | null;
  /** Epoch ms of the most recent delivery. */
  lastAt: number | null;
}

/**
 * Tonnage per hour of hauling, from what this commander has actually done.
 *
 * Deliberately measured between contributions rather than from the first to
 * the last: a build worked on across four evenings has three overnight gaps in
 * it, and counting those as hauling time understates the rate by an order of
 * magnitude.
 */
export function haulClock(
  deliveries: readonly Delivery[],
  tonsOutstanding: number,
  marketId?: number | null,
): HaulClockReading {
  const rows = (marketId ? deliveries.filter((d) => d.marketId === marketId) : deliveries)
    .filter((d) => d.tons > 0 && Number.isFinite(d.at))
    .sort((a, b) => a.at - b.at);
  const runs = rows.length;
  const tonsDelivered = rows.reduce((n, d) => n + d.tons, 0);
  if (!runs) {
    return { runs: 0, tonsDelivered: 0, tonsPerHour: null, hoursLeft: null, tonsPerRun: null, lastAt: null };
  }
  const lastAt = rows[rows.length - 1].at;
  const tonsPerRun = tonsDelivered / runs;
  // The first delivery has no gap before it, so it is credited a nominal run
  // length — otherwise a two-delivery history reads as infinite throughput.
  let activeMs = LONE_RUN_MS;
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].at - rows[i - 1].at;
    activeMs += gap > 0 && gap <= SESSION_GAP_MS ? gap : LONE_RUN_MS;
  }
  const tonsPerHour = activeMs > 0 ? (tonsDelivered / activeMs) * 3_600_000 : null;
  const hoursLeft =
    tonsPerHour && tonsPerHour > 0 && tonsOutstanding > 0 ? tonsOutstanding / tonsPerHour : null;
  return { runs, tonsDelivered, tonsPerHour, hoursLeft, tonsPerRun, lastAt };
}

/** The clock as one line, or null when there is not enough history to mean it. */
export function describeHaulClock(c: HaulClockReading, tonsOutstanding: number): string | null {
  // Two deliveries is one interval, which is not a rate — it is an anecdote.
  if (c.runs < 3 || c.tonsPerHour == null || c.hoursLeft == null) return null;
  const rate = Math.round(c.tonsPerHour).toLocaleString('en-US');
  const left = Math.round(tonsOutstanding).toLocaleString('en-US');
  const hours = c.hoursLeft;
  const tenths = Math.round(hours * 10) / 10;
  const span =
    hours < 1
      ? `${Math.max(5, Math.round(hours * 60))} minutes`
      : hours < 10
        // "about 1 hours of hauling" is what rounding 1.038 gave, and it read
        // as a typo in the one line of the panel a commander reads every run.
        ? `${tenths} hour${tenths === 1 ? '' : 's'}`
        : `${Math.round(hours)} hours`;
  return `${left} t left — about ${span} of hauling, at the ${rate} t/hr you have been running.`;
}

/**
 * The delivery history, folded from the commander's own contributions.
 *
 * Kept apart from `ConstructionTracker` on purpose: that class holds the
 * requirement, which the game restates in full on every docking and which can
 * therefore be thrown away safely. This is the opposite — a log that exists
 * nowhere else and cannot be rebuilt once it is lost.
 */
export class HaulLog {
  private rows: Delivery[] = [];

  /** Newest last. */
  get all(): readonly Delivery[] {
    return this.rows;
  }

  apply(ev: JournalEvent): boolean {
    if (ev.event !== 'ColonisationContribution') return false;
    const marketId = num(ev.MarketID);
    const given = Array.isArray(ev.Contributions) ? (ev.Contributions as Array<Record<string, unknown>>) : [];
    if (!marketId || !given.length) return false;
    let tons = 0;
    for (const c of given) {
      if (!commodityKey(str(c.Name) || str(c.Name_Localised))) continue;
      tons += num(c.Amount);
    }
    if (tons <= 0) return false;
    const at = Date.parse(str(ev.timestamp));
    if (!Number.isFinite(at)) return false;
    // A journal replay re-reads events we already folded. Same site, same
    // instant, same tonnage is the same delivery — not a second one.
    if (this.rows.some((d) => d.at === at && d.marketId === marketId && d.tons === tons)) return false;
    this.rows.push({ at, marketId, tons });
    this.rows.sort((a, b) => a.at - b.at);
    if (this.rows.length > 500) this.rows = this.rows.slice(-500);
    return true;
  }

  toJSON(): { deliveries: Delivery[] } {
    return { deliveries: this.rows };
  }

  load(d: { deliveries?: Delivery[] } | null): void {
    if (!d || !Array.isArray(d.deliveries)) return;
    for (const row of d.deliveries) {
      if (!row || typeof row !== 'object') continue;
      const at = num(row.at);
      const marketId = num(row.marketId);
      const tons = num(row.tons);
      if (!at || !marketId || tons <= 0) continue;
      this.rows.push({ at, marketId, tons });
    }
    this.rows.sort((a, b) => a.at - b.at);
  }
}
