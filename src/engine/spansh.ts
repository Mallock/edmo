/**
 * Spansh trade-route parsing — turns the community route planner's reply into
 * a compact card model. The network call lives in Rust (opt-in only); this
 * module is pure and unit-tested against a captured real response.
 */

/** One commodity of a hop's shopping list — the profit-calculator row. */
export interface RouteCommodity {
  name: string;
  amount: number; // tons the planner says to buy
  buyPrice: number;
  sellPrice: number;
  profitPerTon: number;
  totalProfit: number;
  /** Profit as % of buy price; null when bought for 0 (mission goods etc.). */
  marginPct: number | null;
}

export interface RouteHop {
  fromStation: string;
  fromSystem: string;
  toStation: string;
  toSystem: string;
  distanceLy: number;
  commodity: string;
  profitPerTon: number;
  totalProfit: number;
  marketAgeh: number; // destination market freshness, hours
  /** Full shopping list, best-earning first (top 3 kept). */
  commodities: RouteCommodity[];
}

export interface TradeRoute {
  hops: RouteHop[];
  totalProfit: number;
  fetchedAt: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '?');

/** Parse the /api/results body; null when there is no usable route. */
export function parseSpanshRoute(jsonText: string, nowMs = Date.now()): TradeRoute | null {
  let body: unknown;
  try {
    body = JSON.parse(jsonText);
  } catch {
    return null;
  }
  const result = (body as { result?: unknown }).result;
  if (!Array.isArray(result) || !result.length) return null;

  const hops: RouteHop[] = [];
  for (const raw of result as Array<Record<string, any>>) {
    const rawCommodities = Array.isArray(raw.commodities) ? raw.commodities : [];
    // The shopping list, biggest earner first — profit-per-ton alone misleads
    // when supply caps the amount (14k cr/t × 1 t is pocket change).
    const commodities: RouteCommodity[] = [...rawCommodities]
      .sort((a, b) => num(b?.total_profit) - num(a?.total_profit))
      .slice(0, 3)
      .map((c) => {
        const buyPrice = num(c?.source_commodity?.buy_price);
        const profitPerTon = num(c?.profit);
        return {
          name: str(c?.name),
          amount: num(c?.amount),
          buyPrice,
          sellPrice: num(c?.destination_commodity?.sell_price),
          profitPerTon,
          totalProfit: num(c?.total_profit),
          marginPct: buyPrice > 0 ? Math.round((profitPerTon / buyPrice) * 100) : null,
        };
      });
    const best = commodities[0];
    hops.push({
      fromStation: str(raw.source?.station),
      fromSystem: str(raw.source?.system),
      toStation: str(raw.destination?.station),
      toSystem: str(raw.destination?.system),
      distanceLy: Math.round(num(raw.distance) * 10) / 10,
      commodity: best?.name ?? '?',
      profitPerTon: best?.profitPerTon ?? 0,
      totalProfit: num(raw.total_profit),
      marketAgeh: Math.max(
        0,
        Math.round((nowMs / 1000 - num(raw.destination?.market_updated_at)) / 3600),
      ),
      commodities,
    });
  }
  const totalProfit = num((result.at(-1) as Record<string, unknown>)?.cumulative_profit);
  if (!hops.length || totalProfit <= 0) return null;
  return { hops, totalProfit, fetchedAt: nowMs };
}

/** One-line spoken/feed summary. */
export function routeSummary(r: TradeRoute): string {
  const first = r.hops[0];
  const legs = r.hops
    .map((h) => `${h.commodity} to ${h.toStation} (${h.toSystem}, ${h.distanceLy} ly)`)
    .join(', then ');
  return `Route found from ${first.fromStation}: ${legs} — about ${r.totalProfit.toLocaleString('en-US')} cr total.`;
}

/** Inara-style calculator line for one commodity: buy → sell, margin, take. */
export function commodityLine(c: RouteCommodity): string {
  const margin = c.marginPct !== null ? ` (${c.marginPct.toLocaleString('en-US')}%)` : '';
  return `${c.amount.toLocaleString('en-US')} t ${c.name}: buy ${c.buyPrice.toLocaleString('en-US')} → sell ${c.sellPrice.toLocaleString('en-US')} · +${c.profitPerTon.toLocaleString('en-US')}/t${margin} · +${c.totalProfit.toLocaleString('en-US')} cr`;
}
