/**
 * Trade memory — remembers every commodities market the commander opens
 * (Market.json snapshots) and cross-references prices to spot profitable
 * runs: buy low at one remembered station, sell high at another.
 *
 * Prices drift with the background simulation, so records age out; distances
 * are unknown without external APIs — the commander judges the hop.
 */
import type { JournalEvent } from './types.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface MarketItem {
  name: string; // localised commodity name
  buy: number; // 0 = not sold here
  sell: number;
  stock: number;
  demand: number;
}

export interface MarketRecord {
  marketId: number;
  station: string;
  system: string;
  at: string; // ISO timestamp of the snapshot
  items: MarketItem[];
}

/** Parse a Market.json snapshot object into a compact record (null if empty). */
export function parseMarketSnapshot(ev: JournalEvent): MarketRecord | null {
  const items = ev.Items;
  if (!Array.isArray(items) || !items.length) return null;
  const marketId = num(ev.MarketID);
  if (!marketId) return null;
  const compact: MarketItem[] = [];
  for (const raw of items as Array<Record<string, unknown>>) {
    const name = str(raw.Name_Localised) ?? str(raw.Name) ?? '';
    if (!name) continue;
    const buy = num(raw.BuyPrice);
    const sell = num(raw.SellPrice);
    const stock = num(raw.Stock);
    const demand = num(raw.Demand);
    // Keep only rows that matter: purchasable here, or sellable here.
    if ((buy > 0 && stock > 0) || (sell > 0 && demand > 0)) {
      compact.push({ name, buy, sell, stock, demand });
    }
  }
  if (!compact.length) return null;
  return {
    marketId,
    station: str(ev.StationName) ?? '?',
    system: str(ev.StarSystem) ?? '?',
    at: str(ev.timestamp) ?? new Date(0).toISOString(),
    items: compact,
  };
}

const MAX_MARKETS = 40;

export class MarketMemory {
  private markets = new Map<number, MarketRecord>();

  load(records: MarketRecord[]): void {
    for (const r of records) if (r && r.marketId) this.markets.set(r.marketId, r);
  }

  toJSON(): MarketRecord[] {
    return [...this.markets.values()];
  }

  get size(): number {
    return this.markets.size;
  }

  /**
   * Most recently visited REAL station market in a system, carriers excluded
   * (registration-plate names like "V6W-TTJ"). The route planner needs a
   * concrete station as its start — and a fleet carrier is not one.
   */
  stationIn(system: string): string | null {
    const carrier = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/;
    const hit = [...this.markets.values()]
      .filter((m) => m.system.toLowerCase() === system.toLowerCase() && !carrier.test(m.station))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return hit?.station ?? null;
  }

  record(rec: MarketRecord): void {
    this.markets.set(rec.marketId, rec);
    if (this.markets.size > MAX_MARKETS) {
      const oldest = [...this.markets.values()].sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at),
      )[0];
      this.markets.delete(oldest.marketId);
    }
  }

  all(): MarketRecord[] {
    return [...this.markets.values()];
  }

  byId(marketId: number): MarketRecord | null {
    return this.markets.get(marketId) ?? null;
  }

  /**
   * The most recently recorded market, optionally narrowed to a station and/or
   * system (case-insensitive). This is "the market in front of the commander"
   * when docked — the live commodity list the operator should reason from.
   */
  latest(filter?: { system?: string; station?: string }): MarketRecord | null {
    const sys = filter?.system?.toLowerCase();
    const stn = filter?.station?.toLowerCase();
    return (
      [...this.markets.values()]
        .filter((m) => (!sys || m.system.toLowerCase() === sys) && (!stn || m.station.toLowerCase() === stn))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null
    );
  }

  /**
   * Every remembered market that buys-from-us or sells-to-us the named
   * commodity (case-insensitive substring), best price first. `side: 'buy'`
   * = where the COMMANDER can buy (market sells it, has stock); `side: 'sell'`
   * = where the commander can sell (market has demand).
   */
  withCommodity(commodity: string, side: 'buy' | 'sell'): Array<{ market: MarketRecord; item: MarketItem }> {
    const q = commodity.trim().toLowerCase();
    if (!q) return [];
    const hits: Array<{ market: MarketRecord; item: MarketItem }> = [];
    for (const m of this.markets.values()) {
      for (const it of m.items) {
        if (!it.name.toLowerCase().includes(q)) continue;
        if (side === 'buy' && it.buy > 0 && it.stock > 0) hits.push({ market: m, item: it });
        else if (side === 'sell' && it.sell > 0 && it.demand > 0) hits.push({ market: m, item: it });
      }
    }
    return hits.sort((a, b) =>
      side === 'buy' ? a.item.buy - b.item.buy : b.item.sell - a.item.sell,
    );
  }
}

export interface TradeEnd {
  marketId: number;
  station: string;
  system: string;
  price: number;
  quantity: number; // stock (buy side) or demand (sell side)
  at: string;
}

export interface TradeOpportunity {
  key: string; // commodity|buyMarket|sellMarket — stable id for dismissal
  commodity: string;
  buy: TradeEnd;
  sell: TradeEnd;
  profitPerTon: number;
}

export interface TradeOptions {
  minProfitPerTon?: number; // default 5000 — "very good" territory
  maxAgeHours?: number; // default 48 — prices drift with the BGS
  minQuantity?: number; // default 50 — worth an actual cargo run
  exclude?: Set<string>; // dismissed opportunity keys
  nowMs?: number;
}

/** Best cross-market runs from remembered prices, highest profit first. */
export function findOpportunities(
  memory: MarketMemory,
  opts: TradeOptions = {},
): TradeOpportunity[] {
  const minProfit = opts.minProfitPerTon ?? 5000;
  const maxAgeMs = (opts.maxAgeHours ?? 48) * 3600_000;
  const minQty = opts.minQuantity ?? 50;
  const nowMs = opts.nowMs ?? Date.now();
  const fresh = memory.all().filter((m) => nowMs - Date.parse(m.at) <= maxAgeMs);

  // commodity -> best buy end / best sell end across all fresh markets
  const bestBuy = new Map<string, TradeEnd>();
  const bestSell = new Map<string, TradeEnd>();
  for (const m of fresh) {
    for (const it of m.items) {
      if (it.buy > 0 && it.stock >= minQty) {
        const cur = bestBuy.get(it.name);
        if (!cur || it.buy < cur.price) {
          bestBuy.set(it.name, {
            marketId: m.marketId,
            station: m.station,
            system: m.system,
            price: it.buy,
            quantity: it.stock,
            at: m.at,
          });
        }
      }
      if (it.sell > 0 && it.demand >= minQty) {
        const cur = bestSell.get(it.name);
        if (!cur || it.sell > cur.price) {
          bestSell.set(it.name, {
            marketId: m.marketId,
            station: m.station,
            system: m.system,
            price: it.sell,
            quantity: it.demand,
            at: m.at,
          });
        }
      }
    }
  }

  const out: TradeOpportunity[] = [];
  for (const [name, buy] of bestBuy) {
    const sell = bestSell.get(name);
    if (!sell || sell.marketId === buy.marketId) continue;
    const profit = sell.price - buy.price;
    if (profit < minProfit) continue;
    const key = `${name}|${buy.marketId}|${sell.marketId}`;
    if (opts.exclude?.has(key)) continue;
    out.push({ key, commodity: name, buy, sell, profitPerTon: profit });
  }
  return out.sort((a, b) => b.profitPerTon - a.profitPerTon);
}
