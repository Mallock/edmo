/**
 * The ports you keep coming back to — a visit history for stations and carriers.
 *
 * The reference implementation (EDCoPilot) does docking as templated exchanges:
 * "<stationname> Docking Control to <callsign>, request docking clearance for
 * pad 04", then a grant, then a read-back. The furniture is exactly right and
 * this app already imitates it. What that approach cannot do is mean anything
 * by it — its warmest line is the fixed string "Welcome back, Commander",
 * addressed identically to a first-time arrival and to somebody who has docked
 * there two hundred times.
 *
 * The journal has always known the difference. Every `Docked` event ever
 * written is on disk, so a port can be greeted as what it actually is to this
 * commander: somewhere new, somewhere they were yesterday, or the place they
 * have come back to more than anywhere else. A welcome that knows is worth
 * more than a welcome that is merely warm.
 *
 * CARRIERS ARE DIFFERENT AND THE DIFFERENCE MATTERS. A fleet carrier is a
 * place that moves. Recording "you have docked at V6W-TTJ nine times" while
 * treating it as a fixed address would be wrong the moment it jumps, so a
 * carrier keeps WHERE IT WAS last seen and how many systems it has been in —
 * which is the interesting thing about a carrier anyway.
 *
 * Pure and storage-free: the store owns persistence, this owns the arithmetic.
 */

/** Journal station types that are somebody's mobile home rather than a place. */
const CARRIER_TYPES = /^(FleetCarrier|DockableFleetCarrier)$/i;

export interface PortRecord {
  name: string;
  /** Where it was when last docked at — a carrier's answer changes. */
  system: string;
  /** Journal StationType: Coriolis, Outpost, FleetCarrier, Bernal, … */
  type: string | null;
  /** Who runs it, when the journal says. */
  faction: string | null;
  economy: string | null;
  carrier: boolean;
  firstAtIso: string;
  lastAtIso: string;
  visits: number;
  /** Systems this port has been seen in — always 1 unless it flies. */
  systems: string[];
  /**
   * THE LEDGER — what the commander has actually done here.
   *
   * A visit count alone gives a welcome one thing to say, and it says it every
   * time. What a working port would really have on file is the trade: how much
   * came off this ship, what it was, what was paid, which jobs were taken here
   * and which were finished. That is a standing supply of things for the
   * controller and the dockhands to have an opinion about — the difference
   * between "welcome back" and "back again with more steel, I see".
   */
  missionsTaken: number;
  missionsDone: number;
  tonsBought: number;
  tonsSold: number;
  creditsEarned: number;
  /** The last few commodities moved here, most recent first. */
  goods: string[];
}

export interface DockingFact {
  name: string;
  system: string;
  type?: string | null;
  faction?: string | null;
  economy?: string | null;
  atIso: string;
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);

/** How long before a port stops counting as "just been here". */
const RECENT_MS = 36 * 3600_000;

/**
 * Ports the commander has actually docked at.
 *
 * Capped, because a long-haul commander touches thousands of ports and the
 * only ones worth remembering are the ones they return to. Eviction is by
 * least-recently-visited, never by visit count — a port visited once last
 * night is more relevant to tonight's radio than one visited nine times a
 * year ago.
 */
export class PortMemory {
  private ports = new Map<string, PortRecord>();
  private readonly cap: number;

  constructor(cap = 400) {
    this.cap = cap;
  }

  /** Fold one docking. Returns the record as it now stands. */
  dock(fact: DockingFact): PortRecord {
    const key = fact.name.toLowerCase();
    const carrier = CARRIER_TYPES.test(fact.type ?? '');
    const existing = this.ports.get(key);
    if (existing) {
      existing.visits++;
      existing.lastAtIso = fact.atIso;
      existing.system = fact.system;
      // A carrier's travels are the interesting part of its record.
      if (!existing.systems.includes(fact.system)) existing.systems.push(fact.system);
      if (fact.faction) existing.faction = fact.faction;
      if (fact.economy) existing.economy = fact.economy;
      if (fact.type) existing.type = fact.type;
      existing.carrier = existing.carrier || carrier;
      return existing;
    }
    const made: PortRecord = {
      name: fact.name,
      system: fact.system,
      type: fact.type ?? null,
      faction: fact.faction ?? null,
      economy: fact.economy ?? null,
      carrier,
      firstAtIso: fact.atIso,
      lastAtIso: fact.atIso,
      visits: 1,
      systems: [fact.system],
      missionsTaken: 0,
      missionsDone: 0,
      tonsBought: 0,
      tonsSold: 0,
      creditsEarned: 0,
      goods: [],
    };
    this.ports.set(key, made);
    this.evict();
    return made;
  }

  private evict(): void {
    if (this.ports.size <= this.cap) return;
    const order = [...this.ports.entries()].sort(
      (a, b) => Date.parse(a[1].lastAtIso) - Date.parse(b[1].lastAtIso),
    );
    for (const [k] of order.slice(0, this.ports.size - this.cap)) this.ports.delete(k);
  }

  /**
   * Record trade or mission activity against a port.
   *
   * Called with whatever the commander is docked at, so it silently does
   * nothing in open space — an event that happens nowhere belongs to no port,
   * and inventing an attribution would put another ship's cargo on this
   * station's books.
   */
  note(
    name: string | null | undefined,
    entry: {
      missionTaken?: boolean;
      missionDone?: boolean;
      bought?: number;
      sold?: number;
      credits?: number;
      commodity?: string | null;
    },
  ): void {
    if (!name) return;
    const rec = this.ports.get(name.toLowerCase());
    if (!rec) return;
    if (entry.missionTaken) rec.missionsTaken++;
    if (entry.missionDone) rec.missionsDone++;
    if (entry.bought) rec.tonsBought += entry.bought;
    if (entry.sold) rec.tonsSold += entry.sold;
    if (entry.credits) rec.creditsEarned += entry.credits;
    if (entry.commodity) {
      rec.goods = [entry.commodity, ...rec.goods.filter((g) => g !== entry.commodity)].slice(0, 6);
    }
  }

  get(name: string): PortRecord | null {
    return this.ports.get(name.toLowerCase()) ?? null;
  }

  /** Everything known, most recently visited first. */
  all(): PortRecord[] {
    return [...this.ports.values()].sort(
      (a, b) => Date.parse(b.lastAtIso) - Date.parse(a.lastAtIso),
    );
  }

  /** The ports this commander returns to most — their actual haunts. */
  haunts(n = 3): PortRecord[] {
    return [...this.ports.values()].sort((a, b) => b.visits - a.visits).slice(0, n);
  }

  size(): number {
    return this.ports.size;
  }

  toJSON(): PortRecord[] {
    return [...this.ports.values()];
  }

  static fromJSON(rows: unknown, cap = 400): PortMemory {
    const m = new PortMemory(cap);
    if (!Array.isArray(rows)) return m;
    for (const r of rows as PortRecord[]) {
      if (!r || typeof r.name !== 'string' || !r.name) continue;
      m.ports.set(r.name.toLowerCase(), {
        name: r.name,
        system: typeof r.system === 'string' ? r.system : 'unknown',
        type: r.type ?? null,
        faction: r.faction ?? null,
        economy: r.economy ?? null,
        carrier: r.carrier === true,
        firstAtIso: r.firstAtIso ?? r.lastAtIso ?? '',
        lastAtIso: r.lastAtIso ?? r.firstAtIso ?? '',
        visits: Number.isFinite(r.visits) && r.visits > 0 ? Math.floor(r.visits) : 1,
        systems: Array.isArray(r.systems) && r.systems.length ? r.systems.slice(0, 40) : [],
        missionsTaken: num(r.missionsTaken),
        missionsDone: num(r.missionsDone),
        tonsBought: num(r.tonsBought),
        tonsSold: num(r.tonsSold),
        creditsEarned: num(r.creditsEarned),
        goods: Array.isArray(r.goods) ? r.goods.slice(0, 6) : [],
      });
    }
    return m;
  }
}

/** "three days", "an hour", "yesterday" — the gap, in the words people use. */
function sinceWords(ms: number): string {
  const h = ms / 3600_000;
  if (h < 1.5) return 'within the hour';
  if (h < 20) return `${Math.round(h)} hours ago`;
  const d = Math.round(h / 24);
  if (d <= 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  const w = Math.round(d / 7);
  if (w < 9) return `${w} weeks ago`;
  return `${Math.round(d / 30)} months ago`;
}

/**
 * How this port should greet the commander — one line for the briefing.
 *
 * Deliberately a STATEMENT OF FACT rather than a scripted welcome. Handing the
 * writer "this is their ninth visit, the last one yesterday" lets it choose
 * whether that becomes warmth, boredom, a running joke or nothing at all; the
 * fixed-string approach can only ever produce the same warmth every time.
 *
 * `record` is the state BEFORE this arrival is counted, so a first arrival
 * genuinely reads as one.
 */
export function portGreeting(
  record: PortRecord | null,
  nowMs: number,
  name: string,
): string {
  if (!record || record.visits < 1) return `${name}: the commander has never docked here before`;
  const gap = nowMs - Date.parse(record.lastAtIso || '');
  const since = Number.isFinite(gap) && gap > 0 ? sinceWords(gap) : 'recently';
  const kind = record.carrier ? 'carrier' : 'port';
  if (record.visits === 1) return `${name}: been here once before, ${since}`;
  // A LAPSED regular is its own thing, and the real history is full of them:
  // 149 visits to a port nobody has seen for thirteen months. Saying "this
  // port knows the ship" in the present tense there is wrong in a way people
  // notice — the faces have changed and the commander is coming back to
  // somewhere that used to be theirs, which is a better scene anyway.
  const lapsed = Number.isFinite(gap) && gap > 120 * 24 * 3600_000;
  if (record.visits >= 12 && lapsed) {
    return `${name}: used to be a regular — ${record.visits} visits, but not since ${since}. Long enough that the faces will have changed`;
  }
  if (record.visits >= 12) {
    return `${name}: a regular — ${record.visits} visits, the last ${since}. This ${kind} knows the ship`;
  }
  if (lapsed) return `${name}: ${record.visits} visits, but nothing since ${since}`;
  return `${name}: ${record.visits} visits before this one, the last ${since}`;
}

/** True when the commander was here within a day and a half. */
export function justHere(record: PortRecord | null, nowMs: number): boolean {
  if (!record) return false;
  const gap = nowMs - Date.parse(record.lastAtIso || '');
  return Number.isFinite(gap) && gap >= 0 && gap < RECENT_MS;
}

/**
 * A carrier's travels, when it has any — "seen in 4 systems, now at HIP 71120".
 *
 * Returns null for anything that has only ever been in one place, which is
 * every ordinary station and a carrier that has not jumped since it was met.
 */
export function carrierTravels(record: PortRecord | null): string | null {
  if (!record?.carrier || record.systems.length < 2) return null;
  return `${record.name} has been parked in ${record.systems.length} different systems since the commander first docked with it, most recently ${record.system}`;
}

/**
 * The station's own file on this ship — one line, only when there is one.
 *
 * The point of the ledger is that a port always has SOMETHING to talk about
 * after a few visits: what keeps arriving, which jobs were taken here, whether
 * the last lot ever got finished. A visit count on its own gives a controller
 * one remark and they make it every time.
 *
 * Returns null rather than an empty shell when the commander has only ever
 * passed through — nothing on file is itself worth saying, and the greeting
 * already says it.
 */
export function portLedger(record: PortRecord | null): string | null {
  if (!record) return null;
  const bits: string[] = [];
  // Taken here and handed in here are DIFFERENT counts — a courier job is
  // accepted at one station and completed at another, so phrasing them as a
  // fraction ("4 taken, 2 finished") would imply two of those four came back,
  // which the journal does not say.
  if (record.missionsTaken > 0) {
    bits.push(`${record.missionsTaken} job${record.missionsTaken === 1 ? '' : 's'} taken here`);
  }
  if (record.missionsDone > 0) {
    bits.push(`${record.missionsDone} handed in here`);
  }
  const tons = record.tonsBought + record.tonsSold;
  if (tons > 0) {
    bits.push(`${Math.round(tons).toLocaleString('en-US')} t moved across the pad`);
  }
  if (record.goods.length) {
    bits.push(`usually ${record.goods.slice(0, 3).join(', ')}`);
  }
  // Billions read as nonsense in millions — "8711.5m" was on a real record.
  if (record.creditsEarned > 1_000_000_000) {
    bits.push(`${(record.creditsEarned / 1_000_000_000).toFixed(1)}bn credits paid out to this ship`);
  } else if (record.creditsEarned > 1_000_000) {
    bits.push(`${Math.round(record.creditsEarned / 1_000_000)}m credits paid out to this ship`);
  }
  if (!bits.length) return null;
  return `On file at ${record.name}: ${bits.join(' · ')}`;
}
