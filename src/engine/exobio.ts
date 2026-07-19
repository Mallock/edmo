/**
 * Exobiology tracker — remembers every body where the FSS/DSS found
 * biological signals and how many species the commander has actually
 * sampled there (ScanOrganic "Analyse" completes one), so the operator can
 * point at unclaimed Vista Genomics money the commander already discovered.
 */
import type { JournalEvent } from './types.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export interface BioBody {
  key: string; // systemAddress|bodyId
  system: string;
  body: string; // full body name, e.g. "Eol Prou PC-K c9-221 A 2"
  signals: number; // biological signal count = species present
  genuses: string[]; // localised genus names once DSS-mapped
  sampled: string[]; // genus names with a completed Analyse here
  landable?: boolean;
  distanceLs?: number;
  lastSeen: string;
}

export interface BioLead extends BioBody {
  remaining: number;
  inCurrentSystem: boolean;
}

const MAX_BODIES = 120;
const BIO_TYPE = /biological/i;

export class BioTracker {
  private bodies = new Map<string, BioBody>();
  private systemNames = new Map<string, string>(); // systemAddress -> name
  currentSystem = '';
  private currentAddress = '';
  /** True when apply() changed something persistable since the last save. */
  dirty = false;

  load(records: BioBody[]): void {
    for (const r of records) if (r && r.key) this.bodies.set(r.key, r);
  }

  toJSON(): BioBody[] {
    return [...this.bodies.values()];
  }

  apply(ev: JournalEvent): void {
    switch (ev.event) {
      case 'FSDJump':
      case 'CarrierJump':
      case 'Location': {
        const name = str(ev.StarSystem);
        const addr = num(ev.SystemAddress);
        if (name) this.currentSystem = name;
        if (addr != null) {
          this.currentAddress = String(addr);
          if (name) this.systemNames.set(this.currentAddress, name);
        }
        break;
      }
      case 'FSSBodySignals':
      case 'SAASignalsFound': {
        const signals = Array.isArray(ev.Signals)
          ? (ev.Signals as Array<Record<string, unknown>>)
          : [];
        const bio = signals.find((s) =>
          BIO_TYPE.test(str(s.Type_Localised) ?? str(s.Type) ?? ''),
        );
        const count = bio ? (num(bio.Count) ?? 0) : 0;
        if (count <= 0) break;
        const addr = num(ev.SystemAddress);
        const bodyId = num(ev.BodyID);
        const bodyName = str(ev.BodyName);
        if (addr == null || bodyId == null || !bodyName) break;
        const key = `${addr}|${bodyId}`;
        const existing = this.bodies.get(key);
        const genuses = Array.isArray(ev.Genuses)
          ? (ev.Genuses as Array<Record<string, unknown>>)
              .map((g) => str(g.Genus_Localised) ?? str(g.Genus) ?? '')
              .filter(Boolean)
          : (existing?.genuses ?? []);
        this.bodies.set(key, {
          key,
          system: this.systemNames.get(String(addr)) ?? existing?.system ?? this.currentSystem,
          body: bodyName,
          signals: Math.max(count, existing?.signals ?? 0),
          genuses,
          sampled: existing?.sampled ?? [],
          landable: existing?.landable,
          distanceLs: existing?.distanceLs,
          lastSeen: ev.timestamp,
        });
        this.trim();
        this.dirty = true;
        break;
      }
      case 'Scan': {
        const addr = num(ev.SystemAddress);
        const bodyId = num(ev.BodyID);
        if (addr == null || bodyId == null) break;
        const b = this.bodies.get(`${addr}|${bodyId}`);
        if (!b) break;
        if (typeof ev.Landable === 'boolean') b.landable = ev.Landable;
        const dist = num(ev.DistanceFromArrivalLS);
        if (dist != null) b.distanceLs = Math.round(dist);
        this.dirty = true;
        break;
      }
      case 'ScanOrganic': {
        if (str(ev.ScanType) !== 'Analyse') break;
        const addr = num(ev.SystemAddress);
        const bodyId = num(ev.Body);
        const genus = str(ev.Genus_Localised) ?? str(ev.Genus);
        if (addr == null || bodyId == null || !genus) break;
        const b = this.bodies.get(`${addr}|${bodyId}`);
        if (b && !b.sampled.includes(genus)) {
          b.sampled.push(genus);
          this.dirty = true;
        }
        break;
      }
      default:
        break;
    }
  }

  private trim(): void {
    if (this.bodies.size <= MAX_BODIES) return;
    const oldest = [...this.bodies.values()].sort(
      (a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen),
    )[0];
    this.bodies.delete(oldest.key);
  }

  /** Bodies with uncollected bio signals — current system first, then newest. */
  leads(exclude?: Set<string>): BioLead[] {
    const out: BioLead[] = [];
    for (const b of this.bodies.values()) {
      const remaining = b.signals - b.sampled.length;
      if (remaining <= 0) continue;
      if (exclude?.has(b.key)) continue;
      out.push({ ...b, remaining, inCurrentSystem: b.system === this.currentSystem });
    }
    return out.sort(
      (a, b) =>
        Number(b.inCurrentSystem) - Number(a.inCurrentSystem) ||
        Date.parse(b.lastSeen) - Date.parse(a.lastSeen),
    );
  }
}
