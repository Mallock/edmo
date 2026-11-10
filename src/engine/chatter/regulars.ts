/**
 * The regulars — named recurring voices with a bit, and a ledger of it.
 *
 * The cast book (cast.ts) remembers WHO exists in a system so a hauler you
 * heard last week keeps their voice. That is continuity of person. This is
 * continuity of JOKE: the man who is certain the station rotates to hide
 * something comes back an hour later with more evidence, the Sidewinder
 * pilot's insurance claim gains another adjuster, the bar with one working
 * chair now has a waiting list for it.
 *
 * Two things make that work as a mechanism rather than an aspiration.
 *
 * FIXED QUIRK. A regular is born with a character line and a speech quirk
 * from their category's archetype and a voice from whatever is installed, and
 * none of it changes. A callsign that keeps its name but changes its manner
 * is a synthesiser setting, not a person.
 *
 * THE LEDGER. What a regular actually said ON THE AIR — not what was written
 * for them, some of which never went out — is kept, and handed back to the
 * writer with one instruction: take a detail from it and make it worse. A
 * callback that merely references the earlier line is a rerun; escalation is
 * the bit. The ledger is capped, and a regular who has escalated all the way
 * is retired so a fresh one can be born with a fresh bit.
 *
 * Session-global, not per system. Geography would be truer and comedy would
 * be poorer: a running gag that only pays off if the commander returns to one
 * system is a gag that never pays off. The in-fiction cover is that these
 * people are on wide relays and the commander keeps landing on their band.
 *
 * Pure module. JSON in, JSON out; the store owns storage.
 */
import { TIMBRE_STEPS, type Persona } from './cast.ts';
import { TOPICS, type TopicCategory } from './topics.ts';

export interface Regular {
  id: string;
  name: string;
  category: TopicCategory;
  /** Fixed at birth. Follows "<name>, who …". */
  character: string;
  /** Fixed at birth — voice, timbre and quirk. */
  persona: Persona;
  /** Their running gag, in the writer's terms. */
  bit: string;
  /** What they said on the air, oldest first. */
  ledger: string[];
  /** Times heard. */
  heard: number;
  firstAt: string;
  lastAt: string;
}

/** Regulars kept per category — the conspiracy guy and one rival, at most. */
export const MAX_REGULARS_PER_CATEGORY = 2;
/** Lines of a regular's own remembered, oldest dropped first. */
export const LEDGER_DEPTH = 5;
/** Appearances before a regular retires and a fresh bit can be born. */
export const RETIRE_AFTER = 6;
/** A regular not heard for this long is forgotten. */
export const REGULAR_STALE_MS = 3 * 24 * 3_600_000;
/** How often an ambient beat is carried by a regular rather than a stranger,
 *  once one exists for the category. */
export const REGULAR_SHARE = 0.7;

const GIVEN = [
  'Dez', 'Marguerite', 'Kwame', 'Oksana', 'Bram', 'Lucille', 'Teodor', 'Anouk',
  'Rafael', 'Petra', 'Callum', 'Yaz', 'Ingrid', 'Femi', 'Roz', 'Sacha',
];
const FAMILY = [
  'Okonkwo', 'Falk', 'Marchetti', 'Ivarsson', 'Delacroix', 'Nwosu', 'Haugen',
  'Batista', 'Sorensen', 'Adeyemi', 'Kalani', 'Voss', 'Lindqvist', 'Obi',
];

interface RegularsJson {
  v: 1;
  members: Regular[];
}

export class RegularsBook {
  private members: Regular[] = [];
  private seq = 0;

  get size(): number {
    return this.members.length;
  }

  all(): readonly Regular[] {
    return this.members;
  }

  find(id: string): Regular | undefined {
    return this.members.find((m) => m.id === id);
  }

  forCategory(category: TopicCategory): Regular[] {
    return this.members
      .filter((m) => m.category === category)
      .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  }

  /** Bits already carried by somebody, so a newcomer does not double one. */
  takenBits(category: TopicCategory): Set<string> {
    return new Set(this.forCategory(category).map((m) => m.bit));
  }

  /**
   * Somebody to carry this beat.
   *
   * An existing regular most of the time when one exists — coming back is
   * the point — otherwise a new one until the category is full. `bit` is the
   * seed the caller rolled; it becomes the newcomer's running gag, and is
   * ignored when a returning voice already has one.
   */
  cast(
    category: TopicCategory,
    bit: string,
    rand: () => number,
    personas: readonly Persona[],
    atIso: string,
  ): Regular {
    const existing = this.forCategory(category);
    if (existing.length && (existing.length >= MAX_REGULARS_PER_CATEGORY || rand() < REGULAR_SHARE)) {
      return existing[Math.floor(rand() * existing.length) % existing.length];
    }
    return this.invent(category, bit, rand, personas, atIso);
  }

  private invent(
    category: TopicCategory,
    bit: string,
    rand: () => number,
    personas: readonly Persona[],
    atIso: string,
  ): Regular {
    const archetype = TOPICS[category].voice;
    const used = new Set(this.members.map((m) => m.name));
    let name = '';
    for (let i = 0; i < 8; i++) {
      const given = GIVEN[Math.floor(rand() * GIVEN.length) % GIVEN.length];
      const family = FAMILY[Math.floor(rand() * FAMILY.length) % FAMILY.length];
      name = `${given} ${family}`;
      if (!used.has(name)) break;
    }

    // The quirk is the archetype's; the voice is whichever installed one
    // fits it and is not already somebody's. A pool with no match for the
    // quirk falls back to any voice with the quirk stamped on, and no voices
    // at all yields a persona the cast resolver will substitute later.
    const taken = new Set(this.members.map((m) => m.persona.voice));
    const fits = personas.filter((p) => p.quirk === archetype.quirk);
    const fresh = fits.filter((p) => !taken.has(p.voice));
    const pool = fresh.length ? fresh : fits.length ? fits : personas;
    const base = pool.length ? pool[Math.floor(rand() * pool.length) % pool.length] : null;
    const persona: Persona = base
      ? { ...base, quirk: archetype.quirk, id: `${base.voice}|${base.timbre}|${archetype.quirk}` }
      : { id: `none|1|${archetype.quirk}`, voice: '', timbre: TIMBRE_STEPS[1], profile: null, quirk: archetype.quirk };

    this.seq += 1;
    const member: Regular = {
      id: `reg:${category}:${Date.parse(atIso) || Date.now()}:${this.seq}`,
      name,
      category,
      character: archetype.character,
      persona,
      bit,
      ledger: [],
      heard: 0,
      firstAt: atIso,
      lastAt: atIso,
    };
    this.members.push(member);
    return member;
  }

  /**
   * They were heard saying these lines. Only aired lines enter the ledger —
   * a line written and then dropped as late was never part of the bit.
   */
  noteAired(id: string, lines: readonly string[], atIso: string): void {
    const m = this.find(id);
    if (!m) return;
    const spoken = lines.map((l) => l.trim()).filter(Boolean);
    if (!spoken.length) return;
    m.ledger = [...m.ledger, ...spoken].slice(-LEDGER_DEPTH);
    m.heard += 1;
    m.lastAt = atIso;
    if (m.heard >= RETIRE_AFTER) this.members = this.members.filter((x) => x.id !== id);
  }

  /** Forget regulars nobody has heard in a while. Returns how many. */
  prune(nowMs: number): number {
    const before = this.members.length;
    this.members = this.members.filter((m) => nowMs - (Date.parse(m.lastAt) || 0) <= REGULAR_STALE_MS);
    return before - this.members.length;
  }

  load(json: unknown): void {
    const data = json as RegularsJson | null;
    if (!data || data.v !== 1 || !Array.isArray(data.members)) return;
    this.members = data.members.filter(
      (m) =>
        m &&
        typeof m.id === 'string' &&
        typeof m.name === 'string' &&
        typeof m.category === 'string' &&
        m.category in TOPICS &&
        m.persona &&
        typeof m.persona.voice === 'string',
    ).map((m) => ({
      ...m,
      ledger: Array.isArray(m.ledger) ? m.ledger.filter((l) => typeof l === 'string') : [],
      heard: typeof m.heard === 'number' ? m.heard : 0,
    }));
    this.seq = this.members.length;
  }

  toJSON(): RegularsJson {
    return { v: 1, members: this.members };
  }
}
