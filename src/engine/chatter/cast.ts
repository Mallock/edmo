/**
 * Who is talking, and whether you have heard them before.
 *
 * This is the module that separates a world from a quote generator. The
 * reference implementation casts a random voice per line, so its channel is
 * populated by an infinite crowd of strangers — which is why however good the
 * writing is, nothing accumulates. Here a callsign heard in a system is
 * remembered, keeps the same voice, and comes back.
 *
 * Two things persist. CAST is who exists, keyed by system. ARCS are the
 * threads they are in the middle of: a price they complained about, a faction
 * they resent, a grudge. An arc that has been set up gets complicated and then
 * paid off, by the same voice, possibly across sessions — and that is the
 * whole of "top tier space drama" as a mechanism rather than an aspiration.
 *
 * Personas are the audio half. The measured timbre window is narrow (design
 * D7a: 0.94..1.06, about one semitone), so distinctness is carried by radio
 * profile and speech quirk, with pitch as the weakest of the four axes. That
 * is a finding, not a preference — see scripts/pitch-spike.mjs.
 *
 * Pure module. Persistence is JSON in and JSON out; the store owns
 * localStorage, exactly as it does for MarketMemory and the news cast.
 */
import type { RadioProfileName } from './profiles.ts';
import type { ChannelId, DramaticFunction } from './types.ts';

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

/**
 * How someone talks, beyond their voice.
 *
 * Affects which grammar templates suit them and — later — how the LLM tier is
 * told to write for them. Does more work for perceived distinctness than pitch
 * does, which is fortunate, because pitch turned out to have almost none.
 */
export type Quirk =
  | 'clipped'
  | 'drawl'
  | 'formal'
  | 'bored'
  | 'dry'
  | 'anxious'
  | 'veteran'
  | 'green'
  | 'gruff'
  | 'cheerful';

export const QUIRKS: readonly Quirk[] = [
  'clipped',
  'drawl',
  'formal',
  'bored',
  'dry',
  'anxious',
  'veteran',
  'green',
  'gruff',
  'cheerful',
];

/**
 * Who this person actually is, in words the model can act on.
 *
 * The first cut used `quirk` only to nudge which template got picked, which is
 * to say it did nothing a listener could hear. A recurring callsign that keeps
 * the same voice but has no character is a synthesiser setting, not a person.
 * These go into the system prompt, so the haulier who is always slightly put
 * upon stays slightly put upon across sessions.
 */
export const QUIRK_CHARACTER: Readonly<Record<Quirk, string>> = {
  clipped: 'says the minimum. Procedure, no small talk, no wasted syllables.',
  drawl: 'unhurried to the point of rudeness. Takes the long way round a sentence.',
  formal: 'over-correct. Uses full procedure words where nobody else bothers.',
  bored: 'has done this ten thousand times and it shows. Flat, faintly insolent.',
  dry: 'deadpan. Understates everything, and is funnier than they intend to be.',
  anxious: 'checks things twice and mentions that they have. Slightly too much detail.',
  veteran: 'has seen worse and will imply it. Unbothered, quietly authoritative.',
  green: 'new enough to still be careful. Asks the question everyone else stopped asking.',
  gruff: 'blunt to the edge of rude, but not actually unkind. Short sentences.',
  cheerful: 'relentlessly upbeat in a job that does not warrant it.',
};

/**
 * The measured-usable timbre steps.
 *
 * Not a preference: outside this range the synth-slow/play-fast tempo
 * cancellation breaks down and the line audibly rushes (−12% duration at
 * r=1.2). Three steps per voice is what the spike actually supports.
 */
export const TIMBRE_STEPS: readonly number[] = [0.94, 1.0, 1.06];

export interface Persona {
  id: string;
  /** Piper voice name from PIPER_VOICE_CATALOG. */
  voice: string;
  /** One of TIMBRE_STEPS. */
  timbre: number;
  /** Overrides the channel's profile, or null to use the channel's own. */
  profile: RadioProfileName | null;
  quirk: Quirk;
  /** True when the voice was substituted because the original is not installed. */
  substituted?: boolean;
}

/**
 * Every persona available from the installed voices.
 *
 * Profile is left null here — the channel supplies it — because a persona that
 * carried its own profile would sound identical whether it was calling from a
 * station or a drifting hulk, which throws away the range modelling that makes
 * the channels worth having.
 */
export function buildPersonaPool(installedVoices: readonly string[]): Persona[] {
  const out: Persona[] = [];
  for (const voice of installedVoices) {
    for (const timbre of TIMBRE_STEPS) {
      for (const quirk of QUIRKS) {
        out.push({ id: `${voice}|${timbre}|${quirk}`, voice, timbre, profile: null, quirk });
      }
    }
  }
  return out;
}

/**
 * Make a persona usable with the voices actually present.
 *
 * A cast member persisted last month may name a voice the commander has since
 * removed. Silence would be the wrong answer — the character exists and has an
 * arc running — so a stable substitute is chosen instead, and the swap is
 * recorded so the panel can say so rather than quietly lying about continuity.
 */
export function resolvePersona(p: Persona, installedVoices: readonly string[]): Persona {
  if (installedVoices.includes(p.voice)) return p;
  if (!installedVoices.length) return { ...p, substituted: true };
  // Deterministic: the same missing voice always maps to the same replacement,
  // so a character does not change voice again on the next restart.
  let h = 0;
  for (const ch of p.voice) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const voice = installedVoices[h % installedVoices.length];
  return { ...p, voice, substituted: true };
}

// ---------------------------------------------------------------------------
// Arcs
// ---------------------------------------------------------------------------

export type ArcSubject = 'price' | 'faction' | 'build' | 'grudge' | 'personal';

export interface ArcBeat {
  at: string;
  func: DramaticFunction;
  summary: string;
}

export interface Arc {
  id: string;
  subjectKind: ArcSubject;
  /** What it is about — matches Brief.subjectKey. */
  subjectKey: string;
  beats: ArcBeat[];
  state: 'open' | 'paid' | 'dropped';
  /** When the subject was last observed, for the staleness sweep. */
  lastSeenAt: string;
}

/** How long an arc waits for its subject before being abandoned. */
export const ARC_STALE_MS = 14 * 24 * 3_600_000;

/** Functions that close an arc. Setting up forever is not a story. */
const PAYOFF: readonly DramaticFunction[] = ['reverse', 'aftermath'];

export function appendBeat(arc: Arc, beat: ArcBeat): Arc {
  const beats = [...arc.beats, beat].slice(-8);
  const state = PAYOFF.includes(beat.func) ? 'paid' : arc.state;
  return { ...arc, beats, state, lastSeenAt: beat.at };
}

export function isStale(arc: Arc, nowMs: number): boolean {
  return arc.state === 'open' && nowMs - Date.parse(arc.lastSeenAt) > ARC_STALE_MS;
}

// ---------------------------------------------------------------------------
// Cast members
// ---------------------------------------------------------------------------

export interface CastMember {
  name: string;
  persona: Persona;
  homeSystem: string;
  channel: ChannelId;
  /** The speakerRef family they can fill: 'control', 'hauler', 'crew:helm'… */
  role: string;
  firstAt: string;
  lastAt: string;
  /** Promoted from a real transmission the commander actually received. */
  real?: boolean;
  arcs: Arc[];
}

/** Systems kept before the least-recently-heard is evicted. */
export const MAX_SYSTEMS = 40;
/** Members kept per system. */
export const MAX_PER_SYSTEM = 8;

interface CastJson {
  v: 1;
  members: CastMember[];
}

/**
 * The book of who exists.
 *
 * Bounded on both axes, because this persists forever on a machine that also
 * has to run a game. Eviction is least-recently-heard, so the regulars in the
 * commander's home system survive and the one haulier heard once in a system
 * 4,000 ly away does not.
 */
export class CastBook {
  private members: CastMember[] = [];

  load(json: unknown): void {
    const data = json as CastJson | null;
    if (!data || data.v !== 1 || !Array.isArray(data.members)) return;
    this.members = data.members.filter(
      (m) => m && typeof m.name === 'string' && typeof m.homeSystem === 'string',
    );
  }

  toJSON(): CastJson {
    return { v: 1, members: this.members };
  }

  get size(): number {
    return this.members.length;
  }

  /** Everyone recorded in a system, most recently heard first. */
  forSystem(system: string): CastMember[] {
    return this.members
      .filter((m) => m.homeSystem === system)
      .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  }

  find(system: string, name: string): CastMember | undefined {
    return this.members.find((m) => m.homeSystem === system && m.name === name);
  }

  /**
   * Somebody in this system who can fill this role, or null.
   *
   * Preferring an existing member over a new invention is the entire point of
   * the book: it is what makes returning to a system feel like returning
   * somewhere rather than arriving somewhere new with the same scenery.
   */
  castFor(
    system: string,
    role: string,
    channel: ChannelId,
    rand: () => number,
  ): CastMember | null {
    const fits = this.members.filter(
      (m) => m.homeSystem === system && m.role === role && m.channel === channel,
    );
    if (!fits.length) return null;
    // Weight toward members with an open arc — they have somewhere to go.
    const withArc = fits.filter((m) => m.arcs.some((a) => a.state === 'open'));
    const pool = withArc.length && rand() < 0.7 ? withArc : fits;
    return pool[Math.floor(rand() * pool.length) % pool.length];
  }

  /** Record someone, or refresh them if they are already known. */
  remember(member: CastMember): CastMember {
    const existing = this.find(member.homeSystem, member.name);
    if (existing) {
      existing.lastAt = member.lastAt;
      return existing;
    }
    this.members.push(member);
    this.sweep(Date.parse(member.lastAt) || Date.now());
    return member;
  }

  /** Mark someone as heard just now. */
  touch(system: string, name: string, atIso: string): void {
    const m = this.find(system, name);
    if (m) m.lastAt = atIso;
  }

  /** Attach or update an arc on a member. */
  upsertArc(system: string, name: string, arc: Arc): void {
    const m = this.find(system, name);
    if (!m) return;
    const i = m.arcs.findIndex((a) => a.id === arc.id);
    if (i >= 0) m.arcs[i] = arc;
    else m.arcs.push(arc);
    // A character carrying six open threads is a soap opera, not a haulier.
    m.arcs = m.arcs.filter((a) => a.state === 'open').slice(-3).concat(
      m.arcs.filter((a) => a.state !== 'open').slice(-2),
    );
  }

  /** Every open arc, newest activity first. */
  openArcs(): Array<{ member: CastMember; arc: Arc }> {
    const out: Array<{ member: CastMember; arc: Arc }> = [];
    for (const m of this.members) {
      for (const a of m.arcs) if (a.state === 'open') out.push({ member: m, arc: a });
    }
    return out.sort((x, y) => Date.parse(y.arc.lastSeenAt) - Date.parse(x.arc.lastSeenAt));
  }

  /** Abandon arcs whose subject has gone quiet. Returns how many were dropped. */
  dropStaleArcs(nowMs: number): number {
    let n = 0;
    for (const m of this.members) {
      for (const a of m.arcs) {
        if (isStale(a, nowMs)) {
          a.state = 'dropped';
          n += 1;
        }
      }
    }
    return n;
  }

  /**
   * Enforce the caps.
   *
   * Per-system first, then globally by system count — doing it the other way
   * round would evict a whole busy system before trimming a bloated one.
   */
  private sweep(nowMs: number): void {
    const bySystem = new Map<string, CastMember[]>();
    for (const m of this.members) {
      const list = bySystem.get(m.homeSystem) ?? [];
      list.push(m);
      bySystem.set(m.homeSystem, list);
    }

    for (const [system, list] of bySystem) {
      if (list.length <= MAX_PER_SYSTEM) continue;
      // Keep the real ones and the ones with open arcs preferentially — they
      // carry continuity that an invented walk-on does not.
      const ranked = [...list].sort((a, b) => score(b, nowMs) - score(a, nowMs));
      bySystem.set(system, ranked.slice(0, MAX_PER_SYSTEM));
    }

    let systems = [...bySystem.entries()];
    if (systems.length > MAX_SYSTEMS) {
      systems = systems
        .sort((a, b) => latest(b[1]) - latest(a[1]))
        .slice(0, MAX_SYSTEMS);
    }
    this.members = systems.flatMap(([, list]) => list);
  }

  /** Force a sweep — the store calls this on a slow timer. */
  prune(nowMs: number): void {
    this.sweep(nowMs);
  }
}

function latest(list: CastMember[]): number {
  return Math.max(...list.map((m) => Date.parse(m.lastAt) || 0));
}

/** Higher survives eviction. Recency dominates; continuity breaks ties. */
function score(m: CastMember, nowMs: number): number {
  const ageH = Math.max(0, nowMs - (Date.parse(m.lastAt) || 0)) / 3_600_000;
  let s = -ageH;
  if (m.real) s += 48;
  if (m.arcs.some((a) => a.state === 'open')) s += 72;
  return s;
}

// ---------------------------------------------------------------------------
// Inventing someone
// ---------------------------------------------------------------------------

const GIVEN = [
  'Ines', 'Tobias', 'Marla', 'Otto', 'Priya', 'Cass', 'Hollis', 'Yusuf',
  'Renata', 'Dmitri', 'Nell', 'Amara', 'Soren', 'Wren', 'Bastian', 'Junia',
];
const FAMILY = [
  'Achebe', 'Vandermeer', 'Kowalczyk', 'Oyelaran', 'Brandt', 'Nakagawa',
  'Fiore', 'Duschene', 'Halloway', 'Sarkis', 'Petrov', 'Mbeki',
];

/**
 * A name for a new character.
 *
 * Roles that speak as an institution get the institution's name — traffic
 * control is "<station> control", not a person — because giving the tower a
 * first name is the tell that everything is generated.
 */
export function inventName(role: string, rand: () => number, context: string): string {
  if (role === 'control' || role === 'pa') return context;
  if (role === 'carrier') return context;
  const given = GIVEN[Math.floor(rand() * GIVEN.length) % GIVEN.length];
  const family = FAMILY[Math.floor(rand() * FAMILY.length) % FAMILY.length];
  return role.startsWith('crew:') ? family : `${given} ${family}`;
}

// ---------------------------------------------------------------------------
// Promotion from real transmissions
// ---------------------------------------------------------------------------

/** Message-code prefixes that mean the sender is shooting at you. */
const HOSTILE_CODE = /^\$?(Pirate|Interdiction|CargoHunter|PassengerHunter|Military_Hostile)/i;

/** How many real vessels may be enrolled per session. */
export const MAX_PROMOTIONS_PER_SESSION = 6;

export interface PromotionRequest {
  /** Localised sender name from the journal's ReceiveText. */
  from: string;
  /** The raw `Message` code, used to tell friendly traffic from hostile. */
  code: string;
  system: string;
  atIso: string;
}

/**
 * Should this real vessel become part of the recurring cast?
 *
 * Hostile senders are excluded deliberately. They already have a louder home
 * in the app (the combat feed), and enrolling the pirate who just tried to
 * kill the commander as a friendly regular in the local bar would be, at best,
 * a strange creative choice.
 */
export function canPromote(req: PromotionRequest, promotedThisSession: number): boolean {
  if (promotedThisSession >= MAX_PROMOTIONS_PER_SESSION) return false;
  if (!req.from.trim()) return false;
  if (HOSTILE_CODE.test(req.code)) return false;
  // Station plumbing is not a character.
  if (/^\$?(COMMS_entered|STATION_|DockingChatter)/i.test(req.code)) return false;
  return true;
}

export function promotionToMember(
  req: PromotionRequest,
  persona: Persona,
  channel: ChannelId = 'LOCAL',
): CastMember {
  return {
    name: req.from.trim(),
    persona,
    homeSystem: req.system,
    channel,
    role: 'hauler',
    firstAt: req.atIso,
    lastAt: req.atIso,
    real: true,
    arcs: [],
  };
}
