/**
 * Exploration value tracker.
 *
 * The engine already counts *how many* bodies were scanned; it never noticed
 * *what* they were. This folds `Scan` events to recognise the bodies that
 * actually pay — Earth-likes, water and ammonia worlds, terraformable
 * candidates, metal-rich bodies — flags the ones worth mapping (DSS) in the
 * current system, and keeps a running estimate of unsold cartographic value so
 * the operator can warn "you're carrying a fortune in survey data" before the
 * commander takes a fight.
 *
 * Body classification is exact. Credit figures are deliberately labelled
 * ballpark estimates (typical mapped payouts) rather than a reproduction of
 * Frontier's mass/first-footfall formula — enough to reason about, not to bank.
 */
import type { JournalEvent } from './types.ts';

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export interface ScannedBody {
  key: string; // systemAddress|bodyId
  system: string;
  body: string;
  planetClass: string; // localised-ish PlanetClass or StarType label
  tier: BodyTier;
  estValue: number; // ballpark mapped credits
  terraformable: boolean;
  landable: boolean;
  mapped: boolean; // DSS-mapped (SAAScanComplete) this session
  firstDiscovered: boolean;
  distanceLs?: number;
}

export type BodyTier = 'earthlike' | 'water' | 'ammonia' | 'terraformable' | 'metalrich' | 'other';

/** Typical mapped payouts (credits) — order-of-magnitude, not Frontier's exact
 *  formula. Terraformable candidates and ELWs are the "go map this" tier. */
const TIER_VALUE: Record<BodyTier, number> = {
  earthlike: 270_000,
  ammonia: 135_000,
  water: 90_000,
  terraformable: 150_000,
  metalrich: 60_000,
  other: 3_000,
};

/** Classify a Scan event's body into a payout tier. */
export function classifyBody(ev: JournalEvent): { tier: BodyTier; terraformable: boolean } {
  const pc = (str(ev.PlanetClass) ?? '').toLowerCase();
  const terraformable = /terraformable/i.test(str(ev.TerraformState) ?? '');
  if (!pc) return { tier: 'other', terraformable: false };
  if (pc.includes('earthlike')) return { tier: 'earthlike', terraformable };
  if (pc.includes('ammonia')) return { tier: 'ammonia', terraformable };
  if (pc.includes('water world')) return { tier: terraformable ? 'terraformable' : 'water', terraformable };
  if (terraformable) return { tier: 'terraformable', terraformable };
  if (pc.includes('metal rich') || pc.includes('metal-rich')) return { tier: 'metalrich', terraformable };
  return { tier: 'other', terraformable };
}

const HIGH_VALUE: ReadonlySet<BodyTier> = new Set(['earthlike', 'water', 'ammonia', 'terraformable', 'metalrich']);

/** Bound the ledger so a long expedition can't grow it without limit. */
const MAX_BODIES = 200;

export interface ExploreLead extends ScannedBody {
  inCurrentSystem: boolean;
}

export class ExploreTracker {
  private bodies = new Map<string, ScannedBody>();
  currentSystem = '';
  private currentAddress = '';
  /** Set after a fold that changed persistable state. */
  dirty = false;

  apply(ev: JournalEvent): void {
    switch (ev.event) {
      case 'FSDJump':
      case 'CarrierJump':
      case 'Location':
        this.currentSystem = str(ev.StarSystem) ?? this.currentSystem;
        this.currentAddress = ev.SystemAddress != null ? String(ev.SystemAddress) : this.currentAddress;
        break;
      case 'Scan':
        this.onScan(ev);
        break;
      case 'SAAScanComplete': {
        // DSS map completed for one body — mark it mapped so it drops off leads.
        const key = this.bodyKey(ev);
        const b = this.bodies.get(key);
        if (b && !b.mapped) {
          b.mapped = true;
          this.dirty = true;
        }
        break;
      }
      case 'SellExplorationData':
      case 'MultiSellExplorationData':
        // Data banked — clear the unsold ledger.
        if (this.bodies.size) {
          this.bodies.clear();
          this.dirty = true;
        }
        break;
      default:
        break;
    }
  }

  private bodyKey(ev: JournalEvent): string {
    const sysAddr = ev.SystemAddress != null ? String(ev.SystemAddress) : this.currentAddress;
    const bodyId = ev.BodyID != null ? String(ev.BodyID) : (str(ev.BodyName) ?? '');
    return `${sysAddr}|${bodyId}`;
  }

  private onScan(ev: JournalEvent): void {
    const body = str(ev.BodyName);
    if (!body) return;
    // Only planets carry PlanetClass; stars (StarType) are low-value here.
    if (!str(ev.PlanetClass)) return;
    const { tier, terraformable } = classifyBody(ev);
    const key = this.bodyKey(ev);
    const existing = this.bodies.get(key);
    const rec: ScannedBody = {
      key,
      system: str(ev.StarSystem) ?? this.currentSystem,
      body,
      planetClass: str(ev.PlanetClass) ?? 'body',
      tier,
      estValue: TIER_VALUE[tier],
      terraformable,
      landable: ev.Landable === true,
      mapped: existing?.mapped ?? false,
      firstDiscovered: ev.WasDiscovered === false,
      distanceLs: num(ev.DistanceFromArrivalLS),
    };
    this.bodies.set(key, rec);
    this.dirty = true;
    // Evict the lowest-value bodies once over the cap (leads/value keep the
    // ones that matter; the "other" tier goes first).
    if (this.bodies.size > MAX_BODIES) {
      const victim = [...this.bodies.values()].sort((a, b) => a.estValue - b.estValue)[0];
      if (victim && victim.key !== key) this.bodies.delete(victim.key);
    }
  }

  /** Estimated unsold cartographic value (mapped-tier ballpark). */
  unsoldValue(): number {
    let sum = 0;
    for (const b of this.bodies.values()) sum += b.estValue;
    return sum;
  }

  /** High-value bodies not yet DSS-mapped, current system first. */
  leads(): ExploreLead[] {
    const sys = this.currentSystem.toLowerCase();
    return [...this.bodies.values()]
      .filter((b) => HIGH_VALUE.has(b.tier) && !b.mapped)
      .map((b) => ({ ...b, inCurrentSystem: b.system.toLowerCase() === sys }))
      .sort(
        (a, b) =>
          Number(b.inCurrentSystem) - Number(a.inCurrentSystem) || b.estValue - a.estValue,
      );
  }

  /** One compact line for the AI context / risk note; null when nothing yet. */
  contextLine(): string | null {
    const val = this.unsoldValue();
    if (val < 10_000) return null;
    const leads = this.leads().filter((l) => l.inCurrentSystem);
    const here = leads.length
      ? ` Worth mapping here: ${leads.slice(0, 3).map((l) => `${l.body} (${l.planetClass}${l.terraformable ? ', terraformable' : ''})`).join(', ')}.`
      : '';
    return `~${val.toLocaleString('en-US')} cr of unsold cartographic data aboard.${here}`;
  }

  toJSON(): unknown {
    return [...this.bodies.values()];
  }

  load(data: unknown): void {
    if (!Array.isArray(data)) return;
    for (const b of data as ScannedBody[]) {
      if (b?.key) this.bodies.set(b.key, b);
    }
  }
}
