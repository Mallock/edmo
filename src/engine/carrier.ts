/**
 * Fleet-carrier awareness.
 *
 * A commander who owns a carrier is doing a different job from one who does
 * not: tritium they mine is FUEL, not cargo, and hauling it home is the point
 * rather than a missed sale. Without this the operator answered "this is going
 * for my carrier fuel" by recommending they sell the tritium and look for
 * better-paying commodities — while the journal had already recorded them
 * moving 104 tons of it to the carrier that same afternoon.
 *
 * The game says all of this plainly and we were throwing it away:
 *   - CarrierLocation / CarrierJump fire ONLY for a carrier you own.
 *   - CargoTransfer names the commodity and the direction.
 *   - Docking at it gives the callsign, matched by MarketID.
 *
 * Pure module — unit-tested in tests/carrier.test.ts.
 */
import type { JournalEvent } from './types.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Tritium is the only carrier fuel; everything else transferred is stock. */
const FUEL = 'tritium';

export class CarrierTracker {
  /** Market/carrier id, present once the game has mentioned their carrier. */
  private carrierId: number | null = null;
  /** Callsign like "V6W-TTJ", learned when they dock at it. */
  private callsign: string | null = null;
  /** Where the carrier itself is, which is rarely where the commander is. */
  private system: string | null = null;
  /** Tons of tritium moved TO the carrier this session. */
  private fuelDelivered = 0;
  /** Tons of tritium sitting in the ship's hold, destined for it or not. */
  private lastTransferAt: string | null = null;

  owned(): boolean {
    return this.carrierId != null;
  }

  apply(ev: JournalEvent): void {
    switch (ev.event) {
      case 'CarrierLocation':
      case 'CarrierJump': {
        // Emitted only for a carrier the commander owns.
        const id = num(ev.CarrierID) ?? num(ev.MarketID);
        if (id != null) this.carrierId = id;
        const sys = str(ev.StarSystem);
        if (sys && ev.event === 'CarrierLocation') this.system = sys;
        break;
      }
      case 'CarrierStats': {
        const id = num(ev.CarrierID);
        if (id != null) this.carrierId = id;
        const call = str(ev.Callsign);
        if (call) this.callsign = call;
        break;
      }
      case 'Docked': {
        // Docking at their own carrier is how the callsign becomes known: the
        // station's MarketID matches the CarrierID the game already gave us.
        const type = str(ev.StationType) ?? '';
        if (!type.toLowerCase().includes('fleetcarrier')) break;
        const market = num(ev.MarketID);
        if (market == null || market !== this.carrierId) break;
        const name = str(ev.StationName);
        if (name) this.callsign = name;
        break;
      }
      case 'CargoTransfer': {
        const rows = Array.isArray(ev.Transfers)
          ? (ev.Transfers as Array<Record<string, unknown>>)
          : [];
        for (const r of rows) {
          if ((str(r.Direction) ?? '').toLowerCase() !== 'tocarrier') continue;
          // A transfer proves ownership even before any carrier event lands.
          if (this.carrierId == null) this.carrierId = -1;
          if ((str(r.Type) ?? '').toLowerCase().includes(FUEL)) {
            this.fuelDelivered += num(r.Count) ?? 0;
            this.lastTransferAt = ev.timestamp;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * One line of context, or null when they own no carrier. Deliberately states
   * what tritium IS for them, because the whole failure was the operator
   * treating a fuel run as a missed sales opportunity.
   */
  contextLine(): string | null {
    if (!this.owned()) return null;
    const who = this.callsign ? `fleet carrier ${this.callsign}` : 'a fleet carrier';
    const where = this.system ? `, currently parked in ${this.system}` : '';
    const fuel = this.fuelDelivered
      ? ` They have moved ${this.fuelDelivered} t of tritium to it this session — tritium is its jump fuel, so mined tritium is FUEL for them, not cargo to sell.`
      : ' Tritium is its jump fuel, so mined tritium may be fuel for them rather than cargo to sell.';
    return `The commander owns ${who}${where}.${fuel}`;
  }

  /** Everything worth persisting across restarts. */
  toJSON(): { carrierId: number | null; callsign: string | null; system: string | null } {
    return { carrierId: this.carrierId, callsign: this.callsign, system: this.system };
  }

  load(d: { carrierId?: number | null; callsign?: string | null; system?: string | null } | null): void {
    if (!d) return;
    if (d.carrierId != null) this.carrierId = d.carrierId;
    if (d.callsign) this.callsign = d.callsign;
    if (d.system) this.system = d.system;
  }

  /** Session counters reset on a new game session; ownership does not. */
  resetSession(): void {
    this.fuelDelivered = 0;
    this.lastTransferAt = null;
  }
}
