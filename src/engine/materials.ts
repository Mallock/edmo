/**
 * Materials & engineering tracker.
 *
 * The commander clearly engineers ships (EngineerCraft is one of the busiest
 * events in a real journal), yet the operator was blind to it. This folds the
 * material economy — the `Materials` login baseline, pickups/discards, trades,
 * mission material rewards, and blueprint crafting spend — into a live
 * inventory, plus engineer unlock progress, so the AI can answer "do I have the
 * mats for this roll?" and the operator can flag material windfalls.
 *
 * Pure and testable. Counts are best-effort: the game caps material storage,
 * but we track raw fold totals (a full grid never lies about "you have some").
 */
import type { JournalEvent } from './types.ts';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export type MatCategory = 'Raw' | 'Manufactured' | 'Encoded';

interface MatEntry {
  name: string; // internal key (lowercase)
  localised: string;
  count: number;
  category: MatCategory;
}

export type EngineerProgress = 'Unknown' | 'Known' | 'Invited' | 'Unlocked';

interface EngineerEntry {
  name: string;
  progress: EngineerProgress;
  rank: number; // 0–5
}

function normCategory(c: string | undefined): MatCategory | null {
  if (!c) return null;
  const l = c.toLowerCase();
  if (l.startsWith('raw')) return 'Raw';
  if (l.startsWith('manu')) return 'Manufactured';
  if (l.startsWith('enc')) return 'Encoded';
  return null;
}

export class MaterialsTracker {
  /** key = `${category}:${name}` → entry. */
  private mats = new Map<string, MatEntry>();
  private engineers = new Map<string, EngineerEntry>();
  /** Set when a fold changed something (store may persist). */
  dirty = false;

  private key(cat: MatCategory, name: string): string {
    return `${cat}:${name.toLowerCase()}`;
  }

  private add(cat: MatCategory, name: string, localised: string | undefined, delta: number): void {
    if (!name) return;
    const k = this.key(cat, name);
    const cur = this.mats.get(k);
    const next = Math.max(0, (cur?.count ?? 0) + delta);
    if (next === 0 && !cur) return;
    this.mats.set(k, {
      name: name.toLowerCase(),
      localised: localised ?? cur?.localised ?? name,
      count: next,
      category: cat,
    });
    this.dirty = true;
  }

  private setAbsolute(cat: MatCategory, name: string, localised: string | undefined, count: number): void {
    if (!name) return;
    this.mats.set(this.key(cat, name), {
      name: name.toLowerCase(),
      localised: localised ?? name,
      count: Math.max(0, count),
      category: cat,
    });
    this.dirty = true;
  }

  apply(ev: JournalEvent): void {
    switch (ev.event) {
      case 'Materials': {
        // Login baseline — authoritative full grid; replace what we have.
        this.mats.clear();
        for (const [cat, field] of [
          ['Raw', ev.Raw],
          ['Manufactured', ev.Manufactured],
          ['Encoded', ev.Encoded],
        ] as Array<[MatCategory, unknown]>) {
          if (!Array.isArray(field)) continue;
          for (const raw of field as Array<Record<string, unknown>>) {
            this.setAbsolute(cat, str(raw.Name) ?? '', str(raw.Name_Localised), num(raw.Count));
          }
        }
        this.dirty = true;
        break;
      }
      case 'MaterialCollected': {
        const cat = normCategory(str(ev.Category));
        if (cat) this.add(cat, str(ev.Name) ?? '', str(ev.Name_Localised), num(ev.Count) || 1);
        break;
      }
      case 'MaterialDiscarded': {
        const cat = normCategory(str(ev.Category));
        if (cat) this.add(cat, str(ev.Name) ?? '', str(ev.Name_Localised), -(num(ev.Count) || 1));
        break;
      }
      case 'MaterialTrade': {
        const paid = ev.Paid as Record<string, unknown> | undefined;
        const recv = ev.Received as Record<string, unknown> | undefined;
        if (paid) {
          const cat = normCategory(str(paid.Category));
          if (cat) this.add(cat, str(paid.Material) ?? '', str(paid.Material_Localised), -num(paid.Quantity));
        }
        if (recv) {
          const cat = normCategory(str(recv.Category));
          if (cat) this.add(cat, str(recv.Material) ?? '', str(recv.Material_Localised), num(recv.Quantity));
        }
        break;
      }
      case 'EngineerCraft':
      case 'Synthesis': {
        const ings = ev.Ingredients;
        // EngineerCraft ingredients are an array; Synthesis are too (newer) or a map (older).
        if (Array.isArray(ings)) {
          for (const raw of ings as Array<Record<string, unknown>>) {
            // Category isn't given here; decrement wherever the name matches.
            this.subtractByName(str(raw.Name) ?? '', num(raw.Count) || 1);
          }
        } else if (ings && typeof ings === 'object') {
          for (const [name, count] of Object.entries(ings as Record<string, unknown>)) {
            this.subtractByName(name, num(count) || 1);
          }
        }
        if (ev.event === 'EngineerCraft') this.foldEngineerFromCraft(ev);
        break;
      }
      case 'EngineerProgress': {
        if (Array.isArray(ev.Engineers)) {
          for (const raw of ev.Engineers as Array<Record<string, unknown>>) {
            this.foldEngineer(str(raw.Engineer), str(raw.Progress), num(raw.Rank));
          }
        } else if (str(ev.Engineer)) {
          this.foldEngineer(str(ev.Engineer), str(ev.Progress), num(ev.Rank));
        }
        break;
      }
      case 'MissionCompleted': {
        const rewards = ev.MaterialsReward;
        if (Array.isArray(rewards)) {
          for (const raw of rewards as Array<Record<string, unknown>>) {
            const cat = normCategory(str(raw.Category));
            if (cat) this.add(cat, str(raw.Name) ?? '', str(raw.Name_Localised), num(raw.Count) || 1);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private subtractByName(name: string, count: number): void {
    if (!name) return;
    const lower = name.toLowerCase();
    for (const cat of ['Raw', 'Manufactured', 'Encoded'] as MatCategory[]) {
      const k = this.key(cat, lower);
      if (this.mats.has(k)) {
        this.add(cat, lower, undefined, -count);
        return;
      }
    }
  }

  private foldEngineer(name: string | undefined, progress: string | undefined, rank: number): void {
    if (!name) return;
    const prog = (progress as EngineerProgress) ?? 'Known';
    const cur = this.engineers.get(name);
    if (cur && cur.progress === prog && cur.rank === rank) return;
    this.engineers.set(name, { name, progress: prog, rank });
    this.dirty = true;
  }

  private foldEngineerFromCraft(ev: JournalEvent): void {
    const name = str(ev.Engineer);
    if (!name) return;
    const cur = this.engineers.get(name);
    // A craft proves the engineer is unlocked; keep the best-known rank.
    this.foldEngineer(name, 'Unlocked', Math.max(cur?.rank ?? 0, num(ev.Level)));
  }

  count(name: string): number {
    const lower = name.toLowerCase();
    for (const cat of ['Raw', 'Manufactured', 'Encoded'] as MatCategory[]) {
      const e = this.mats.get(this.key(cat, lower));
      if (e) return e.count;
    }
    return 0;
  }

  totalByCategory(): Record<MatCategory, number> {
    const out: Record<MatCategory, number> = { Raw: 0, Manufactured: 0, Encoded: 0 };
    for (const e of this.mats.values()) out[e.category] += e.count;
    return out;
  }

  /** How many distinct materials are at or near their storage cap — a nudge to
   *  spend them before pickups start bouncing. (Caps vary; we treat ≥ threshold
   *  as "plenty".) */
  topMaterials(n = 3): string[] {
    return [...this.mats.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, n)
      .map((e) => `${e.count} ${e.localised}`);
  }

  unlockedEngineers(): string[] {
    return [...this.engineers.values()].filter((e) => e.progress === 'Unlocked').map((e) => e.name);
  }

  /** One compact line for the AI context, or null when nothing is known yet. */
  contextLine(): string | null {
    const totals = this.totalByCategory();
    const grand = totals.Raw + totals.Manufactured + totals.Encoded;
    if (grand === 0 && this.engineers.size === 0) return null;
    const bits: string[] = [];
    if (grand > 0)
      bits.push(`Materials: ${totals.Raw} raw, ${totals.Manufactured} manufactured, ${totals.Encoded} encoded`);
    const unlocked = this.unlockedEngineers();
    if (unlocked.length) bits.push(`${unlocked.length} engineers unlocked`);
    return bits.join(' · ');
  }

  toJSON(): unknown {
    return {
      mats: [...this.mats.values()],
      engineers: [...this.engineers.values()],
    };
  }

  load(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const d = data as { mats?: MatEntry[]; engineers?: EngineerEntry[] };
    if (Array.isArray(d.mats))
      for (const e of d.mats) if (e?.name && e.category) this.mats.set(this.key(e.category, e.name), e);
    if (Array.isArray(d.engineers))
      for (const e of d.engineers) if (e?.name) this.engineers.set(e.name, e);
  }
}
