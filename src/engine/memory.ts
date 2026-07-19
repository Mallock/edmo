/**
 * CommanderMemory — the operator's persistent long-term memory bank.
 *
 * Three layers:
 *  - Deterministic ledgers folded straight from the journal: per-faction and
 *    per-system tallies, personal records, deaths, ranks. Replay-safe via a
 *    timestamp watermark, so bootstrap re-reads never double-count — and the
 *    very first run inherits months of history from the replayed sessions.
 *  - Notes: durable one-line memories. Auto-notes for defining moments
 *    (deaths, promotions) plus LLM-distilled reflections at session end
 *    (buildReflectionChat → addReflections, schema-constrained JSON).
 *  - Recall & proactive triggers: recallForContext() injects the relevant
 *    slice into every AI prompt; apply() returns MemoryEvent candidates the
 *    store may speak. The DECISION to speak lives in deterministic code
 *    (gateAnnounce cooldowns + store-side global throttle), never with the
 *    model — a chatty model cannot flood the commander.
 */
import type { ChatMessage } from './lmstudio.ts';
import type { JournalEvent } from './types.ts';
import { formatCredits } from './operator.ts';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export type MemoryNoteKind =
  | 'record'
  | 'close_call'
  | 'relationship'
  | 'first'
  | 'habit'
  | 'loss'
  | 'moment';

export interface MemoryNote {
  text: string;
  kind: MemoryNoteKind;
  importance: 1 | 2 | 3;
  at: number; // ms epoch
  system?: string;
  faction?: string;
  source: 'journal' | 'reflection';
}

/** A proactive remark candidate. The store decides whether it is spoken. */
export interface MemoryEvent {
  kind: 'record' | 'milestone' | 'returnTo' | 'promotion';
  key: string; // announce-gate key (see gateAnnounce)
  text: string; // speakable as-is
  importance: 2 | 3;
}

interface FactionLedger {
  done: number;
  failed: number;
  lastAt: number;
}

interface SystemLedger {
  visits: number;
  firstAt: number;
  lastAt: number;
  deaths: number;
}

interface RecordEntry {
  value: number;
  text: string;
  at: number;
}

const NOTE_CAP_MAJOR = 40; // importance 3
const NOTE_CAP_MINOR = 60; // importance 1-2
const MILESTONES = [5, 10, 25, 50, 100, 250, 500];

const RANK_NAMES: Record<string, string[]> = {
  Combat: ['Harmless', 'Mostly Harmless', 'Novice', 'Competent', 'Expert', 'Master', 'Dangerous', 'Deadly', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'],
  Trade: ['Penniless', 'Mostly Penniless', 'Peddler', 'Dealer', 'Merchant', 'Broker', 'Entrepreneur', 'Tycoon', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'],
  Explore: ['Aimless', 'Mostly Aimless', 'Scout', 'Surveyor', 'Trailblazer', 'Pathfinder', 'Ranger', 'Pioneer', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'],
  Soldier: ['Defenceless', 'Mostly Defenceless', 'Rookie', 'Soldier', 'Gunslinger', 'Warrior', 'Gladiator', 'Deadeye', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'],
  Exobiologist: ['Directionless', 'Mostly Directionless', 'Compiler', 'Collector', 'Cataloguer', 'Taxonomist', 'Ecologist', 'Geneticist', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'],
};

function rankName(kind: string, v: number): string {
  const names = RANK_NAMES[kind];
  return names?.[v] ? `${names[v]} (${kind})` : `${kind} rank ${v}`;
}

/** Normalized token set for near-duplicate note detection. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

function similar(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let both = 0;
  for (const w of ta) if (tb.has(w)) both += 1;
  return both / Math.min(ta.size, tb.size) > 0.6;
}

export class CommanderMemory {
  cmdr = '';
  /** Ship currently in use (last LoadGame/Loadout/SetUserShipName). */
  shipName = '';
  factions: Record<string, FactionLedger> = {};
  systems: Record<string, SystemLedger> = {};
  /** Per-ship activity — events are credited to the ship IN USE at the time,
   *  never retroactively to the current one (the commander runs a fleet:
   *  a hauler's deliveries must not end up on the mining ship's record).
   *  `type` is the hull ("lakonminer", "Type8") so the AI can resolve
   *  "the mining ship" to a name. */
  ships: Record<string, { missions: number; bounties: number; jumps: number; lastAt: number; type?: string }> = {};
  /** Hull type currently in use (journal `Ship` field). */
  shipType = '';
  records: Record<string, RecordEntry> = {};
  ranks: Record<string, number> = {};
  totals = { missions: 0, failed: 0, bounties: 0, deaths: 0, jumps: 0 };
  notes: MemoryNote[] = [];
  /** Announce gate: key → last-announced ms epoch (persisted). */
  announced: Record<string, number> = {};
  /** Set after any fold that changed state — store persists and clears. */
  dirty = false;

  private watermark = 0;
  /** Exact events already folded within the watermark second — journal
   *  timestamps have 1 s resolution and bursts share it (an FSDJump lands in
   *  the same second as arrival comms), so the watermark alone can't tell a
   *  replayed event from a new same-second one. */
  private watermarkSeen = new Set<string>();
  private currentSystem = '';
  private sessionEarned = 0;
  private sessionRecordFlagged = false;

  // ------------------------------------------------------------------- fold
  apply(ev: JournalEvent): MemoryEvent[] {
    const at = Date.parse(ev.timestamp);
    if (Number.isNaN(at)) return [];
    // Bootstrap replays the same sessions at every app start; the watermark
    // makes refolds a no-op while the first run still inherits full history.
    const skip = (): MemoryEvent[] => {
      // Location tracking must survive replay-skips or death/return anchors
      // attach to a stale system after a restart mid-session.
      if (ev.event === 'FSDJump' || ev.event === 'Location') {
        this.currentSystem = str(ev.StarSystem) ?? this.currentSystem;
      }
      return [];
    };
    if (at < this.watermark) return skip();
    const key = JSON.stringify(ev);
    if (at === this.watermark) {
      if (this.watermarkSeen.has(key)) return skip();
      this.watermarkSeen.add(key);
    } else {
      this.watermark = at;
      this.watermarkSeen = new Set([key]);
    }
    const out: MemoryEvent[] = [];

    switch (ev.event) {
      case 'Commander':
        this.setDirty(this.cmdr !== str(ev.Name));
        this.cmdr = str(ev.Name) ?? this.cmdr;
        break;
      case 'LoadGame':
        this.cmdr = str(ev.Commander) ?? this.cmdr;
        if (str(ev.ShipName)) this.shipName = str(ev.ShipName)!;
        this.shipType = str(ev.Ship_Localised) ?? str(ev.Ship) ?? this.shipType;
        this.sessionEarned = 0;
        this.sessionRecordFlagged = false;
        this.dirty = true;
        break;
      case 'Loadout':
      case 'SetUserShipName':
        if (str(ev.ShipName)) this.shipName = str(ev.ShipName)!;
        this.shipType = str(ev.Ship_Localised) ?? str(ev.Ship) ?? this.shipType;
        break;
      case 'Location':
        this.currentSystem = str(ev.StarSystem) ?? this.currentSystem;
        break;
      case 'FSDJump': {
        const sys = str(ev.StarSystem);
        if (!sys) break;
        this.totals.jumps += 1;
        this.creditShip('jumps', at);
        const prev = this.systems[sys];
        const prevLastAt = prev?.lastAt ?? 0;
        const led = prev ?? { visits: 0, firstAt: at, lastAt: at, deaths: 0 };
        led.visits += 1;
        led.lastAt = at;
        this.systems[sys] = led;
        this.currentSystem = sys;
        this.dirty = true;
        const dist = num(ev.JumpDist);
        const jumpEv = this.bumpRecord('jump', dist, `Longest jump: ${dist.toFixed(1)} ly into ${sys}`, at, 0.5);
        if (jumpEv) out.push({ kind: 'record', key: `record:jump:${Math.round(dist * 10)}`, importance: 2, text: `New personal best jump, commander — ${dist.toFixed(1)} light years.` });
        // Returning somewhere memorable — but only after a real absence, so
        // in-system hopping and busy loops stay silent.
        if (prev && at - prevLastAt > 20 * 3600_000) {
          if (prev.deaths > 0) {
            out.push({
              kind: 'returnTo',
              key: `return:${sys}`,
              importance: 3,
              text: `${sys} again. We've lost a ship here before, commander — fly like you remember it.`,
            });
          } else {
            const note = this.notes
              .filter((n) => n.system === sys && n.importance >= 2)
              .sort((a, b) => b.importance - a.importance || b.at - a.at)[0];
            if (note) {
              out.push({
                kind: 'returnTo',
                key: `return:${sys}`,
                importance: 2,
                text: `Back in ${sys}, commander. Last time: ${note.text}`,
              });
            }
          }
        }
        break;
      }
      case 'Died': {
        const sys = this.currentSystem || 'deep space';
        this.totals.deaths += 1;
        const led = this.systems[sys];
        if (led) led.deaths += 1;
        const killer =
          str(ev.KillerName_Localised) ?? str(ev.KillerName) ?? '';
        this.addNote({
          text: `Lost a ship in ${sys}${killer ? ` to ${killer}` : ''}.`,
          kind: 'loss',
          importance: 3,
          at,
          system: sys,
          source: 'journal',
        });
        // Deliberately NOT a spoken remark — the game just made the point.
        break;
      }
      case 'MissionCompleted': {
        const faction = str(ev.Faction);
        const reward = num(ev.Reward);
        this.totals.missions += 1;
        this.creditShip('missions', at);
        this.sessionEarned += reward;
        this.dirty = true;
        if (faction) {
          const led = this.factions[faction] ?? { done: 0, failed: 0, lastAt: at };
          led.done += 1;
          led.lastAt = at;
          this.factions[faction] = led;
          if (MILESTONES.includes(led.done)) {
            out.push({
              kind: 'milestone',
              key: `fac:${faction}:${led.done}`,
              importance: 2,
              text: `That was your ${this.ordinal(led.done)} completed contract for ${faction}, commander — they know your name by now.`,
            });
          }
        }
        const recEv = this.bumpRecord('mission', reward, `Richest single mission: ${formatCredits(reward)} (${str(ev.LocalisedName) ?? 'contract'})`, at, 1000);
        if (recEv) out.push({ kind: 'record', key: `record:mission:${reward}`, importance: 3, text: `${formatCredits(reward)} — that's your richest single contract ever, commander.` });
        out.push(...this.checkSessionRecord(at));
        break;
      }
      case 'MissionFailed':
      case 'MissionAbandoned': {
        const faction = str(ev.Faction);
        this.totals.failed += 1;
        if (faction) {
          const led = this.factions[faction] ?? { done: 0, failed: 0, lastAt: at };
          led.failed += 1;
          led.lastAt = at;
          this.factions[faction] = led;
        }
        this.dirty = true;
        break;
      }
      case 'Bounty': {
        const reward = num(ev.TotalReward);
        this.totals.bounties += 1;
        this.creditShip('bounties', at);
        this.sessionEarned += reward;
        this.dirty = true;
        const recEv = this.bumpRecord('bounty', reward, `Biggest single bounty: ${formatCredits(reward)}`, at, 1000);
        if (recEv) out.push({ kind: 'record', key: `record:bounty:${reward}`, importance: 2, text: `${formatCredits(reward)} on one kill — biggest bounty you've ever collected.` });
        out.push(...this.checkSessionRecord(at));
        break;
      }
      case 'Promotion': {
        for (const kind of Object.keys(RANK_NAMES)) {
          const v = ev[kind];
          if (typeof v !== 'number') continue;
          this.ranks[kind] = v;
          const name = rankName(kind, v);
          this.addNote({ text: `Promoted to ${name}.`, kind: 'moment', importance: 3, at, source: 'journal' });
          out.push({ kind: 'promotion', key: `rank:${kind}:${v}`, importance: 3, text: `Promotion confirmed, commander: ${name}. Well earned.` });
        }
        break;
      }
      default:
        break;
    }
    if (out.length) this.dirty = true;
    return out;
  }

  private setDirty(changed: boolean): void {
    if (changed) this.dirty = true;
  }

  private creditShip(field: 'missions' | 'bounties' | 'jumps', at: number): void {
    if (!this.shipName) return;
    const led = this.ships[this.shipName] ?? { missions: 0, bounties: 0, jumps: 0, lastAt: at };
    led[field] += 1;
    led.lastAt = at;
    if (this.shipType) led.type = this.shipType;
    this.ships[this.shipName] = led;
  }

  private ordinal(n: number): string {
    return n === 5 ? 'fifth' : n === 10 ? 'tenth' : `${n}th`;
  }

  /** Update a record entry; returns true when a previous record was beaten. */
  private bumpRecord(key: string, value: number, text: string, at: number, minValue: number): boolean {
    if (value <= minValue) return false;
    const old = this.records[key];
    if (!old) {
      // First observation seeds the baseline silently — announcing "a record"
      // on the first bounty ever folded would be noise.
      this.records[key] = { value, text, at };
      this.dirty = true;
      return false;
    }
    if (value > old.value) {
      this.records[key] = { value, text, at };
      this.dirty = true;
      return true;
    }
    return false;
  }

  private checkSessionRecord(at: number): MemoryEvent[] {
    const old = this.records['session'];
    if (old && this.sessionEarned > old.value && !this.sessionRecordFlagged) {
      this.sessionRecordFlagged = true;
      this.records['session'] = { value: this.sessionEarned, text: `Best session earnings: ${formatCredits(this.sessionEarned)}`, at };
      return [{
        kind: 'record',
        key: `record:session:${Math.round(this.sessionEarned / 1000)}`,
        importance: 2,
        text: `This is officially your best session ever, commander — ${formatCredits(this.sessionEarned)} and counting.`,
      }];
    }
    if (old && this.sessionEarned > old.value) {
      this.records['session'] = { ...old, value: this.sessionEarned, text: `Best session earnings: ${formatCredits(this.sessionEarned)}`, at };
    } else if (!old && this.sessionEarned > 0) {
      this.records['session'] = { value: this.sessionEarned, text: `Best session earnings: ${formatCredits(this.sessionEarned)}`, at };
    }
    return [];
  }

  // ------------------------------------------------------------------ notes
  addNote(note: MemoryNote): boolean {
    if (this.notes.some((n) => similar(n.text, note.text))) return false;
    this.notes.push(note);
    this.pruneNotes();
    this.dirty = true;
    return true;
  }

  private pruneNotes(): void {
    const major = this.notes.filter((n) => n.importance >= 3).slice(-NOTE_CAP_MAJOR);
    const minor = this.notes.filter((n) => n.importance < 3).slice(-NOTE_CAP_MINOR);
    this.notes = [...major, ...minor].sort((a, b) => a.at - b.at);
  }

  /**
   * Announce gate with per-key cooldown. Returns true (and records the
   * announcement) only when the key is outside its cooldown window.
   */
  gateAnnounce(key: string, nowMs: number, cooldownMs = 24 * 3600_000): boolean {
    const last = this.announced[key];
    if (last !== undefined && nowMs - last < cooldownMs) return false;
    this.announced[key] = nowMs;
    // Bounded: drop entries older than 30 days.
    for (const [k, t] of Object.entries(this.announced)) {
      if (nowMs - t > 30 * 24 * 3600_000) delete this.announced[k];
    }
    this.dirty = true;
    return true;
  }

  // ----------------------------------------------------------------- recall
  /** Relationship word for a faction the commander has worked for. */
  private relationship(led: FactionLedger): string {
    if (led.done >= 25) return 'a valued ally';
    if (led.done >= 10) return 'trusted';
    return 'known';
  }

  /**
   * Memory lines relevant to the current situation, for AI prompt injection.
   * Compact by design — at most ~5 lines, only genuinely notable history.
   */
  recallForContext(ctx: { system?: string; faction?: string; targetFaction?: string }, nowMs: number): string[] {
    const out: string[] = [];
    if (ctx.system) {
      const led = this.systems[ctx.system];
      if (led && (led.visits >= 4 || led.deaths > 0)) {
        const days = Math.round((nowMs - led.firstAt) / (24 * 3600_000));
        const bits = [`the commander has visited ${ctx.system} ${led.visits} times${days > 1 ? ` over ${days} days` : ''}`];
        if (led.deaths > 0) bits.push(`and lost ${led.deaths === 1 ? 'a ship' : `${led.deaths} ships`} here`);
        out.push(`Memory: ${bits.join(' ')}.`);
      }
    }
    for (const fac of [ctx.faction, ctx.targetFaction]) {
      if (!fac) continue;
      const led = this.factions[fac];
      if (led && led.done + led.failed >= 3) {
        out.push(
          `Memory: ${led.done} contracts completed for ${fac}${led.failed ? ` (${led.failed} failed)` : ''} — ${this.relationship(led)}.`,
        );
      }
    }
    const matched = this.notes
      .filter(
        (n) =>
          (ctx.system && n.system === ctx.system) ||
          (ctx.faction && n.faction === ctx.faction) ||
          (n.importance >= 3 && nowMs - n.at < 14 * 24 * 3600_000),
      )
      .sort((a, b) => b.importance - a.importance || b.at - a.at)
      .slice(0, 3);
    for (const n of matched) out.push(`Memory: ${n.text}`);
    // De-dupe while preserving order (a note can match twice).
    return [...new Set(out)].slice(0, 5);
  }

  /**
   * Compact commander profile for AI prompts — lifetime tallies, favorite
   * factions and personal records. This is what lets "what do you remember
   * about me?" get a real answer.
   */
  profileLines(): string[] {
    const out: string[] = [];
    if (this.totals.missions > 0) {
      const top = Object.entries(this.factions)
        .sort((a, b) => b[1].done - a[1].done)
        .slice(0, 3)
        .filter(([, v]) => v.done > 0)
        .map(([k, v]) => `${k} (${v.done})`);
      out.push(
        `Memory: ${this.totals.missions} contracts completed lifetime${this.totals.failed ? ` (${this.totals.failed} failed/abandoned)` : ''}, ${this.totals.bounties} bounties, ${this.totals.jumps} jumps, ${Object.keys(this.systems).length} systems visited${this.totals.deaths ? `, ${this.totals.deaths} ships lost` : ''}${top.length ? `; most work done for ${top.join(', ')}` : ''}.`,
      );
    }
    const recs = Object.values(this.records).map((r) => r.text);
    if (recs.length) out.push(`Memory records: ${recs.join(' · ')}.`);
    // The fleet: which hull actually does which work — keeps the AI from
    // crediting the mining ship with the hauler's deliveries, and lets
    // "the mining ship" resolve to a name via the hull type.
    const shipUse = Object.entries(this.ships)
      .filter(([, v]) => v.missions + v.bounties + v.jumps > 0)
      .sort((a, b) => b[1].missions + b[1].bounties - (a[1].missions + a[1].bounties))
      .slice(0, 5)
      .map(([k, v]) => {
        const bits: string[] = [];
        if (v.missions) bits.push(`${v.missions} missions`);
        if (v.bounties) bits.push(`${v.bounties} bounties`);
        if (!v.missions && !v.bounties) bits.push(`${v.jumps} jumps`);
        return `${k}${v.type ? ` [${v.type}]` : ''} (${bits.join(', ')})`;
      });
    if (this.shipName || shipUse.length) {
      out.push(
        `Memory: current ship is ${this.shipName || 'unknown'}${this.shipType ? ` [${this.shipType}]` : ''}${shipUse.length ? `; the fleet's logged work: ${shipUse.join(' · ')}` : ''}.`,
      );
    }
    return out;
  }

  /** One-line inventory for the settings panel. */
  summaryLine(): string {
    return `${this.notes.length} notes · ${Object.keys(this.systems).length} systems · ${Object.keys(this.factions).length} factions · ${this.totals.missions} missions · ${this.totals.deaths} deaths remembered`;
  }

  // ------------------------------------------------------------- reflection
  /**
   * Fold the model's schema-constrained reflection JSON into durable notes.
   * Lenient parse (fence-stripping + first-object extraction), near-duplicate
   * rejection, and system/faction anchoring by name match. Returns the number
   * of notes actually kept.
   */
  addReflections(raw: string, nowMs: number): number {
    let parsed: unknown;
    const cleaned = raw.replace(/```(?:json)?/g, '').trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const m = /\{[\s\S]*\}/.exec(cleaned);
      if (!m) return 0;
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return 0;
      }
    }
    const arr = (parsed as { memories?: unknown }).memories;
    if (!Array.isArray(arr)) return 0;
    let kept = 0;
    for (const item of arr.slice(0, 6)) {
      const o = item as Record<string, unknown>;
      const text = str(o.text)?.trim();
      if (!text || text.length < 12) continue;
      const kind = (['record', 'close_call', 'relationship', 'first', 'habit', 'loss'] as const).find(
        (k) => k === o.kind,
      ) ?? 'moment';
      const importance = ([1, 2, 3] as const).find((i) => i === o.importance) ?? 2;
      const system = Object.keys(this.systems).find((s) => text.includes(s));
      const faction = Object.keys(this.factions).find((f) => text.includes(f));
      if (this.addNote({ text, kind, importance, at: nowMs, system, faction, source: 'reflection' })) {
        kept += 1;
      }
    }
    return kept;
  }

  // ---------------------------------------------------------- persistence
  toJSON(): unknown {
    return {
      v: 1,
      watermark: this.watermark,
      watermarkSeen: [...this.watermarkSeen].slice(-300),
      cmdr: this.cmdr,
      shipName: this.shipName,
      shipType: this.shipType,
      factions: this.factions,
      systems: this.systems,
      ships: this.ships,
      records: this.records,
      ranks: this.ranks,
      totals: this.totals,
      notes: this.notes,
      announced: this.announced,
    };
  }

  load(data: unknown): void {
    const d = data as Record<string, unknown>;
    if (!d || typeof d !== 'object' || d.v !== 1) return;
    this.watermark = num(d.watermark);
    this.watermarkSeen = new Set(Array.isArray(d.watermarkSeen) ? (d.watermarkSeen as string[]) : []);
    this.cmdr = str(d.cmdr) ?? '';
    this.shipName = str(d.shipName) ?? '';
    this.shipType = str(d.shipType) ?? '';
    this.factions = (d.factions as Record<string, FactionLedger>) ?? {};
    this.systems = (d.systems as Record<string, SystemLedger>) ?? {};
    this.ships = (d.ships as typeof this.ships) ?? {};
    this.records = (d.records as Record<string, RecordEntry>) ?? {};
    this.ranks = (d.ranks as Record<string, number>) ?? {};
    this.totals = { ...this.totals, ...(d.totals as typeof this.totals) };
    this.notes = Array.isArray(d.notes) ? (d.notes as MemoryNote[]) : [];
    this.announced = (d.announced as Record<string, number>) ?? {};
    this.dirty = false;
  }

  /** Wipe everything (settings "forget" action). */
  forget(): void {
    this.factions = {};
    this.systems = {};
    this.ships = {};
    this.records = {};
    this.ranks = {};
    this.totals = { missions: 0, failed: 0, bounties: 0, deaths: 0, jumps: 0 };
    this.notes = [];
    this.announced = {};
    // Watermark survives — otherwise the next bootstrap refolds everything
    // that was just forgotten.
    this.dirty = true;
  }
}

// ---------------------------------------------------------------------------
// Session reflection — the memory-keeper distills a session into a few notes.
// ---------------------------------------------------------------------------

/** OpenAI-style response_format enforcing the reflection JSON shape.
 *  Verified against LM Studio structured output (gemma-4 class models). */
export const REFLECTION_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'memories',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        memories: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              kind: { type: 'string', enum: ['record', 'close_call', 'relationship', 'first', 'habit', 'loss'] },
              importance: { type: 'integer', minimum: 1, maximum: 3 },
            },
            required: ['text', 'kind', 'importance'],
          },
        },
      },
      required: ['memories'],
    },
  },
};

export function buildReflectionChat(digest: string, cmdr: string, priorNotes: string[]): ChatMessage[] {
  const prior = priorNotes.length
    ? `Memories already stored (do NOT repeat these):\n${priorNotes.slice(-15).map((n) => `- ${n}`).join('\n')}`
    : 'No prior memories stored about these events.';
  return [
    {
      role: 'system',
      content:
        `You are the memory-keeper of ${cmdr ? `Commander ${cmdr}` : 'an Elite Dangerous commander'}'s personal Mission Operator. ` +
        'From the session digest, extract 0-4 DURABLE memories worth keeping for months: personal bests, close calls, ' +
        'relationship shifts with factions, notable firsts, painful losses, recurring habits. NEVER keep routine events ' +
        '(ordinary jumps, dockings, small hand-ins). Fewer, sharper memories beat many bland ones — an empty list is a ' +
        'valid answer for an uneventful session. Each memory is ONE plain past-tense sentence with specific names and ' +
        'numbers. The commander flies several ships: "Took the helm of …" lines mark ship changes, and the header only ' +
        'names the ship at log END — attribute events to the ship in use at that TIME, and when unsure name no ship at ' +
        'all. Importance: 1=minor color, 2=notable, 3=defining moment.',
    },
    { role: 'user', content: `${digest}\n\n${prior}` },
  ];
}
