/**
 * What is actually sitting in the fleet carrier's hold.
 *
 * Deep-space colonisation is a two-stage haul. Nobody flies 20,464 t from the
 * bubble to HIP 71120 one 784 t Panther load at a time; they fill the carrier
 * where the commodities are, jump it, and then shuttle from the carrier to the
 * depot. Which means the single most expensive question in the whole operation
 * — "do I already own this?" — is answered by a number the shopping list could
 * not see at all: `carrier.ts` tracked tritium and nothing else, so a panel
 * holding 4,500 t of steel on its own carrier still said "no source found" and
 * sent the commander shopping for steel.
 *
 * The game is miserly about this. There is NO event that states a carrier's
 * manifest. What it gives instead is four partial views, and the whole job of
 * this module is to fold them into one figure that says how much it trusts
 * itself:
 *
 *   CarrierStats      SpaceUsage.Cargo — total tons aboard. A number with no
 *                     names attached, and the only unarguable truth here.
 *   CargoTransfer     Transfers[{Type, Count, Direction}] — named deltas, both
 *                     directions. Exact, but only for moves we were running
 *                     for. Anything moved while the app was shut is invisible.
 *   Market.json       At the carrier, `Stock` per item — but ONLY for items it
 *                     has an order against. Cargo with no order is simply
 *                     absent from the board, which is why a market read must
 *                     never be allowed to zero a line it did not mention.
 *   MarketBuy/Sell    Trading with your own carrier moves its stock, and the
 *                     MarketID says it was yours.
 *
 * So each line carries a `basis`, and the snapshot carries the gap between the
 * tonnage we can name and the tonnage the game reports. `unaccountedTons` is
 * not a rounding error to be hidden — it is the honest statement "there are
 * 1,200 t up there I cannot name", and a commander who sees it knows to go and
 * look rather than trusting a list that quietly under-reports.
 *
 * Pure module — unit-tested in tests/carrierhold.test.ts.
 */
import type { JournalEvent } from './types.ts';
import { commodityKey } from './architect.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** How a line's tonnage came to be known, weakest last. */
export type StockBasis = 'market' | 'ledger';

/** One commodity aboard the carrier. */
export interface CarrierStock {
  key: string;
  /** Best spelling seen — "Liquid oxygen" beats `liquidoxygen`. */
  name: string;
  tons: number;
  basis: StockBasis;
  /** ISO timestamp of the event this line was last moved by. */
  at: string;
}

export interface CarrierHoldSnapshot {
  callsign: string | null;
  system: string | null;
  /** Everything we can name, biggest first. Never includes zeroed lines. */
  items: CarrierStock[];
  /** Tons across `items` — what the ledger can account for by name. */
  namedTons: number;
  /** SpaceUsage.Cargo, the game's own total. Null before any CarrierStats. */
  reportedTons: number | null;
  /**
   * Tons aboard that we cannot put a name to.
   *
   * Positive is the normal case for a carrier loaded before the operator was
   * ever run. Negative means our ledger has drifted ABOVE what the game says
   * is aboard — a transfer happened that we double-counted, or the commander
   * sold from the carrier while we were not watching — and the panel says so
   * rather than pretending to a precision it does not have.
   */
  unaccountedTons: number | null;
  /** True while every named line came off the carrier's own board. */
  fromBoard: boolean;
  /** When the figures above last moved. */
  at: string | null;
}

/**
 * Tons of a commodity a carrier holds, and how sure we are.
 *
 * `ledger` tonnage is a running sum and can drift; `market` tonnage was read
 * off the carrier's board minutes ago. The shopping list shows both but words
 * them differently, because "you have 4,500 t of steel up there" and "you
 * probably have 4,500 t of steel up there" lead to different flight plans.
 */
export class CarrierHold {
  private carrierId: number | null = null;
  private callsign: string | null = null;
  private system: string | null = null;
  private stock = new Map<string, CarrierStock>();
  private reportedTons: number | null = null;
  private at: string | null = null;

  /** Commodity key → tons, for the shopping list. Zeroes are not included. */
  tons(): Map<string, number> {
    const out = new Map<string, number>();
    for (const s of this.stock.values()) if (s.tons > 0) out.set(s.key, s.tons);
    return out;
  }

  snapshot(): CarrierHoldSnapshot {
    const items = [...this.stock.values()].filter((s) => s.tons > 0).sort((a, b) => b.tons - a.tons);
    const namedTons = items.reduce((n, s) => n + s.tons, 0);
    return {
      callsign: this.callsign,
      system: this.system,
      items,
      namedTons,
      reportedTons: this.reportedTons,
      unaccountedTons: this.reportedTons == null ? null : this.reportedTons - namedTons,
      fromBoard: items.length > 0 && items.every((s) => s.basis === 'market'),
      at: this.at,
    };
  }

  /** The carrier's id, once the game has mentioned it. Null means no carrier. */
  get id(): number | null {
    return this.carrierId;
  }

  apply(ev: JournalEvent): boolean {
    switch (ev.event) {
      case 'CarrierStats': {
        const id = num(ev.CarrierID);
        if (id) this.carrierId = id;
        const call = str(ev.Callsign);
        if (call) this.callsign = call;
        const use = ev.SpaceUsage as Record<string, unknown> | undefined;
        if (use && typeof use === 'object' && typeof use.Cargo === 'number') {
          this.reportedTons = num(use.Cargo);
          this.at = str(ev.timestamp) || this.at;
          return true;
        }
        return false;
      }
      case 'CarrierLocation':
      case 'CarrierJump': {
        const id = num(ev.CarrierID) || num(ev.MarketID);
        if (id) this.carrierId = id;
        const sys = str(ev.StarSystem);
        if (sys && sys !== this.system) {
          this.system = sys;
          return true;
        }
        return false;
      }
      case 'CargoTransfer': {
        const rows = Array.isArray(ev.Transfers) ? (ev.Transfers as Array<Record<string, unknown>>) : [];
        let moved = false;
        for (const r of rows) {
          const dir = str(r.Direction).toLowerCase();
          // 'tocarrier' and 'toship' are the two the game writes. A direction
          // we do not recognise is skipped rather than guessed at — a sign
          // error here invents tonnage the commander does not own.
          const sign = dir === 'tocarrier' ? 1 : dir === 'toship' ? -1 : 0;
          if (!sign) continue;
          const key = commodityKey(str(r.Type));
          const count = num(r.Count);
          if (!key || count <= 0) continue;
          this.move(key, str(r.Type_Localised) || str(r.Type), sign * count, str(ev.timestamp));
          moved = true;
        }
        return moved;
      }
      case 'MarketBuy':
      case 'MarketSell': {
        // Trading with your own carrier moves its hold. Any other market does
        // not, so the MarketID check is what keeps a bubble shopping run from
        // being credited against the carrier.
        if (this.carrierId == null || num(ev.MarketID) !== this.carrierId) return false;
        const key = commodityKey(str(ev.Type));
        const count = num(ev.Count);
        if (!key || count <= 0) return false;
        // Buying FROM the carrier empties it; selling TO it fills it.
        const sign = ev.event === 'MarketBuy' ? -1 : 1;
        this.move(key, str(ev.Type_Localised) || str(ev.Type), sign * count, str(ev.timestamp));
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * The carrier's own board, which is the best reading we ever get.
   *
   * Only for items the board actually lists. A carrier holding 800 t of steel
   * with no order against it shows NO steel row at all — so absent lines keep
   * whatever the ledger had. Zeroing them on every market read would empty the
   * hold the first time the commander docked at their own carrier.
   */
  readMarket(marketId: number, items: readonly { name: string; stock: number }[], at: string): boolean {
    if (this.carrierId == null || marketId !== this.carrierId) return false;
    let changed = false;
    for (const i of items) {
      const key = commodityKey(i.name);
      if (!key) continue;
      const tons = Math.max(0, Math.round(i.stock));
      const held = this.stock.get(key);
      if (held && held.tons === tons && held.basis === 'market') continue;
      this.stock.set(key, { key, name: i.name || held?.name || key, tons, basis: 'market', at });
      changed = true;
    }
    if (changed) this.at = at;
    return changed;
  }

  private move(key: string, name: string, delta: number, at: string): void {
    const held = this.stock.get(key);
    const tons = Math.max(0, (held?.tons ?? 0) + delta);
    this.stock.set(key, {
      key,
      name: name || held?.name || key,
      tons,
      // A transfer against a board reading downgrades the line: the board was
      // right at the time, and this moves it away from what the board said.
      basis: 'ledger',
      at: at || held?.at || '',
    });
    this.at = at || this.at;
  }

  toJSON(): {
    carrierId: number | null;
    callsign: string | null;
    system: string | null;
    stock: CarrierStock[];
    reportedTons: number | null;
    at: string | null;
  } {
    return {
      carrierId: this.carrierId,
      callsign: this.callsign,
      system: this.system,
      stock: [...this.stock.values()].filter((s) => s.tons > 0),
      reportedTons: this.reportedTons,
      at: this.at,
    };
  }

  load(
    d: {
      carrierId?: number | null;
      callsign?: string | null;
      system?: string | null;
      stock?: CarrierStock[];
      reportedTons?: number | null;
      at?: string | null;
    } | null,
  ): void {
    if (!d || typeof d !== 'object') return;
    if (d.carrierId != null) this.carrierId = d.carrierId;
    if (d.callsign) this.callsign = d.callsign;
    if (d.system) this.system = d.system;
    if (d.reportedTons != null) this.reportedTons = d.reportedTons;
    if (d.at) this.at = d.at;
    for (const s of Array.isArray(d.stock) ? d.stock : []) {
      if (!s || typeof s !== 'object') continue;
      const key = commodityKey(s.key ?? '');
      const tons = num(s.tons);
      if (!key || tons <= 0) continue;
      this.stock.set(key, {
        key,
        name: str(s.name) || key,
        tons,
        // A restored reading is no longer a board reading: the carrier may have
        // been traded from in another session. It is a ledger figure now.
        basis: 'ledger',
        at: str(s.at),
      });
    }
  }
}

/**
 * A carrier's board, read for TONNAGE rather than for prices.
 *
 * `parseMarketSnapshot` exists to find trades, so it keeps only rows that are
 * purchasable or sellable — `(buy > 0 && stock > 0) || (sell > 0 && demand)`.
 * That filter is right for the trade planner and wrong here: a commander can
 * set a 0 cr price on their own carrier, and a hold reading that silently drops
 * those rows under-reports the warehouse the whole plan is built on.
 *
 * So every row with stock aboard is kept, whatever it is priced at.
 */
export function parseCarrierStock(
  ev: JournalEvent,
): { marketId: number; items: Array<{ name: string; stock: number }>; at: string } | null {
  const marketId = num(ev.MarketID);
  const rows = Array.isArray(ev.Items) ? (ev.Items as Array<Record<string, unknown>>) : [];
  if (!marketId || !rows.length) return null;
  const items: Array<{ name: string; stock: number }> = [];
  for (const r of rows) {
    const name = str(r.Name_Localised) || str(r.Name);
    if (!name) continue;
    const stock = num(r.Stock);
    if (stock <= 0) continue;
    items.push({ name, stock });
  }
  if (!items.length) return null;
  return { marketId, items, at: str(ev.timestamp) || new Date(0).toISOString() };
}

/**
 * One line for the panel head, or null when there is nothing worth saying.
 *
 * Deliberately leads with coverage rather than tonnage. "4,512 t aboard" is a
 * fact about the carrier; "covers 6 of the 17 lines this build still wants" is
 * a fact about the build, and the second one is what decides where to fly.
 */
export function describeCarrierHold(
  snap: CarrierHoldSnapshot,
  covered: number,
  lines: number,
  tonsCovered: number,
): string | null {
  if (!snap.items.length && !snap.reportedTons) return null;
  const who = snap.callsign ?? 'your carrier';
  const where = snap.system ? ` in ${snap.system}` : '';
  if (!covered) {
    const tons = Math.round(snap.namedTons).toLocaleString('en-US');
    return `${who}${where} holds ${tons} t, none of it on this build's list.`;
  }
  const t = Math.round(tonsCovered).toLocaleString('en-US');
  return `${who}${where} covers ${covered} of ${lines} outstanding lines — ${t} t you already own.`;
}
