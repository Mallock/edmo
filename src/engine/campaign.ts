/**
 * The campaign spine — the story that survives the jump, computed.
 *
 * Everything narrative in this app is bounded: the dossier and cast arcs are
 * per-system, the SessionArc and act machine are per-session, the saga and
 * memory look backward. This module is the layer that carries a story FORWARD
 * across systems and sessions — a pursuer, a patron, threat clocks, a vow —
 * and it follows the same law as arc.ts: code folds the story, the model only
 * voices it. Nothing here calls an LLM, and nothing an LLM writes ever
 * mutates this state (on-air memory records accepted lines verbatim; it never
 * interprets them).
 *
 * The threads are ELECTED from journal evidence, never invented. Elite rolls
 * the dice — interdictions, mission outcomes, crimes, reputation — and the
 * fold below scores that evidence per faction with decay and hysteresis. An
 * invented nemesis would poison the grounded operator; an elected one is a
 * real minor faction every claim about which is checkable in the journal.
 */
import type { JournalEvent, Mission, SystemIntel } from './types.ts';
import type { ChapterKind } from './arc.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

export type ThreadRole = 'pursuer' | 'patron';
export type SpineVoice = 'operator' | 'news' | 'comms';
export const SPINE_VOICES: readonly SpineVoice[] = ['operator', 'news', 'comms'];

/** Evidence half-life: a week-old grudge argues at half strength. */
export const EVIDENCE_HALF_LIFE_MS = 7 * 24 * 3_600_000;
/** A thread opens at this decayed score… */
export const ELECTION_SCORE = 5;
/** …from at least this many distinct evidence kinds — one event is not a story. */
export const ELECTION_KINDS = 2;
/** A challenger must beat the incumbent by this factor to take the role over. */
export const USURP_FACTOR = 1.5;
/** Threat clocks are Starforged-style six-segment clocks. */
export const CLOCK_SEGMENTS = 6;
/** After a payoff the clock is frozen — no machine-gun escalations. */
export const PAYOFF_COOLDOWN_MS = 24 * 3_600_000;
/** A quiet week bleeds one segment off a clock. */
export const CLOCK_DECAY_MS = 7 * 24 * 3_600_000;
/** Standing hostility argues continuously at this weight (journal MyReputation). */
const STANDING_WEIGHT = 2;
const UNFRIENDLY_REP = -35;

interface Evidence {
  kind: string;
  score: number;
  at: number; // epoch ms
}

export interface ThreadBeat {
  at: string; // ISO
  text: string; // a REAL event, written by code — the operator's substrate
}

export interface OnAirLine {
  at: string; // ISO
  text: string; // an accepted comms line, verbatim — fiction, attributed as such
}

export interface SpineThread {
  role: ThreadRole;
  faction: string;
  clock: number; // 0..CLOCK_SEGMENTS
  clockMovedAt: string; // ISO — for quiet decay
  cooldownUntil: string; // ISO, '' when not cooling down
  beats: ThreadBeat[]; // last 8, newest last
  onAir: OnAirLine[]; // last 3, newest first
  electedAt: string; // ISO
}

export interface Payoff {
  role: ThreadRole;
  faction: string;
  /** The real beat that filled the clock — what the payoff is ABOUT. */
  cause: string;
  expiresAt: string; // ISO — an unconsumed directive dies with the cooldown
}

export interface CampaignJSON {
  commander: string;
  watermark: string;
  wmSeen?: number;
  evidence: Record<string, { pursuer: Evidence[]; patron: Evidence[] }>;
  pursuer: SpineThread | null;
  patron: SpineThread | null;
  vow: { text: string; strength: number; faction?: string; chapter?: ChapterKind } | null;
  payoffs: Partial<Record<SpineVoice, Payoff>>;
  missionFactions: Array<[number, string]>;
  interdictors: Array<[string, string]>;
}

/** Everything the formatters and the HUD read — data only, no methods. */
export interface CampaignView {
  pursuer: SpineThread | null;
  patron: SpineThread | null;
  vow: string | null;
  payoffs: Partial<Record<SpineVoice, Payoff>>;
}

export interface CampaignCtx {
  /** The current system's faction board, for standings and guards. */
  factions?: SystemIntel['factions'];
  /** Who runs the system just entered, for the pursuer's home-turf clock tick. */
  controlling?: string;
}

const BEATS_MAX = 8;
const ON_AIR_MAX = 3;
const EVIDENCE_MAX = 40;
const MISSION_MAP_MAX = 60;
const INTERDICTOR_MAP_MAX = 40;

function decayed(e: Evidence, nowMs: number): number {
  const age = Math.max(0, nowMs - e.at);
  return e.score * Math.pow(0.5, age / EVIDENCE_HALF_LIFE_MS);
}

export class CampaignTracker {
  commander = '';
  private watermark = 0; // epoch ms of the last folded event
  /** How many events have been folded AT the watermark second. Journal stamps
   *  are seconds-resolution and hand-in bursts share one — a bare timestamp
   *  watermark would drop every same-second sibling on the next bootstrap. */
  private wmSeen = 0;
  /** Transient replay cursor: counts the events this replay pass has walked at
   *  one second, against a skip target snapshotted when the cursor first
   *  touches that second — so exactly the PREVIOUS session's folds are skipped
   *  and this session's own folds are not re-skipped. A new pass begins only
   *  at relaunch (fresh tracker + load()), which nulls the cursor. */
  private replayCursor: { at: number; n: number; skip: number } | null = null;
  private evidence = new Map<string, { pursuer: Evidence[]; patron: Evidence[] }>();
  pursuer: SpineThread | null = null;
  patron: SpineThread | null = null;
  private vowState: { text: string; strength: number; faction?: string; chapter?: ChapterKind } | null =
    null;
  private payoffs: Partial<Record<SpineVoice, Payoff>> = {};
  /** MissionID → faction, so MissionFailed (which carries no faction) attributes. */
  private missionFactions = new Map<number, string>();
  /** Interdictor pilot name → faction, so EscapeInterdiction (no faction) attributes. */
  private interdictors = new Map<string, string>();
  /** Latest standings seen, faction → MyReputation, for guards between visits. */
  private standings = new Map<string, number>();

  // ------------------------------------------------------------------ folding

  /**
   * Fold one journal event. Returns true when campaign state changed (the
   * store persists on true). `replay` marks bootstrap replays: those respect
   * the watermark so history is never double-counted, while live events always
   * fold (journal seconds-resolution timestamps collide within a burst).
   */
  observe(ev: JournalEvent, ctx: CampaignCtx, replay = false): boolean {
    const at = Date.parse(ev.timestamp ?? '') || 0;
    if (replay) {
      if (at < this.watermark) return false;
      if (this.replayCursor?.at !== at) {
        this.replayCursor = { at, n: 0, skip: at === this.watermark ? this.wmSeen : 0 };
      }
      this.replayCursor.n += 1;
      if (this.replayCursor.n <= this.replayCursor.skip) return false;
    }
    if (at > this.watermark) {
      this.watermark = at;
      this.wmSeen = 1;
    } else if (at === this.watermark) {
      this.wmSeen += 1;
    }
    const nowIso = ev.timestamp ?? new Date(at).toISOString();
    let changed = false;

    // Standings refresh whenever a faction board rides in with the context.
    if (ctx.factions) {
      for (const f of ctx.factions) {
        if (f.reputation != null) this.standings.set(f.name, f.reputation);
      }
    }

    switch (ev.event) {
      case 'LoadGame':
      case 'Commander': {
        const name = str(ev.Commander) ?? str(ev.Name);
        if (name && this.commander && name !== this.commander) {
          this.reset();
          changed = true;
        }
        if (name && name !== this.commander) {
          this.commander = name;
          changed = true;
        }
        break;
      }
      case 'Interdicted': {
        const faction = str(ev.Faction);
        const pilot = str(ev.Interdictor_Localised) ?? str(ev.Interdictor);
        if (faction && pilot) this.rememberInterdictor(pilot, faction);
        if (faction) {
          this.addEvidence(faction, 'pursuer', 'interdiction', 3, at);
          const submitted = ev.Submitted === true;
          this.threadBeat(
            'pursuer',
            faction,
            nowIso,
            `interdicted by ${pilot ?? 'their ship'}${submitted ? ' — submitted' : ''}`,
            2,
            at,
          );
          changed = true;
        }
        break;
      }
      case 'EscapeInterdiction': {
        const pilot = str(ev.Interdictor_Localised) ?? str(ev.Interdictor);
        const faction = pilot ? this.interdictors.get(pilot.toLowerCase()) : undefined;
        if (faction) {
          this.addEvidence(faction, 'pursuer', 'interdiction', 2, at);
          this.threadBeat('pursuer', faction, nowIso, `shook off an interdiction by ${pilot}`, 1, at);
          changed = true;
        }
        break;
      }
      case 'CommitCrime': {
        const faction = str(ev.Faction);
        if (faction && (num(ev.Fine) || num(ev.Bounty))) {
          this.addEvidence(faction, 'pursuer', 'crime', 1, at);
          this.threadBeat('pursuer', faction, nowIso, `picked up a ${num(ev.Bounty) ? 'bounty' : 'fine'} with them`, 1, at);
          changed = true;
        }
        break;
      }
      case 'MissionAccepted': {
        const id = num(ev.MissionID);
        const faction = str(ev.Faction);
        if (id != null && faction) {
          this.missionFactions.set(id, faction);
          if (this.missionFactions.size > MISSION_MAP_MAX) {
            const first = this.missionFactions.keys().next().value;
            if (first != null) this.missionFactions.delete(first);
          }
          changed = true;
        }
        break;
      }
      case 'MissionCompleted': {
        const faction = str(ev.Faction);
        if (faction) {
          this.addEvidence(faction, 'patron', 'mission', 2, at);
          this.threadBeat('patron', faction, nowIso, 'completed a contract for them', 1, at);
          changed = true;
        }
        // Reputation pluses in the effects are their own evidence kind.
        const effects = Array.isArray(ev.FactionEffects) ? ev.FactionEffects : [];
        for (const fe of effects) {
          const rec = fe as Record<string, unknown>;
          const fname = str(rec.Faction);
          const rep = str(rec.Reputation);
          if (fname && rep && rep.includes('+')) {
            this.addEvidence(fname, 'patron', 'reputation', 1, at);
            changed = true;
          }
        }
        break;
      }
      case 'MissionFailed': {
        const id = num(ev.MissionID);
        const faction = id != null ? this.missionFactions.get(id) : undefined;
        if (faction) {
          this.addEvidence(faction, 'pursuer', 'mission-failed', 2, at);
          this.threadBeat('pursuer', faction, nowIso, 'failed a contract of theirs', 1, at);
          changed = true;
        }
        break;
      }
      case 'RedeemVoucher': {
        const list = Array.isArray(ev.Factions) ? ev.Factions : [];
        for (const f of list) {
          const rec = f as Record<string, unknown>;
          const fname = str(rec.Faction);
          if (fname) {
            this.addEvidence(fname, 'patron', 'voucher', 1, at);
            this.threadBeat('patron', fname, nowIso, 'cashed vouchers with them', 1, at);
            changed = true;
          }
        }
        break;
      }
      case 'CommunityGoalReward': {
        const fname = str(ev.Faction);
        if (fname) {
          this.addEvidence(fname, 'patron', 'community-goal', 2, at);
          changed = true;
        }
        break;
      }
      case 'FSDJump': {
        // Jumping into the pursuer's own turf tightens their clock.
        if (this.pursuer && ctx.controlling && ctx.controlling === this.pursuer.faction) {
          this.threadBeat('pursuer', this.pursuer.faction, nowIso, `entered ${str(ev.StarSystem) ?? 'a system'} — their turf`, 1, at);
          changed = true;
        }
        break;
      }
      default:
        break;
    }

    if (this.sweep(at)) changed = true;
    if (this.holdElections(at, nowIso)) changed = true;
    return changed;
  }

  private rememberInterdictor(pilot: string, faction: string): void {
    this.interdictors.set(pilot.toLowerCase(), faction);
    if (this.interdictors.size > INTERDICTOR_MAP_MAX) {
      const first = this.interdictors.keys().next().value;
      if (first != null) this.interdictors.delete(first);
    }
  }

  private addEvidence(faction: string, side: ThreadRole, kind: string, score: number, at: number): void {
    let entry = this.evidence.get(faction);
    if (!entry) {
      entry = { pursuer: [], patron: [] };
      this.evidence.set(faction, entry);
    }
    const list = entry[side];
    list.push({ kind, score, at });
    if (list.length > EVIDENCE_MAX) list.splice(0, list.length - EVIDENCE_MAX);
  }

  // ---------------------------------------------------------------- elections

  /** Decayed score plus the standing term; kinds seen alongside. */
  private scoreOf(faction: string, side: ThreadRole, nowMs: number): { score: number; kinds: Set<string> } {
    const entry = this.evidence.get(faction);
    const kinds = new Set<string>();
    let score = 0;
    if (entry) {
      for (const e of entry[side]) {
        const s = decayed(e, nowMs);
        if (s < 0.25) continue; // fully faded — argues for nothing
        score += s;
        kinds.add(e.kind);
      }
    }
    // Standing hostility is continuous evidence, not an event: while the
    // journal says they hate us, the pursuit case does not decay to nothing.
    if (side === 'pursuer') {
      const rep = this.standings.get(faction);
      if (rep != null && rep <= UNFRIENDLY_REP) {
        score += STANDING_WEIGHT;
        kinds.add('standing');
      }
    }
    return { score, kinds };
  }

  /** Reputation guards: a friend is not a nemesis, an enemy is not a patron. */
  private eligible(faction: string, side: ThreadRole, kinds: Set<string>): boolean {
    const other = side === 'pursuer' ? this.patron : this.pursuer;
    if (other && other.faction === faction) return false;
    const rep = this.standings.get(faction);
    if (side === 'pursuer') {
      // Friendly standing blocks election unless the aggression is repeated —
      // an ally whose ships keep pulling us over has picked a side.
      const aggressive = kinds.has('interdiction') || kinds.has('mission-failed');
      if (rep != null && rep > 15 && !aggressive) return false;
    } else {
      if (rep != null && rep < 0) return false;
    }
    return true;
  }

  /** Elect, usurp, and drop threads from the current evidence. */
  private holdElections(nowMs: number, nowIso: string): boolean {
    let changed = false;
    for (const role of ['pursuer', 'patron'] as const) {
      const incumbent = this[role];
      // The incumbent's case fades with its evidence; below the bar it closes.
      if (incumbent) {
        const { score } = this.scoreOf(incumbent.faction, role, nowMs);
        if (score < ELECTION_SCORE) {
          this[role] = null;
          changed = true;
        }
      }
      // The strongest eligible challenger.
      let best: { faction: string; score: number } | null = null;
      for (const faction of this.evidence.keys()) {
        const { score, kinds } = this.scoreOf(faction, role, nowMs);
        if (score < ELECTION_SCORE || kinds.size < ELECTION_KINDS) continue;
        if (!this.eligible(faction, role, kinds)) continue;
        if (!best || score > best.score) best = { faction, score };
      }
      if (!best) continue;
      const sitting = this[role];
      if (!sitting) {
        this[role] = this.newThread(role, best.faction, nowIso);
        changed = true;
      } else if (
        sitting.faction !== best.faction &&
        best.score > this.scoreOf(sitting.faction, role, nowMs).score * USURP_FACTOR
      ) {
        this[role] = this.newThread(role, best.faction, nowIso);
        changed = true;
      }
    }
    return changed;
  }

  private newThread(role: ThreadRole, faction: string, nowIso: string): SpineThread {
    return {
      role,
      faction,
      clock: 0,
      clockMovedAt: nowIso,
      cooldownUntil: '',
      beats: [],
      onAir: [],
      electedAt: nowIso,
    };
  }

  // ------------------------------------------------------------------- clocks

  /** A real event lands on a thread: record the beat, advance the clock. */
  private threadBeat(
    role: ThreadRole,
    faction: string,
    nowIso: string,
    text: string,
    segments: number,
    nowMs: number,
  ): void {
    const thread = this[role];
    if (!thread || thread.faction !== faction) return;
    // A repeat of the last beat still winds the clock, but the record keeps
    // one copy — "completed a contract for them" twice in a row says nothing
    // twice (seen verbatim in the real-journal replay).
    const last = thread.beats.at(-1);
    if (last?.text === text) last.at = nowIso;
    else thread.beats.push({ at: nowIso, text });
    if (thread.beats.length > BEATS_MAX) thread.beats.splice(0, thread.beats.length - BEATS_MAX);
    this.advanceClock(thread, segments, nowIso, nowMs, text);
  }

  private advanceClock(thread: SpineThread, segments: number, nowIso: string, nowMs: number, cause: string): void {
    if (thread.cooldownUntil && nowMs < Date.parse(thread.cooldownUntil)) return;
    thread.cooldownUntil = '';
    thread.clock = Math.min(CLOCK_SEGMENTS, thread.clock + segments);
    thread.clockMovedAt = nowIso;
    if (thread.clock >= CLOCK_SEGMENTS) {
      const expiresAt = new Date(nowMs + PAYOFF_COOLDOWN_MS).toISOString();
      for (const voice of SPINE_VOICES) {
        this.payoffs[voice] = { role: thread.role, faction: thread.faction, cause, expiresAt };
      }
      thread.clock = 0;
      thread.cooldownUntil = expiresAt;
    }
  }

  /** Quiet decay and directive expiry. Returns true when something moved. */
  sweep(nowMs: number): boolean {
    let changed = false;
    for (const role of ['pursuer', 'patron'] as const) {
      const thread = this[role];
      if (!thread || thread.clock === 0) continue;
      const idle = nowMs - Date.parse(thread.clockMovedAt);
      const steps = Math.floor(idle / CLOCK_DECAY_MS);
      if (steps > 0) {
        thread.clock = Math.max(0, thread.clock - steps);
        thread.clockMovedAt = new Date(nowMs).toISOString();
        changed = true;
      }
    }
    for (const voice of SPINE_VOICES) {
      const p = this.payoffs[voice];
      if (p && nowMs >= Date.parse(p.expiresAt)) {
        delete this.payoffs[voice];
        changed = true;
      }
    }
    return changed;
  }

  /** A voice spoke its payoff beat — the directive is spent for that voice. */
  consumePayoff(voice: SpineVoice): boolean {
    if (!this.payoffs[voice]) return false;
    delete this.payoffs[voice];
    return true;
  }

  /**
   * The player leans on the fiction ("advance a threat"): the dominant thread's
   * clock moves one segment, but never the last one — payoffs come from real
   * events only. Returns the escalated thread, or null with nothing elected.
   */
  advanceThreat(nowMs: number): SpineThread | null {
    const thread =
      this.pursuer && (!this.patron || this.pursuer.clock >= this.patron.clock)
        ? this.pursuer
        : (this.patron ?? this.pursuer);
    if (!thread) return null;
    if (thread.cooldownUntil && nowMs < Date.parse(thread.cooldownUntil)) return thread;
    if (thread.clock < CLOCK_SEGMENTS - 1) {
      thread.clock += 1;
      thread.clockMovedAt = new Date(nowMs).toISOString();
    }
    return thread;
  }

  // --------------------------------------------------------------------- vow

  /**
   * The standing promise, derived — never declared. Dominant mission faction
   * first; with no contracts, the session's chapter carries it. The incumbent
   * holds unless the new signal is STRICTLY stronger — but its own strength is
   * recomputed from the LIVE mission list every call, so a vow whose contracts
   * are all handed in yields instead of promising stale work for ever.
   */
  updateVow(missions: readonly Mission[], chapter: ChapterKind | null): boolean {
    const byFaction = new Map<string, number>();
    for (const m of missions) {
      if (!m.faction) continue;
      byFaction.set(m.faction, (byFaction.get(m.faction) ?? 0) + 1);
    }
    let best: { faction: string; count: number } | null = null;
    for (const [faction, count] of byFaction) {
      if (!best || count > best.count) best = { faction, count };
    }
    type Vow = { text: string; strength: number; faction?: string; chapter?: ChapterKind };
    // A single contract is an errand, not a promise — the real-journal replay
    // showed a one-mission vow flapping on every accept/complete cycle. Two or
    // more for the same faction is a commitment worth saying out loud.
    const next: Vow | null =
      best && best.count >= 2
        ? {
            text: `See the ${best.faction.replace(/^the\s+/i, '')} work through — ${best.count} contracts still open`,
            strength: best.count + 1,
            faction: best.faction,
          }
        : chapter
          ? { text: VOW_BY_CHAPTER[chapter], strength: 1, chapter }
          : null;
    if (!next) {
      if (this.vowState) {
        this.vowState = null;
        return true;
      }
      return false;
    }
    const sitting = this.vowState;
    if (sitting) {
      // Same subject: the text just tracks the count — that is not a flap.
      if (sitting.faction && sitting.faction === next.faction) {
        if (sitting.text === next.text) return false;
        this.vowState = next;
        return true;
      }
      // Different subject: the incumbent defends with its CURRENT strength.
      const current = sitting.faction
        ? (byFaction.get(sitting.faction) ?? 0) > 0
          ? (byFaction.get(sitting.faction) ?? 0) + 1
          : 0
        : sitting.chapter === chapter
          ? 1
          : 0;
      if (current >= next.strength) return false;
    }
    if (sitting?.text === next.text) return false;
    this.vowState = next;
    return true;
  }

  // ----------------------------------------------------------- on-air memory

  /**
   * Accepted comms lines that NAME an elected faction are remembered verbatim
   * — the raw material of cross-voice continuity. Word-boundary match only;
   * no interpretation, no LLM.
   */
  recordOnAir(lines: readonly string[], nowIso: string): boolean {
    let changed = false;
    for (const role of ['pursuer', 'patron'] as const) {
      const thread = this[role];
      if (!thread || thread.faction.length < 3) continue;
      const pattern = new RegExp(`\\b${escapeRegExp(thread.faction)}\\b`, 'i');
      let best: string | null = null;
      for (const line of lines) {
        if (!pattern.test(line)) continue;
        if (!best || line.length > best.length) best = line;
      }
      if (best) {
        thread.onAir.unshift({ at: nowIso, text: best });
        if (thread.onAir.length > ON_AIR_MAX) thread.onAir.length = ON_AIR_MAX;
        changed = true;
      }
    }
    return changed;
  }

  // -------------------------------------------------------------- view/state

  view(): CampaignView {
    return {
      pursuer: this.pursuer,
      patron: this.patron,
      vow: this.vowState?.text ?? null,
      payoffs: this.payoffs,
    };
  }

  reset(): void {
    this.evidence.clear();
    this.pursuer = null;
    this.patron = null;
    this.vowState = null;
    this.payoffs = {};
    this.missionFactions.clear();
    this.interdictors.clear();
    this.standings.clear();
    // watermark survives a reset on purpose: a new commander must not re-fold
    // the old commander's history into the fresh campaign.
  }

  toJSON(): CampaignJSON {
    return {
      commander: this.commander,
      watermark: this.watermark ? new Date(this.watermark).toISOString() : '',
      wmSeen: this.wmSeen,
      evidence: Object.fromEntries(this.evidence),
      pursuer: this.pursuer,
      patron: this.patron,
      vow: this.vowState,
      payoffs: this.payoffs,
      missionFactions: [...this.missionFactions],
      interdictors: [...this.interdictors],
    };
  }

  load(json: unknown): void {
    if (!json || typeof json !== 'object') return;
    const j = json as Partial<CampaignJSON>;
    this.commander = typeof j.commander === 'string' ? j.commander : '';
    this.watermark = j.watermark ? Date.parse(j.watermark) || 0 : 0;
    this.wmSeen = typeof j.wmSeen === 'number' ? j.wmSeen : this.watermark ? 1 : 0;
    this.replayCursor = null;
    this.evidence = new Map(Object.entries(j.evidence ?? {}));
    this.pursuer = j.pursuer ?? null;
    this.patron = j.patron ?? null;
    this.vowState = j.vow ?? null;
    this.payoffs = j.payoffs ?? {};
    this.missionFactions = new Map(j.missionFactions ?? []);
    this.interdictors = new Map(j.interdictors ?? []);
  }
}

const VOW_BY_CHAPTER: Record<ChapterKind, string> = {
  hauling: 'Keep the cargo moving and the ledger honest',
  mining: 'Work the rings until the hold pays for the trip',
  exobiology: 'Walk the worlds and bring every sample home',
  'passenger runs': 'Get every cabin where it is going, intact',
  'bounty hunting': 'Keep the lanes clear, one warrant at a time',
  'community-goal work': 'See the community effort over the line',
  exploring: 'Chart what nobody has charted and sell the truth of it',
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
