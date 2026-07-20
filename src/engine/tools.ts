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
}

/** OpenAI-style tool manifest advertised to the model. */
export const TOOL_SCHEMAS = [
  fn('get_current_market', 'List the commodities, prices, stock and demand at the station the commander is currently docked at (or the most recently visited market). Use this to answer what is for sale/profitable HERE before suggesting anything.'),
  fn(
    'find_commodity',
    'Search all markets the commander has visited for where to BUY or SELL a specific commodity, cheapest-buy / highest-sell first.',
    {
      commodity: { type: 'string', description: 'Commodity name, e.g. "Gold", "Bauxite".' },
      side: { type: 'string', enum: ['buy', 'sell'], description: 'buy = where to purchase it; sell = where to offload it.' },
    },
    ['commodity', 'side'],
  ),
  fn('list_known_markets', 'List the station markets the commander has visited this session (station, system, how long ago), so you can reason about nearby options.'),
  fn(
    'plan_trade_route',
    'Ask the Spansh community planner for a profitable multi-hop trade route starting from the current station. Uses live-ish community market data. Slow (up to a minute).',
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
    case 'list_known_markets':
      return listMarkets(ctx);
    case 'plan_trade_route':
      return planRoute(ctx, numOr(args.max_hops, 2));
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

function currentMarket(ctx: ToolContext): string {
  const rec =
    ctx.markets.latest(ctx.station ? { station: ctx.station } : ctx.system !== 'unknown' ? { system: ctx.system } : undefined) ??
    ctx.markets.latest();
  if (!rec) return 'No market data recorded yet — dock and open the Commodities Market once so I can read it.';
  return marketSummary(rec, ageHours(rec.at));
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
  if (!route || !route.hops.length) return 'Spansh found no profitable route from here within range.';
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

function marketSummary(rec: MarketRecord, age: number): string {
  const buys = rec.items.filter((i) => i.buy > 0 && i.stock > 0).sort((a, b) => b.stock - a.stock);
  const sells = rec.items.filter((i) => i.sell > 0 && i.demand > 0).sort((a, b) => b.sell - a.sell);
  const lines = [`Market at ${rec.station} (${rec.system}), ${age}h old:`];
  if (buys.length) {
    lines.push(
      `Buy here: ${buys.slice(0, 12).map((i) => `${i.name} ${i.buy.toLocaleString('en-US')} cr (stock ${i.stock})`).join('; ')}`,
    );
  } else lines.push('Buy here: nothing in stock.');
  if (sells.length) {
    lines.push(
      `Sells for most (demand here): ${sells.slice(0, 8).map((i) => `${i.name} ${i.sell.toLocaleString('en-US')} cr`).join('; ')}`,
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
