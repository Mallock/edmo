/**
 * SessionStats — the operator's ledger. Folds economic and activity events so
 * the commander can be told what a session actually earned and what unbanked
 * value (bio samples, cartographic data) is riding along. Resets on LoadGame
 * (a new game session), so bootstrap replay of old sessions washes out.
 */
import type { JournalEvent } from './types.ts';
import { formatCredits } from './operator.ts';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export class SessionStats {
  missionCredits = 0;
  missionsCompleted = 0;
  bountyCredits = 0;
  bountyCount = 0;
  crewWages = 0;
  jumps = 0;
  distanceLy = 0;
  fuelScooped = 0;
  /** Tons of ore refined this session. */
  refinedOre = 0;
  /** Refined tonnage per ore type this session. */
  oreCounts: Record<string, number> = {};
  /** Completed (Analyse-stage) exobiology samples not yet sold. */
  unsoldBio = 0;
  /** Bodies scanned since cartographic data was last sold. */
  unsoldCarto = 0;
  /** Last known ship state (Loadout / HullDamage). */
  rebuy = 0;
  hullHealth = 1;
  cargoCapacity = 0;
  /** Credit balance at session start (LoadGame). */
  startCredits = 0;

  apply(ev: JournalEvent): void {
    switch (ev.event) {
      case 'LoadGame':
        this.resetSession();
        this.startCredits = num(ev.Credits);
        break;
      case 'MissionCompleted':
        this.missionCredits += num(ev.Reward);
        this.missionsCompleted += 1;
        break;
      case 'Bounty':
        this.bountyCredits += num(ev.TotalReward);
        this.bountyCount += 1;
        break;
      case 'NpcCrewPaidWage':
        this.crewWages += num(ev.Amount);
        break;
      case 'FSDJump':
        this.jumps += 1;
        this.distanceLy += num(ev.JumpDist);
        break;
      case 'FuelScoop':
        this.fuelScooped += num(ev.Scooped);
        break;
      case 'MiningRefined': {
        this.refinedOre += 1;
        const ore = str(ev.Type_Localised) ?? str(ev.Type) ?? 'ore';
        this.oreCounts[ore] = (this.oreCounts[ore] ?? 0) + 1;
        break;
      }
      case 'ScanOrganic':
        if (str(ev.ScanType) === 'Analyse') this.unsoldBio += 1;
        break;
      case 'SellOrganicData':
        this.unsoldBio = 0;
        break;
      case 'Scan':
        if (str(ev.BodyName)) this.unsoldCarto += 1;
        break;
      case 'SellExplorationData':
      case 'MultiSellExplorationData':
        this.unsoldCarto = 0;
        break;
      case 'Loadout':
        this.rebuy = num(ev.Rebuy) || this.rebuy;
        if (typeof ev.HullHealth === 'number') this.hullHealth = ev.HullHealth;
        if (num(ev.CargoCapacity) > 0) this.cargoCapacity = num(ev.CargoCapacity);
        break;
      case 'HullDamage':
        if (ev.PlayerPilot === true && ev.Fighter !== true && typeof ev.Health === 'number') {
          this.hullHealth = ev.Health;
        }
        break;
      default:
        break;
    }
  }

  private resetSession(): void {
    this.missionCredits = 0;
    this.missionsCompleted = 0;
    this.bountyCredits = 0;
    this.bountyCount = 0;
    this.crewWages = 0;
    this.jumps = 0;
    this.distanceLy = 0;
    this.fuelScooped = 0;
    this.refinedOre = 0;
    this.oreCounts = {};
    // unsoldBio / unsoldCarto deliberately survive: unsold value carries over.
  }

  earnedTotal(): number {
    return this.missionCredits + this.bountyCredits;
  }

  /** Most-refined ore types this session, e.g. ["12 t Platinum", "4 t Gold"]. */
  topOres(n = 2): string[] {
    return Object.entries(this.oreCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([ore, tons]) => `${tons} t ${ore}`);
  }

  /** Docked recap; null when there is nothing worth saying. */
  ledgerSummary(): string | null {
    if (
      this.earnedTotal() === 0 &&
      this.unsoldBio === 0 &&
      this.unsoldCarto < 5 &&
      this.refinedOre === 0
    )
      return null;
    const bits: string[] = [];
    if (this.missionsCompleted)
      bits.push(`${this.missionsCompleted} mission(s) paid ${formatCredits(this.missionCredits)}`);
    if (this.bountyCount)
      bits.push(`${this.bountyCount} bounties worth ${formatCredits(this.bountyCredits)}`);
    if (this.crewWages) bits.push(`crew took ${formatCredits(this.crewWages)} in wages`);
    if (this.jumps) bits.push(`${this.jumps} jump(s), ${this.distanceLy.toFixed(1)} ly`);
    if (this.refinedOre) bits.push(`${this.refinedOre} t of ore refined`);
    if (this.unsoldBio) bits.push(`${this.unsoldBio} bio sample(s) unbanked — Vista Genomics`);
    if (this.unsoldCarto >= 5) bits.push(`${this.unsoldCarto} scanned bodies of carto data unsold`);
    return bits.length ? `Session ledger: ${bits.join(' · ')}.` : null;
  }

  /** One-line risk note for combat-mission accepts; null if nothing to flag. */
  riskNote(): string | null {
    const bits: string[] = [];
    if (this.unsoldBio) bits.push(`${this.unsoldBio} unbanked bio sample(s) aboard`);
    if (this.hullHealth < 0.9) bits.push(`hull at ${Math.round(this.hullHealth * 100)}%`);
    if (bits.length === 0) return null;
    if (this.rebuy) bits.push(`rebuy ${formatCredits(this.rebuy)}`);
    return `Risk check: ${bits.join(' · ')}.`;
  }
}
