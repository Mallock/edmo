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
  /** Nobody has scanned this body before — a first log pays five times, which
   *  is the whole reason to detour for one. */
  untouched?: boolean;
  lastSeen: string;
}

export interface BioLead extends BioBody {
  remaining: number;
  inCurrentSystem: boolean;
}

const MAX_BODIES = 120;
/** Sample receipts are tiny and precious — keep far more of them than bodies. */
const MAX_SAMPLED = 600;
const BIO_TYPE = /biological/i;

/** Persisted shape. The bare array is the pre-history format, still accepted. */
export interface BioState {
  bodies: BioBody[];
  /** body key → genera with a completed Analyse, ever. */
  sampled: Record<string, string[]>;
}

export class BioTracker {
  private bodies = new Map<string, BioBody>();
  /**
   * Every genus ever analysed, per body — kept SEPARATELY from the body record.
   *
   * A completed sample is permanent and the body record is not: `bodies` is
   * capped and trimmed, and it only exists at all once an FSS/DSS signal event
   * has been folded. Storing the receipt inside the body meant a commander who
   * sampled Tussock Cultro on HIP 71120 2 e in August 2025 was told, a year
   * later while standing on that rock, that all four genera were still down
   * there — the app replays one previous session, so the receipt was long gone.
   */
  private sampled = new Map<string, string[]>();
  private systemNames = new Map<string, string>(); // systemAddress -> name
  currentSystem = '';
  private currentAddress = '';
  /** True when apply() changed something persistable since the last save. */
  dirty = false;

  load(data: BioBody[] | BioState | null): void {
    if (!data) return;
    const records = Array.isArray(data) ? data : (data.bodies ?? []);
    for (const r of records) if (r && r.key) this.bodies.set(r.key, r);
    const sampled = Array.isArray(data) ? null : data.sampled;
    for (const [key, genuses] of Object.entries(sampled ?? {})) {
      if (Array.isArray(genuses)) this.sampled.set(key, [...genuses]);
    }
    // Upgrading from the bare-array format: the receipts live on the bodies,
    // so lift them out rather than starting the history empty.
    for (const b of this.bodies.values()) {
      for (const g of b.sampled ?? []) this.noteSample(b.key, g);
    }
  }

  toJSON(): BioState {
    return { bodies: [...this.bodies.values()], sampled: Object.fromEntries(this.sampled) };
  }

  /** File a sample receipt, whether or not the body itself is known yet. */
  private noteSample(key: string, genus: string): boolean {
    const at = this.sampled.get(key);
    if (at) {
      if (at.includes(genus)) return false;
      at.push(genus);
    } else {
      this.sampled.set(key, [genus]);
      if (this.sampled.size > MAX_SAMPLED) {
        this.sampled.delete(this.sampled.keys().next().value as string);
      }
    }
    const b = this.bodies.get(key);
    if (b && !b.sampled.includes(genus)) b.sampled.push(genus);
    return true;
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
          // Seeded from the permanent receipts, so re-mapping a body — or
          // meeting it again after a trim — never resurrects finished genera.
          sampled: [...new Set([...(existing?.sampled ?? []), ...(this.sampled.get(key) ?? [])])],
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
        // WasDiscovered=false means virgin territory: a strong hint that a
        // sample here will be a first log (5x payout).
        if (typeof ev.WasDiscovered === 'boolean') b.untouched = !ev.WasDiscovered;
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
        // Filed even when the body is unknown to us. A historical sweep hands
        // over samples from sessions whose FSS/DSS events we will never see.
        if (this.noteSample(`${addr}|${bodyId}`, genus)) this.dirty = true;
        break;
      }
      default:
        break;
    }
  }

  /**
   * Genera the DSS found on this body that the commander has not completed.
   * Empty when the body is fully collected, unknown, or was never mapped —
   * "nothing left" and "we never looked" are both silence here, so callers
   * must not read an empty list as proof the rock is finished.
   */
  uncollectedOn(systemAddress: unknown, bodyId: unknown): string[] {
    const addr = num(systemAddress);
    const id = num(bodyId);
    if (addr == null || id == null) return [];
    const key = `${addr}|${id}`;
    const b = this.bodies.get(key);
    if (!b) return [];
    const receipts = new Set([...b.sampled, ...(this.sampled.get(key) ?? [])]);
    return b.genuses.filter((g) => !receipts.has(g));
  }

  private trim(): void {
    if (this.bodies.size <= MAX_BODIES) return;
    const oldest = [...this.bodies.values()].sort(
      (a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen),
    )[0];
    this.bodies.delete(oldest.key);
  }

  /**
   * How many of this body's genera are done.
   *
   * Counted against the genus list when the DSS gave us one, so a receipt for
   * a genus this body does not have — a mis-keyed or superseded entry — cannot
   * quietly mark the rock finished and hide real money.
   */
  private doneOn(b: BioBody): number {
    const receipts = new Set([...b.sampled, ...(this.sampled.get(b.key) ?? [])]);
    if (!b.genuses.length) return receipts.size;
    return b.genuses.filter((g) => receipts.has(g)).length;
  }

  /** Bodies with uncollected bio signals — current system first, then newest. */
  leads(exclude?: Set<string>): BioLead[] {
    const out: BioLead[] = [];
    for (const b of this.bodies.values()) {
      const remaining = b.signals - this.doneOn(b);
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
