/**
 * Operator tool loop — the agentic layer that lets the LLM READ live game
 * state instead of guessing. Every tool resolves against data the app already
 * folds from the journal/snapshots (markets, ship, missions, status…); only
 * `plan_trade_route` reaches the network (Spansh), and only when asked.
 *
 * This module is pure: `TOOL_SCHEMAS` is the OpenAI tool manifest, and
 * `runTool` dispatches a single call against a `ToolContext` the store fills
 * from its trackers. Kept side-effect-free (except the injected `planRoute`)
 * so the whole surface is unit-testable with a mock context.
 */
import type { MarketMemory, MarketRecord } from './trade.ts';
import { shipRequiresLargePad, type ShipLoadout } from './ship.ts';
import type { Mission } from './types.ts';
import type { TradeRoute } from './spansh.ts';
import { DEFAULT_FILTERS, describeTradeFind, resolveOrigin, type TradeFind } from './traderoute.ts';

/** Everything the tools can read. The store builds this per question. */
export interface ToolContext {
  system: string; // current system ('unknown' when not yet known)
  station: string | null; // docked station name, if docked
  markets: MarketMemory;
  ship: ShipLoadout | null;
  shipDescription: string | null; // describeShip(ship), precomputed
  liveCargo?: number; // tons currently in the hold (Cargo.json), if known
  statusLine: string | null; // live telemetry summary (fuel/legal/mode)
  missions: Mission[]; // active missions
  materialsLine: string | null;
  exploreLine: string | null;
  systemIntelLine: string | null; // security/factions/stations here
  /** Spansh route from the current station; injected so tools stay pure. */
  planRoute: (opts: { maxHops: number; requiresLargePad: boolean }) => Promise<TradeRoute | null>;
  /**
   * Inara-style single-leg search around the current system (opt-in; null when
   * the community-data toggle is off). Finds the best buy→sell pair rather than
   * a closed loop, which is what actually turns up a run most of the time.
   */
  findTradeRun:
    | ((opts: {
        origin: string;
        /** Station the commander is docked at, or '' when in space. */
        atStation: string;
        /** Where they are heading, when they named it; '' for an open search. */
        destination: string;
        maxDistanceLy: number;
        minVolume: number;
        minPad: number;
        cargo: number;
      }) => Promise<TradeFind>)
    | null;
  /** Galaxy-wide market lookup (Ardent Insight, EDDN data). Injected the same
   *  way; null when the commander has not opted in. */
  galaxyMarket:
    | ((commodity: string, side: 'buy' | 'sell', nearSystem: string) => Promise<
        Array<{
          station: string; system: string; distanceLy: number | null; price: number | null;
          stock: number | null; demand: number | null; pad: string | null; carrier: boolean;
          /** ISO date the community last saw this market. */
          updatedAt?: string | null;
        }>
      >)
    | null;
  /**
   * Tons of a commodity the commander is currently short of, or null when
   * nothing is asking for it.
   *
   * Exists because "where is tritium cheapest" is never really the question —
   * the question is where to buy the 4,865 t a plotted carrier route needs, and
   * a seller holding 3,557 t is the wrong answer at any price. Without this the
   * operator recommended exactly that carrier.
   */
  commodityNeed?: (commodity: string) => number | null;
  /** Station-type signals honked in the CURRENT system — how a carrier's
   *  callsign is resolved to the name the nav panel shows. */
  systemSignals?: ReadonlyArray<{ name: string; isStation?: boolean }>;
  /** Stations that have already refused this commander docking, so a lookup
   *  never sends them back to a door they know is shut. */
  dockingDenied?: (station: string, system: string) => string | null;
  /** Galnet news wire (opt-in): recent in-universe headlines, on demand. */
  galnetNews: (() => Promise<Array<{ title: string; date: string; lead: string }>>) | null;
  /** EDAstro exploration catalogue (opt-in): what others have logged in a system. */
  systemSurvey:
    | ((name: string) => Promise<{
        system: string; bodyCount: number | null; landablePlanets: number;
        earthLikes: number | null; waterWorlds: number | null; ammoniaWorlds: number | null;
        terraformables: number | null;
        bodiesWithOrganics: Array<{ body: string; subType: string | null; distanceLs: number | null; species: string[] }>;
      }>)
    | null;
}

/** OpenAI-style tool manifest advertised to the model. */
export const TOOL_SCHEMAS = [
  fn('get_current_market', 'List the commodities, prices, stock and demand at the station the commander is currently docked at (or the most recently visited market). Use this to answer what is for sale/profitable HERE before suggesting anything.'),
  fn(
    'find_commodity',
    'Search ONLY the markets the commander has personally docked at this session, cheapest-buy / highest-sell first. It cannot see anywhere they have not been, and it cannot be pointed at another system — for that, use find_market_in_galaxy.',
    {
      commodity: { type: 'string', description: 'Commodity name, e.g. "Gold", "Bauxite".' },
      side: { type: 'string', enum: ['buy', 'sell'], description: 'buy = where to purchase it; sell = where to offload it.' },
    },
    ['commodity', 'side'],
  ),
  fn(
    'find_market_in_galaxy',
    'Find where to BUY or SELL a commodity, and HOW MUCH is in stock or demanded there, from community market data covering the whole galaxy. Answers "where is X cheapest", "who buys X", and "how much X has SYSTEM got". Use this whenever a system is NAMED, or whenever the commander has not personally visited the place in question — which is most of the time. Prices can be hours old and fleet carriers move.',
    {
      commodity: { type: 'string', description: 'Commodity name, e.g. "Tritium", "Gold".' },
      side: { type: 'string', enum: ['buy', 'sell'], description: 'buy = where to purchase it; sell = where to offload it.' },
      system: {
        type: 'string',
        description:
          'Search around this system when the commander names one — "how much tritium has Luchtaine got", "who buys gold near Colonia". Omit to search around where they are now.',
      },
    },
    ['commodity', 'side'],
  ),
  fn(
    'get_galnet_news',
    'Fetch the latest Galnet news — the in-universe wire. Use ONLY when the commander asks what is happening in the galaxy / for news. These are galaxy-wide stories, NOT things the commander did or places they have been.',
  ),
  fn(
    'survey_system',
    'Look up what other commanders have already catalogued in a star system: notable worlds and, importantly, which bodies have REPORTED BIOLOGICAL life and which species. Use when asked whether a system is worth visiting for exploration or exobiology. An empty result means nobody has logged it yet — NOT that the system is barren (and it may still be worth a first-footfall bonus).',
    {
      system: {
        type: 'string',
        description:
          'The system name EXACTLY as the commander wrote it — copy it verbatim, including sector codes and body suffixes such as "Synuefe LY-I b42-2" or "Eol Prou PM-L c8-118". Omit ONLY when they plainly mean where they are right now.',
      },
    },
  ),
  fn('list_known_markets', 'List the station markets the commander has visited this session (station, system, how long ago), so you can reason about nearby options.'),
  fn(
    'find_trade_run',
    'Find a profitable trade run: what to buy and where to sell it, with credits per ton and per full hold. Two modes — with no destination it finds the best-paying run in any direction ("what should I haul", "any good trade routes"); with a destination it finds the best cargo for a trip the commander is already making ("what can I sell to Tir", "anything worth carrying to Colonia"). ALWAYS use this rather than the local market when the question involves selling somewhere ELSE. Uses live community market data and honours the landing-pad size the ship needs.',
    {
      system: {
        type: 'string',
        description:
          'System to start the run from, copied verbatim if the commander names a PLACE. Omit when they say "from here" or name their own SHIP — a ship name is not a system.',
      },
      destination: {
        type: 'string',
        description:
          'Where the commander is HEADING, when they name somewhere — "what can I sell to Tir", "anything to carry to Colonia". Then the answer is the best cargo for THAT trip, not the best trip. Omit when they just want the most profitable run in any direction.',
      },
      max_distance_ly: { type: 'integer', description: 'How far to look for a buyer, in light years. Default 80.' },
      min_volume: { type: 'integer', description: 'Minimum stock at the source and demand at the destination, in tons. Default 1000.' },
    },
    [],
  ),
  fn(
    'plan_trade_route',
    'Ask the Spansh community planner for a closed multi-hop trade LOOP that physically returns to the starting station. Slow (up to a minute) and often finds nothing. IMPORTANT: commanders say "trade loop" loosely to mean any trade route at all — unless they clearly want to come back to where they started, use find_trade_run instead.',
    {
      max_hops: { type: 'integer', description: 'Number of hops (1-4). Default 2.' },
    },
    [],
  ),
  fn('get_ship', 'Report the current ship: type, jump range, cargo capacity, passenger cabins, key fittings, and landing-pad size requirement.'),
  fn(
    'check_fit',
    'Check whether the current ship can carry a given cargo tonnage (hold space) — use before advising a delivery or trade run.',
    {
      commodity: { type: 'string', description: 'Optional commodity name for a clearer answer.' },
      tons: { type: 'integer', description: 'Tons of cargo to carry.' },
    },
    ['tons'],
  ),
  fn('get_ship_status', 'Live ship telemetry: fuel level, legal state, and whether docked / in supercruise / on foot / running silent.'),
  fn('get_missions', 'List the commander\'s currently active missions with faction, destination, reward and cargo/passenger needs.'),
  fn('get_materials', 'Report engineering materials and engineer unlock progress worth acting on.'),
  fn('get_exploration', 'Report exploration state: bodies worth mapping and unsold cartographic data.'),
  fn('get_system_intel', 'What the journal has revealed about the CURRENT system: security, controlling faction, faction (BGS) states, and the stations/signals present.'),
] as const;

/** Names the model is allowed to call — used to reject hallucinated tools. */
export const TOOL_NAMES = new Set(TOOL_SCHEMAS.map((t) => t.function.name));

/** Run one tool call. Returns a concise text result to feed back as a tool message. */
export async function runTool(name: string, argsJson: string, ctx: ToolContext): Promise<string> {
  let args: Record<string, unknown> = {};
  if (argsJson && argsJson.trim()) {
    try {
      const parsed = JSON.parse(argsJson);
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
    } catch {
      return `Error: could not parse arguments for ${name} (${argsJson.slice(0, 80)}).`;
    }
  }
  switch (name) {
    case 'get_current_market':
      return currentMarket(ctx);
    case 'find_commodity':
      return findCommodity(ctx, str(args.commodity), args.side === 'sell' ? 'sell' : 'buy');
    case 'get_galnet_news':
      return galnetNews(ctx);
    case 'survey_system':
      return surveySystem(ctx, str(args.system) || ctx.system);
    case 'find_market_in_galaxy':
      return findMarketInGalaxy(
        ctx,
        str(args.commodity),
        args.side === 'buy' ? 'buy' : 'sell',
        str(args.system),
      );
    case 'list_known_markets':
      return listMarkets(ctx);
    case 'plan_trade_route':
      return planRoute(ctx, numOr(args.max_hops, 2));
    case 'find_trade_run':
      return findTradeRun(
        ctx,
        str(args.system),
        str(args.destination),
        numOr(args.max_distance_ly, 80),
        numOr(args.min_volume, DEFAULT_FILTERS.minVolume),
      );
    case 'get_ship':
      return ctx.shipDescription ? `Ship: ${ctx.shipDescription}` : 'No ship loadout known yet — open the ship panel or re-log so the game writes a Loadout event.';
    case 'check_fit':
      return checkFit(ctx, str(args.commodity), numOr(args.tons, 0));
    case 'get_ship_status':
      return ctx.statusLine ?? 'No live ship telemetry yet (Status.json not seen).';
    case 'get_missions':
      return listMissions(ctx);
    case 'get_materials':
      return ctx.materialsLine ?? 'Nothing notable in materials or engineer progress right now.';
    case 'get_exploration':
      return ctx.exploreLine ?? 'No exploration leads or unsold cartographic data right now.';
    case 'get_system_intel':
      return ctx.systemIntelLine ?? `No journal intel on ${ctx.system} yet — honk the Discovery Scanner and run an FSS scan to reveal it.`;
    default:
      return `Error: unknown tool "${name}".`;
  }
}

// ------------------------------------------------------------------ tool bodies

/**
 * The market in front of the commander — or, failing that, the last one they
 * opened, clearly labelled as somewhere else.
 *
 * The fallback is worth keeping (a price from an hour ago beats "I don't
 * know"), but it used to be silent. Docked at a carrier whose market they had
 * never opened, this returned the last market from a DIFFERENT SYSTEM and the
 * summary went on to describe it as "Buy here". Asked "in Tir?", the operator
 * answered with Crevie's Salvo's prices — a station in Kinesi — and stated them
 * as Tir's. Naming the station was not enough; the word "here" outvoted it.
 */
function currentMarket(ctx: ToolContext): string {
  const atStation = ctx.station ? ctx.markets.latest({ station: ctx.station }) : null;
  const inSystem =
    !atStation && ctx.system !== 'unknown' ? ctx.markets.latest({ system: ctx.system }) : null;
  const rec = atStation ?? inSystem ?? ctx.markets.latest();
  if (!rec) return 'No market data recorded yet — dock and open the Commodities Market once so I can read it.';
  const local = !!(atStation || inSystem);
  const elsewhere = local
    ? ''
    : `WARNING: this is NOT where the commander is. They are ${ctx.station ? `docked at ${ctx.station}` : 'in'} ${ctx.system}` +
      `, and no market has been opened there. These are the last prices they saw, somewhere else entirely — ` +
      `never describe them as local, and say plainly that you have no market data for ${ctx.system}.\n`;
  return elsewhere + marketSummary(rec, ageHours(rec.at), local);
}

function findCommodity(ctx: ToolContext, commodity: string, side: 'buy' | 'sell'): string {
  if (!commodity) return 'Error: no commodity name given.';
  const hits = ctx.markets.withCommodity(commodity, side).slice(0, 6);
  if (!hits.length) {
    return `No visited market ${side === 'buy' ? 'sells' : 'buys'} "${commodity}". I only know markets the commander has opened this session.`;
  }
  const verb = side === 'buy' ? 'buy' : 'sell';
  const rows = hits.map(({ market, item }) => {
    const price = side === 'buy' ? item.buy : item.sell;
    const qty = side === 'buy' ? `stock ${item.stock}` : `demand ${item.demand}`;
    return `${item.name} @ ${market.station} (${market.system}): ${verb} ${price.toLocaleString('en-US')} cr, ${qty}, ${ageHours(market.at)}h old`;
  });
  return `Where to ${verb} "${commodity}" (best first):\n${rows.join('\n')}`;
}

function listMarkets(ctx: ToolContext): string {
  const all = ctx.markets.all().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (!all.length) return 'No markets visited yet this session.';
  const rows = all.slice(0, 12).map((m) => `${m.station} (${m.system}) — ${m.items.length} commodities, ${ageHours(m.at)}h ago`);
  return `Markets visited (${all.length}):\n${rows.join('\n')}`;
}

async function planRoute(ctx: ToolContext, maxHops: number): Promise<string> {
  if (!ctx.station) return 'A trade route needs a starting station — the commander must be docked at a station with a market first.';
  const requiresLargePad = shipRequiresLargePad(ctx.ship?.ship);
  let route: TradeRoute | null;
  try {
    route = await ctx.planRoute({ maxHops: clamp(maxHops, 1, 4), requiresLargePad });
  } catch (e) {
    return `Route planner failed: ${String(e)}`;
  }
  if (!route || !route.hops.length) {
    // A closed loop is a strict thing to ask for and frequently does not exist,
    // while a plain buy-here/sell-there run usually does. Telling the commander
    // "no loop" and stopping is what sent a docked commander to go read the
    // market board by hand. Asking the model to chain to find_trade_run does
    // not work either — a small local model announces the next call instead of
    // making it. So answer the question they actually had, and label it.
    if (!ctx.findTradeRun) return 'Spansh found no profitable loop from here within range.';
    const single = await findTradeRun(ctx, '', '', 80, DEFAULT_FILTERS.minVolume);
    return `No closed loop out of here right now — Spansh needs a run that returns to the start, and there isn't one. A one-way run there is, though:
${single}`;
  }
  const legs = route.hops.map((h, i) => {
    const top = h.commodities[0];
    const buy = top ? `buy ${top.name} ${top.buyPrice.toLocaleString('en-US')}` : h.commodity;
    return `${i + 1}. ${h.fromStation} → ${h.toStation} (${h.toSystem}, ${h.distanceLy} ly): ${buy}, +${h.profitPerTon.toLocaleString('en-US')}/t, market ${h.marketAgeh}h old`;
  });
  return `Spansh route${requiresLargePad ? ' (large-pad only)' : ''} — ~${route.totalProfit.toLocaleString('en-US')} cr total:\n${legs.join('\n')}\nNote: community prices can be stale; verify stock on arrival.`;
}

function checkFit(ctx: ToolContext, commodity: string, tons: number): string {
  const s = ctx.ship;
  if (!s) return 'No ship loadout known yet, so I can\'t check the hold.';
  const cap = s.cargoCapacity;
  const free = ctx.liveCargo != null ? Math.max(0, cap - ctx.liveCargo) : cap;
  const what = commodity ? `${tons} t of ${commodity}` : `${tons} t`;
  if (tons <= 0) return `Cargo capacity is ${cap} t${ctx.liveCargo != null ? `, ${free} t free right now` : ''}.`;
  if (tons > cap) return `Won't fit: ${what} exceeds the ${cap} t hold. A bigger cargo rack or fewer runs are needed.`;
  if (ctx.liveCargo != null && tons > free) return `Tight: ${what} needs more than the ${free} t currently free (hold is ${cap} t, ${ctx.liveCargo} t used). Sell or jettison first, or split the run.`;
  return `Fits: ${what} into the ${cap} t hold${ctx.liveCargo != null ? ` (${free} t free)` : ''}.`;
}

function listMissions(ctx: ToolContext): string {
  const ms = ctx.missions;
  if (!ms.length) return 'No active missions on the board right now.';
  const rows = ms.slice(0, 10).map((m) => {
    const bits: string[] = [`${m.category}`];
    if (m.faction) bits.push(`for ${m.faction}`);
    const dest = m.destination ? `${m.destination.station ? `${m.destination.station}, ` : ''}${m.destination.system}` : null;
    if (dest) bits.push(`→ ${dest}`);
    if (m.commodity) bits.push(`needs ${m.commodity.count} ${m.commodity.localised}`);
    if (m.passengers) bits.push(`${m.passengers.count} ${m.passengers.type}${m.passengers.vip ? ' VIP' : ''}`);
    bits.push(`reward ${m.reward.toLocaleString('en-US')} cr`);
    return `- "${m.title}": ${bits.join(', ')}`;
  });
  return `Active missions (${ms.length}):\n${rows.join('\n')}`;
}

// ------------------------------------------------------------------ formatting

function marketSummary(rec: MarketRecord, age: number, local = true): string {
  const buys = rec.items.filter((i) => i.buy > 0 && i.stock > 0).sort((a, b) => b.stock - a.stock);
  const sells = rec.items.filter((i) => i.sell > 0 && i.demand > 0).sort((a, b) => b.sell - a.sell);
  // "here" is a claim about where the commander is standing. When the record
  // came from somewhere else, saying it is how a price from another system
  // gets reported as the local one.
  const at = local ? 'here' : `at ${rec.station}`;
  const lines = [`Market at ${rec.station} (${rec.system}), ${age}h old:`];
  if (buys.length) {
    lines.push(
      `Buy ${at}: ${buys.slice(0, 12).map((i) => `${i.name} ${i.buy.toLocaleString('en-US')} cr (stock ${i.stock})`).join('; ')}`,
    );
  } else lines.push(`Buy ${at}: nothing in stock.`);
  if (sells.length) {
    lines.push(
      `Sells for most (demand ${at}): ${sells.slice(0, 8).map((i) => `${i.name} ${i.sell.toLocaleString('en-US')} cr`).join('; ')}`,
    );
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ helpers

/** Build one function-tool schema entry. */
function fn(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
) {
  return {
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required },
    },
  };
}

function ageHours(iso: string): number {
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 3600_000)) : 0;
}
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * A fleet carrier's display name, matched to a callsign from the signals the
 * commander has already honked in-system.
 *
 * Market data (EDDN, and so Ardent and Spansh) carries only the callsign —
 * "G9H-NVZ". The GAME shows "IVAN KING G9H-NVZ", and that full string is what
 * the commander is scanning for in a nav panel listing fifty-eight carriers.
 * Told to look for G9H-NVZ, they flew to the right system, could not spot it,
 * and docked at the wrong carrier — while `FSSSignalDiscovered` had put "IVAN
 * KING G9H-NVZ" into system intel four minutes earlier.
 *
 * Matching is on the callsign appearing in the signal name, because that is
 * exactly how the game composes it (name + space + callsign).
 */
export function carrierDisplayName(
  callsign: string,
  signals: ReadonlyArray<{ name: string; isStation?: boolean }>,
): string | null {
  const call = callsign.trim().toUpperCase();
  // A carrier callsign is XXX-XXX. Anything else is an ordinary station, whose
  // name is already its full name.
  if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(call)) return null;
  for (const s of signals) {
    const name = (s.name ?? '').trim();
    if (!name || name.toUpperCase() === call) continue;
    if (name.toUpperCase().includes(call)) return name;
  }
  return null;
}

/** One row of a galaxy market lookup, as the injected source returns it. */
export interface MarketLookupRow {
  station: string;
  system: string;
  distanceLy: number | null;
  price: number | null;
  stock: number | null;
  demand: number | null;
  pad: string | null;
  carrier: boolean;
  /** When the community last saw this market. The single most important field
   *  on the row, and it used to be dropped before the model ever saw it. */
  updatedAt?: string | null;
}

/** Days since a community report, or null when it carries no timestamp. */
export function reportAgeDays(updatedAt: string | null | undefined, nowMs = Date.now()): number | null {
  const t = Date.parse(updatedAt ?? '');
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 86_400_000)) : null;
}

/**
 * Past this, a carrier listing is a rumour rather than a price.
 *
 * Carriers restock, sell out and flip between buying and selling in days. A
 * commander was sent fifteen light-years to a carrier reported twelve days
 * earlier as selling 9,789 t of tritium at 2,565 cr; on arrival it held none
 * and was BUYING at 55,301. Nothing in the answer had hinted the report was
 * nearly a fortnight old, because the age was never rendered at all.
 */
export const STALE_DAYS = 7;

const ageWord = (days: number | null): string =>
  days == null ? 'age unknown' : days === 0 ? 'seen today' : days === 1 ? 'seen yesterday' : `seen ${days} days ago`;

/**
 * Order market rows so the FIRST one is the answer.
 *
 * Price alone does not rank anything when every seller lists the same number,
 * and for carrier fuel they invariably do: a live lookup for tritium returned
 * eight carriers at exactly 2,565 cr, in no useful order — the nearest sat
 * third and the only two holding enough to fill the order sat fourth and
 * seventh. Asked to pick, the operator correctly observed that "the price is
 * the same everywhere" and then named no destination at all.
 *
 * So the tie-breaks carry the ranking: distance, because that is the cost the
 * commander actually pays, then quantity, because a nearer seller who cannot
 * fill the hold is a second trip. Rows with no price sort last rather than
 * masquerading as free.
 *
 * `need` outranks all of it. A seller who cannot fill the order is not a
 * cheaper option, it is an unfinished job — ranking the nearest carrier first
 * when it holds 73% of the tritium a route needs recommends a trip that ends
 * with the commander still stuck. Sellers who can cover the need come first;
 * distance then decides between them. When none can, the order is unchanged and
 * the caller says so outright rather than quietly topping the list with 31%.
 */
export function rankMarketRows<T extends MarketLookupRow>(
  rows: readonly T[],
  side: 'buy' | 'sell',
  need: number | null = null,
  nowMs = Date.now(),
): T[] {
  const price = (r: T): number =>
    r.price == null ? (side === 'buy' ? Infinity : -Infinity) : r.price;
  const qty = (r: T): number => (side === 'buy' ? (r.stock ?? 0) : (r.demand ?? 0));
  const far = (r: T): number => r.distanceLy ?? Infinity;
  // Only a purchase can fall short; a sale is limited by the hold, not the buyer.
  const shopping = need != null && side === 'buy';
  const covers = (r: T): number => (shopping && qty(r) >= need! ? 0 : 1);
  const byPrice = (a: T, b: T): number =>
    side === 'buy' ? price(a) - price(b) : price(b) - price(a);
  // Freshness outranks distance. A report from two days ago is far likelier to
  // still be true than one from twelve, and being wrong costs the whole trip
  // while a few extra light-years costs minutes. Bucketed rather than sorted
  // by exact age so a one-day difference does not shuffle the list.
  const stale = (r: T): number => ((reportAgeDays(r.updatedAt, nowMs) ?? STALE_DAYS) > STALE_DAYS ? 1 : 0);
  return [...rows].sort((a, b) => {
    const ca = covers(a);
    if (ca !== covers(b)) return ca - covers(b);
    // Nobody in this list can fill the order on their own, so the trip is
    // several stops whatever happens and the useful first one is the biggest
    // holding, not the closest. Leading with a carrier holding 7% of the need
    // because it is 6 ly nearer optimises the wrong thing.
    if (shopping && ca === 1) return qty(b) - qty(a) || byPrice(a, b) || far(a) - far(b);
    return byPrice(a, b) || stale(a) - stale(b) || far(a) - far(b) || qty(b) - qty(a);
  });
}

/**
 * Galaxy-wide market lookup via community (EDDN) data — the complement to
 * `find_commodity`, which can only see stations the commander has personally
 * visited. Answers are explicitly dated and carriers flagged, because both
 * matter: a fleet carrier can be gone tomorrow and prices drift.
 */
async function findMarketInGalaxy(
  ctx: ToolContext,
  commodity: string,
  side: 'buy' | 'sell',
  nearSystem: string,
): Promise<string> {
  if (!commodity) return 'Name the commodity to look up.';
  if (!ctx.galaxyMarket) {
    return 'Galaxy-wide market lookup is off. The commander can enable it in Settings → Community data (it sends only the system name and the commodity).';
  }
  if (!ctx.system || ctx.system === 'unknown') {
    return 'Current system unknown, so "nearby" cannot be measured yet.';
  }
  // "How much tritium has Luchtaine got" is a question about a NAMED system,
  // and searching outward from wherever we happen to be standing answers a
  // different one.
  const around = nearSystem || ctx.system;
  let rows;
  try {
    rows = await ctx.galaxyMarket(commodity, side, around);
  } catch (e) {
    return `The market service did not answer (${String(e).slice(0, 80)}). Fall back on what we have visited.`;
  }
  if (!rows.length) {
    return `No ${side === 'buy' ? 'sellers' : 'buyers'} of ${commodity} reported near ${around}.`;
  }
  const nowMs = Date.now();
  const verb = side === 'buy' ? 'Buy' : 'Sell';
  const need = ctx.commodityNeed?.(commodity) ?? null;
  // What the commander saw with their own eyes beats a stranger's report, when
  // ours is the fresher of the two. They docked at QFB-75N on the strength of a
  // twelve-day-old listing, found no tritium and a BUY order at 55,301 — and
  // the next lookup would have offered the same stale row straight back.
  rows = rows.map((r) => {
    const mine = ctx.markets?.latest({ station: r.station, system: r.system });
    if (!mine) return r;
    const theirs = Date.parse(r.updatedAt ?? '');
    const ours = Date.parse(mine.at);
    if (!Number.isFinite(ours) || (Number.isFinite(theirs) && theirs > ours)) return r;
    const seen = mine.items.find(
      (i) => i.name.toLowerCase().replace(/[^a-z0-9]+/g, '') === commodity.toLowerCase().replace(/[^a-z0-9]+/g, ''),
    );
    return {
      ...r,
      price: seen ? (side === 'buy' ? seen.buy : seen.sell) || null : null,
      stock: seen ? seen.stock : 0,
      demand: seen ? seen.demand : 0,
      updatedAt: mine.at,
      ownVisit: true,
    };
  });
  // A station that has already refused the commander is not a cheap option, it
  // is a wasted trip they have ALREADY made once. Ranked last rather than
  // dropped: knowing the best price is behind a locked door is worth saying.
  const refused = (r: MarketLookupRow): string | null =>
    ctx.dockingDenied?.(r.station, r.system) ?? null;
  // A market we personally found empty is not a candidate at any price.
  const empty = (r: MarketLookupRow & { ownVisit?: boolean }): boolean =>
    !!r.ownVisit && side === 'buy' && (r.stock ?? 0) <= 0;
  const usable = rows.filter((r) => !refused(r) && !empty(r));
  const rest = rows.filter((r) => refused(r) || empty(r));
  const open = rankMarketRows(usable, side, need, nowMs);
  const shut = rankMarketRows(rest, side, need, nowMs);
  const ranked = [...open, ...shut];
  const top = [...open.slice(0, 6), ...shut.slice(0, 2)];
  const anyCovers =
    need != null && side === 'buy' && ranked.some((r) => (r.stock ?? 0) >= need);
  const lines = top.map((r) => {
    const have = side === 'buy' ? (r.stock ?? 0) : (r.demand ?? 0);
    const qty = side === 'buy' ? `${have.toLocaleString('en-US')} in stock` : `demand ${have.toLocaleString('en-US')}`;
    const pad = r.pad ? `, pad ${r.pad}` : '';
    const far = r.distanceLy != null ? `${Math.round(r.distanceLy)} ly` : 'distance unknown';
    // Whether this seller can actually fill the order the commander is trying
    // to fill. Recommending a carrier holding 3,557 t to someone who needs
    // 4,865 t is a wasted trip they only discover at the pad.
    const fill = need != null && side === 'buy' ? (have >= need ? ' — COVERS your need' : ` — only ${Math.round((have / need) * 100)}% of what you need`) : '';
    // In-system carriers get the name the commander will actually read off
    // their nav panel, not just the callsign buried at the end of it.
    const full = r.carrier ? carrierDisplayName(r.station, ctx.systemSignals ?? []) : null;
    const shown = full ? `${r.station} — shows in the nav panel as "${full}"` : r.station;
    const shut = refused(r);
    const days = reportAgeDays(r.updatedAt, nowMs);
    const own = (r as MarketLookupRow & { ownVisit?: boolean }).ownVisit;
    // The age belongs on every row. Without it a twelve-day-old rumour and a
    // reading from this morning look identical, and the commander flies.
    const seenAt = own
      ? `YOU saw this yourself, ${ageWord(days)}`
      : `${ageWord(days)}${days != null && days > STALE_DAYS ? ' — STALE, may well be wrong' : ''}`;
    const gone = empty(r) ? ' — ⛔ YOU CHECKED: none for sale here' : '';
    return `- ${shown} (${r.system}, ${far}${pad})${r.carrier ? ' [fleet carrier]' : ''}: ${
      r.price != null ? `${r.price.toLocaleString('en-US')} cr` : 'price unknown'
    }, ${qty}, ${seenAt}${fill}${gone}${shut ? ` — ⛔ ${shut}; DO NOT send them back here` : ''}`;
  });

  // A total price tie is the NORM for carrier fuel — six carriers all at
  // 2,565 cr — and a flat list of identical prices reads as "there is no
  // cheapest", which is what the operator told a commander who then got no
  // destination at all. Say that the tie is expected and that the list is
  // already ordered by the thing that breaks it.
  const prices = top.map((r) => r.price).filter((p): p is number => p != null);
  const tied = prices.length > 1 && new Set(prices).size === 1;
  const order =
    need != null && side === 'buy'
      ? anyCovers
        ? 'sellers who can fill the whole order first, then cheapest, then nearest'
        : 'largest holding first — nobody here can fill the whole order'
      : side === 'buy'
        ? 'cheapest first, then nearest, then most stock'
        : 'best price first, then nearest';

  return (
    // "near X" was read as "in X" and reported back as "Luchtaine has it at
    // 2,565" when the seller was a carrier two systems over. Say it outright.
    `${verb} ${commodity} — nearest to ${around}, NOT necessarily IN ${around}; each line names ` +
    // "may be hours old" was wishful: the row that stranded a commander was
    // twelve DAYS old. Every line now states its own age; say it out loud.
    `its own system. Community reports, each with the date it was last seen — ALWAYS tell the ` +
    `commander how old the one you recommend is, because carriers sell out and flip to buying in ` +
    `days. Ordered ${order}, so the FIRST line is the ` +
    `recommendation${need != null && side === 'buy' ? ` for the ${need.toLocaleString('en-US')} t they need` : ''}:\n` +
    lines.join('\n') +
    (tied ? `\nEvery price here is identical (${prices[0].toLocaleString('en-US')} cr) — that is normal for carrier fuel, so pick on distance and stock, not price. Do NOT answer "there is no cheapest": name the first line.` : '') +
    // Needing more than any one seller holds is normal at carrier scale, and it
    // changes the advice from "go here" to "go here first" — worth saying, not
    // worth hiding behind a top line that quietly covers a third of the order.
    (need != null && side === 'buy' && !anyCovers
      ? `\nNo single seller here holds the ${need.toLocaleString('en-US')} t needed — say so, and treat the top line as the first stop of more than one.`
      : '') +
    `\nFleet carriers are marked. Always tell the commander the SYSTEM to fly to — that is what they ` +
    `enter in the galaxy map. The callsign (G9H-NVZ) is how they pick the carrier out once they ` +
    `arrive; where a nav-panel name is given above, say THAT, because a busy system can list fifty ` +
    `carriers and the callsign sits at the end of the name. Carriers can jump away and prices swing.`
  );
}

/** Galnet, on demand — the operator relays the wire when asked for news. */
async function galnetNews(ctx: ToolContext): Promise<string> {
  if (!ctx.galnetNews) {
    return 'Galnet is off. The commander can switch it on in Settings → Community data (it sends nothing about them — it is the public news feed).';
  }
  try {
    const items = await ctx.galnetNews();
    if (!items.length) return 'The Galnet wire returned nothing just now.';
    return (
      'Latest Galnet (galaxy news — NOT the commander\'s own doings; do not imply they were there):\n' +
      items
        .slice(0, 5)
        .map((i) => `- ${i.title}${i.date ? ` (${i.date})` : ''}: ${i.lead.slice(0, 180)}`)
        .join('\n')
    );
  } catch (e) {
    return `The news wire did not answer (${String(e).slice(0, 80)}).`;
  }
}

/**
 * What others have already catalogued in a system — chiefly which bodies have
 * reported organics, and the species. Absence is explicitly NOT evidence of
 * absence: unvisited space simply has no reports, and that is exactly where the
 * first-footfall bonus lives.
 */
async function surveySystem(ctx: ToolContext, system: string): Promise<string> {
  if (!system || system === 'unknown') return 'Name a system to look up.';
  if (!ctx.systemSurvey) {
    return 'The exploration catalogue is off. The commander can enable it in Settings → Community data (it sends only the system name).';
  }
  let s;
  try {
    s = await ctx.systemSurvey(system);
  } catch (e) {
    return `No catalogue entry for ${system} (${String(e).slice(0, 70)}). Nobody may have surveyed it — which can mean a first footfall is still going.`;
  }
  const head =
    `${s.system}: ${s.bodyCount ?? '?'} bodies, ${s.landablePlanets} landable` +
    [
      s.earthLikes ? `, ${s.earthLikes} Earth-like` : '',
      s.waterWorlds ? `, ${s.waterWorlds} water world(s)` : '',
      s.ammoniaWorlds ? `, ${s.ammoniaWorlds} ammonia world(s)` : '',
      s.terraformables ? `, ${s.terraformables} terraformable` : '',
    ].join('');
  if (!s.bodiesWithOrganics.length) {
    return `${head}.\nNo biology logged here by anyone yet — that is missing data, not proof the system is barren, and it means a first log here would still pay the five-times bonus.`;
  }
  const bio = s.bodiesWithOrganics
    .slice(0, 8)
    .map(
      (b) =>
        `- ${b.body}${b.subType ? ` (${b.subType})` : ''}${b.distanceLs != null ? `, ${Math.round(b.distanceLs)} Ls` : ''}: ${
          b.species.length ? b.species.join(', ') : 'organics reported, species unknown'
        }`,
    )
    .join('\n');
  return `${head}.\nBiology already logged by other commanders:\n${bio}\nBecause it is already logged, the five-times first-footfall bonus is gone for these.`;
}

/**
 * The Inara-style answer: best buy→sell pair out of here.
 *
 * Pad size comes from the hull rather than the question — a medium floor is
 * right for most ships and opens up outpost sinks, but a large-pad-only hull
 * cannot use them, and quoting a route it can't fly is worse than no route.
 */
async function findTradeRun(
  ctx: ToolContext,
  requested: string,
  destination: string,
  maxDistanceLy: number,
  minVolume: number,
): Promise<string> {
  if (!ctx.findTradeRun) {
    return 'Galaxy-wide market lookup is off. The commander can switch it on in Settings → Community data (it sends only the system name and the commodities checked).';
  }
  const { origin } = resolveOrigin(requested, ctx.system, ctx.ship);
  if (!origin || origin === 'unknown') {
    return 'I need to know what system we are in before I can look for a run.';
  }
  const minPad = shipRequiresLargePad(ctx.ship?.ship) ? 3 : DEFAULT_FILTERS.minPad;
  const cargo = ctx.ship?.cargoCapacity || DEFAULT_FILTERS.cargo;
  try {
    const find = await ctx.findTradeRun({
      origin,
      // Where they are standing, so a run that starts at a different outpost in
      // the same system cannot be read as the board in front of them.
      atStation: ctx.station ?? '',
      // A destination equal to where we already are is not a trip.
      destination: destination && destination.toLowerCase() !== origin.toLowerCase() ? destination : '',
      maxDistanceLy: clamp(maxDistanceLy, 5, 250),
      minVolume: clamp(minVolume, 0, 100_000),
      minPad,
      cargo,
    });
    return describeTradeFind(find);
  } catch (e) {
    return `The market data service did not answer (${String(e).slice(0, 90)}).`;
  }
}
