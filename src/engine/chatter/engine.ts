/**
 * The one thing the store talks to.
 *
 * Everything under chatter/ is a pure piece — channels decide what can open,
 * briefs decide what may be said, the cast decides who says it, the director
 * decides what it should be doing. This assembles them into a single `tick()`
 * so the store's job is only to supply facts and speak the result.
 *
 * Keeping the assembly here rather than in store.ts matters practically: the
 * store is 6,500 lines and cannot be unit-tested without a DOM, and this is
 * the layer where the interesting mistakes live — a scene transmitted in
 * CRISIS, a persona that changes between sessions, a fabricated price reaching
 * the speaker. All of that is testable here, in a bare Node process.
 *
 * The flow, once per tick:
 *
 *   pressure ──▶ ActMachine ──▶ act
 *                                │
 *   context ──▶ selectChannel ───┤ (act gates which channels may open at all)
 *                                ▼
 *   briefs ──▶ pickBrief ──▶ chooseFunction ──▶ grammar candidates
 *                                                    │
 *                                     cast ──▶ personas ──▶ Transmission
 *
 * The LLM tier does not appear in that path. It fills slots ahead of time and
 * `tick()` simply prefers a ready slot when one exists — which is what keeps a
 * slow model from ever delaying a transmission.
 */
import { textureBrief, type Brief } from './brief.ts';
import {
  TransmitBudget,
  dueToTransmit,
  evaluateAll,
  selectChannel,
  type ChannelContext,
  type ChannelState,
} from './channels.ts';
import { CHANNELS } from './channels.ts';
import {
  ActMachine,
  RepetitionGuard,
  chooseFunction,
  nextBeatFor,
  pickBrief,
  type ActTransition,
} from './director.ts';
import {
  CastBook,
  appendBeat,
  buildPersonaPool,
  inventName,
  resolvePersona,
  type CastMember,
  type Persona,
} from './cast.ts';
import { candidates, render, templateKey, type Grammar } from './grammar.ts';
import { SceneSlots } from './llm.ts';
import { functionsForAct, validateScene, type Scene } from './scenes.ts';
import { CHANNEL_IDS } from './types.ts';
import type { Act, ChannelId, DramaticFunction } from './types.ts';

/** One transmission, ready for the Speaker. */
export interface Transmission {
  scene: Scene;
  channel: ChannelId;
  /** Radio profile name for this channel. */
  profile: string;
  /** 0..1 signal degradation from comms range. */
  degrade: number;
  /** Resolved speaker per turn, in turn order. */
  cast: Array<{ name: string; persona: Persona; returning: boolean }>;
  ttlMs: number;
  atMs: number;
}

export interface TickInput {
  nowMs: number;
  /** Same pressure signal the copilot's cadence uses. */
  pressure: number;
  inCrisis: boolean;
  crisisResolvedAt?: number | null;
  density: import('./channels.ts').ChatterDensity;
  system: string;
  /** Facts available to talk about right now. */
  briefs: readonly Brief[];
  /** Channel gating context, minus the parts this class owns. */
  context: Omit<ChannelContext, 'nowMs' | 'act' | 'density' | 'pressure' | 'budget' | 'lastTransmitAt'>;
  /** Piper voices actually installed. */
  installedVoices: readonly string[];
}

export interface TickResult {
  act: Act;
  transitions: ActTransition[];
  channels: ChannelState[];
  transmission: Transmission | null;
  /** Why nothing was transmitted, when nothing was. */
  quietBecause?:
    | 'not-due'
    | 'no-channel'
    | 'no-material'
    | 'nothing-written'
    | 'repetition'
    | 'crisis';
}

/**
 * Where transmissions come from.
 *
 * 'llm'      — written fresh every time. No finite catalogue, so no rotation to
 *              recognise, and the words can be about THIS system specifically.
 *              Silent when the model cannot keep up, and the panel says so.
 * 'hybrid'   — prefer written scenes, fall back to templates rather than go
 *              quiet. Safe, and audibly repetitive over a long session.
 * 'grammar'  — templates only. Free and offline; the rotation is finite.
 */
export type ChatterSource = 'llm' | 'hybrid' | 'grammar';

export interface ChatterEngineOptions {
  grammar: Grammar;
  rand?: () => number;
  source?: ChatterSource;
}

export class ChatterEngine {
  readonly acts = new ActMachine();
  readonly guard = new RepetitionGuard();
  readonly cast = new CastBook();
  readonly slots = new SceneSlots();
  readonly budget = new TransmitBudget();

  private grammar: Grammar;
  private rand: () => number;
  private source: ChatterSource;
  private lastAnyAt: number | null = null;
  private lastPerChannel: Partial<Record<ChannelId, number>> = {};
  private seq = 0;

  constructor(opts: ChatterEngineOptions) {
    this.grammar = opts.grammar;
    this.rand = opts.rand ?? Math.random;
    this.source = opts.source ?? 'llm';
  }

  /** Swap the source policy when the setting changes. */
  setSource(source: ChatterSource): void {
    this.source = source;
  }

  /** Swap the grammar after the user's override file is loaded or edited. */
  setGrammar(g: Grammar): void {
    this.grammar = g;
  }

  /** Park a pre-generated scene against the moment it is for. */
  get sceneSlots(): SceneSlots {
    return this.slots;
  }

  /** Written scenes waiting to be transmitted, across every channel. */
  readyCount(): number {
    let n = 0;
    for (const id of CHANNEL_IDS) n += this.slots.ready(`channel:${id}`);
    return n;
  }

  /**
   * One beat of the world.
   *
   * Returns a transmission or an explanation. Never speaks, never throws,
   * never consults a clock of its own.
   */
  tick(input: TickInput): TickResult {
    const act = this.acts.update({
      nowMs: input.nowMs,
      pressure: input.pressure,
      inCrisis: input.inCrisis,
      crisisResolvedAt: input.crisisResolvedAt,
    });
    const transitions = this.acts.drainTransitions();

    const ctx: ChannelContext = {
      ...input.context,
      nowMs: input.nowMs,
      act,
      density: input.density,
      pressure: input.pressure,
      budget: this.budget,
      lastTransmitAt: this.lastPerChannel,
    };
    const channels = evaluateAll(ctx);
    const base = { act, transitions, channels };

    // Entering CRISIS discards anything queued: the point of the act is the
    // absence, and a line written thirty seconds ago would now be obscene.
    if (act === 'CRISIS') this.slots.clear();

    if (!dueToTransmit(this.lastAnyAt, ctx)) {
      return { ...base, transmission: null, quietBecause: 'not-due' };
    }

    // A channel with nothing to say is silent — that is correct, and it is why
    // STATION never invents a port. But letting one unlucky pick waste the
    // whole tick made the galaxy far quieter than intended: with the station
    // channel open and no geography to hand, two ticks in three produced
    // nothing at all. So try a few channels before accepting the silence.
    let picked: Extract<ChannelState, { open: true }> | null = null;
    let scene: Scene | null = null;
    let exhausted = false;
    const skip = new Set<ChannelId>();

    /**
     * A scene that has already been WRITTEN goes out first.
     *
     * The old order was backwards: pick a channel by weighted lottery, then ask
     * whether it happened to have anything written for it. With three channels
     * open that coincided about a third of the time, and a scene written for a
     * channel the lottery did not pick simply expired unheard. The panel said
     * "6 written" while the air stayed silent, which is exactly as maddening
     * as it sounds.
     *
     * Written material is expensive — seconds of model time each — so it is
     * the first thing considered, not a lottery ticket.
     */
    const openNow = channels.filter(
      (c): c is Extract<ChannelState, { open: true }> => c.open,
    );
    const hadReadyBefore = openNow.some((c) => this.slots.ready(`channel:${c.id}`));
    for (const c of openNow) {
      if (!this.slots.ready(`channel:${c.id}`)) continue;
      const built = this.buildScene(c.id, act, input);
      if (built.scene) {
        picked = c;
        scene = built.scene;
        break;
      }
      exhausted = exhausted || built.exhausted;
      skip.add(c.id);
    }

    for (let attempt = 0; !scene && attempt < 3; attempt++) {
      const candidate = selectChannel({ ...ctx, mutedChannels: union(ctx.mutedChannels, skip) }, this.rand);
      if (!candidate) break;
      const built = this.buildScene(candidate.id, act, input);
      if (built.scene) {
        picked = candidate;
        scene = built.scene;
        break;
      }
      exhausted = exhausted || built.exhausted;
      skip.add(candidate.id);
    }

    if (!picked || !scene) {
      // 'nothing-written' is a different problem from 'no-material': the first
      // means the writer has not caught up, the second means there was nothing
      // to write about. Reporting both as the same thing sent an entire round
      // of debugging in the wrong direction.
      const why =
        act === 'CRISIS'
          ? 'crisis'
          : this.source === 'llm' && !hadReadyBefore
            ? 'nothing-written'
            : skip.size
              ? exhausted
                ? 'repetition'
                : 'no-material'
              : 'no-channel';
      return { ...base, transmission: null, quietBecause: why };
    }

    const cast = this.castScene(scene, input);
    this.guard.remember(scene);
    this.budget.record(input.nowMs);
    this.lastAnyAt = input.nowMs;
    this.lastPerChannel[picked.id] = input.nowMs;

    return {
      ...base,
      transmission: {
        scene,
        channel: picked.id,
        profile: CHANNELS[picked.id].profile,
        degrade: picked.degrade,
        cast,
        ttlMs: scene.ttlMs,
        atMs: input.nowMs,
      },
    };
  }

  /**
   * A scene for this channel — a pre-rendered one if the moment has one,
   * otherwise built from the grammar.
   *
   * The slot is checked first and never waited for. That ordering is the whole
   * anti-latency design: a model that is slow costs a nicer line, never a
   * delayed one.
   */
  private buildScene(
    channel: ChannelId,
    act: Act,
    input: TickInput,
  ): { scene: Scene | null; exhausted: boolean } {
    // A pre-rendered scene still has to clear anti-repetition. It was written
    // minutes ago against a world that has since moved on, and skipping the
    // guard here was a real hole: the whole point of putting the LLM tier
    // behind slots is that it is worth MORE than a template, which makes
    // letting it repeat itself worse, not better. Rejected, it falls through
    // to the grammar tier rather than costing the tick.
    let sawReady = false;
    for (;;) {
      const ready = this.slots.take(`channel:${channel}`, input.nowMs);
      if (!ready) break;
      sawReady = true;
      if (!this.guard.check(ready)) return { scene: ready, exhausted: false };
    }

    // LLM-only: if nothing was written ahead, the channel is silent. That is
    // the deliberate trade — a finite template set is recognisable however
    // well it is shuffled, and being occasionally quiet costs less than being
    // audibly on a loop.
    if (this.source === 'llm') return { scene: null, exhausted: sawReady };

    const openArcs = this.cast
      .openArcs()
      .map(({ arc }) => ({ id: arc.id, beats: arc.beats }));
    const choice = chooseFunction(act, openArcs, this.rand);
    if (!choice) return { scene: null, exhausted: false };

    const factual = pickBrief(input.briefs, channel, this.guard);

    /**
     * Plans, in preference order: say something true, else say something.
     *
     * Both halves earned their place the hard way. Without the texture floor,
     * an unlucky draw of 'establish' with no facts to hand abandoned the tick
     * entirely and the galaxy went quiet two ticks in three.
     *
     * And without the SECOND plan being reachable, a single factual brief
     * poisoned the channel: every retry reused the same brief, so the
     * same-subject gate rejected all of them and the engine went from 60
     * transmissions to 4 the moment it was given something real to talk about.
     * More material made it quieter, which is precisely backwards.
     */
    const plans: Array<{ templates: ReturnType<typeof candidates>; brief: Brief | null }> = [];
    if (factual) {
      const t = candidates(this.grammar, channel, choice.func, factual);
      if (t.length) plans.push({ templates: t, brief: factual });
    }
    // The texture floor keeps the factual brief's TOKENS and NOUNS but takes a
    // fresh subject key. Carrying the nouns is what keeps it honest — the
    // station name it uses is still a real, licensed one. Re-keying is what
    // stops the subject gate from deadlocking the channel. Dropping the tokens
    // instead (the obvious implementation) silenced STATION after one line,
    // because every station template needs <station> to bind.
    const floorTokens = factual ?? null;
    plans.push({
      templates: candidates(
        this.grammar,
        channel,
        'texture',
        floorTokens
          ? { ...floorTokens, kind: 'texture' as const }
          : textureBrief(`t:${channel}`),
      ),
      brief: floorTokens,
    });

    let sawCandidate = false;
    for (const plan of plans) {
      if (!plan.templates.length) continue;
      sawCandidate = true;

      /**
       * Order by least-recently-used, then pick among the coldest few.
       *
       * This is the actual fix for repetition, and it replaces picking at
       * random and rejecting collisions. Those sound equivalent and are not:
       * random selection clusters, so with twenty-six station templates a
       * measured hour played some of them five times and others never, and the
       * minimum gap before a line returned was however deep the reject-ring
       * happened to be. Cycling the catalogue guarantees everything gets an
       * airing before anything repeats.
       *
       * The random pick among the coldest handful is what stops it becoming an
       * audible fixed rotation — the order varies, the coverage does not.
       */
      const ordered = [...plan.templates].sort(
        (a, b) => this.guard.templateAge(templateKey(a)) - this.guard.templateAge(templateKey(b)),
      );
      const coldest = ordered.slice(0, Math.max(3, Math.ceil(ordered.length / 3)));

      const tried = new Set<number>();
      const attempts = Math.min(5, coldest.length);
      for (let i = 0; i < attempts; i++) {
        let idx = Math.floor(this.rand() * coldest.length) % coldest.length;
        while (tried.has(idx) && tried.size < coldest.length) {
          idx = (idx + 1) % coldest.length;
        }
        if (tried.has(idx)) break;
        tried.add(idx);

        const t = coldest[idx];
        // A texture scene's SUBJECT is the template, not the channel. Keying
        // every one to `ambient:LOCAL` made them all one subject, so the
        // same-subject gate silenced each channel after its first idle line.
        const isFloor = plan.brief === floorTokens && plan !== plans[0];
        const useBrief =
          plan.brief && !isFloor
            ? plan.brief
            : plan.brief
              ? { ...plan.brief, kind: 'texture' as const, subjectKey: `texture:${channel}:${t.line}` }
              : textureBrief(`texture:${channel}:${t.line}`);
        this.seq += 1;
        const scene = render(
          t,
          useBrief,
          this.grammar.pools,
          this.rand,
          `sc${input.nowMs}-${this.seq}`,
          ttlFor(channel),
        );
        if (!scene) continue;
        // Belt and braces: a template that slipped past parse-time validation
        // must not reach the air with a token still in it.
        if (validateScene(scene) !== null) continue;
        if (this.guard.check(scene)) continue;
        if (choice.arcId) scene.arcId = choice.arcId;
        return { scene, exhausted: false };
      }
    }
    return { scene: null, exhausted: sawCandidate };
  }

  /**
   * Resolve every turn's speaker to a name and a persona.
   *
   * Existing cast is preferred over invention (that is what makes returning to
   * a system feel like returning), and a persona once assigned never changes.
   */
  private castScene(
    scene: Scene,
    input: TickInput,
  ): Array<{ name: string; persona: Persona; returning: boolean }> {
    const personas = buildPersonaPool(input.installedVoices);
    const out: Array<{ name: string; persona: Persona; returning: boolean }> = [];
    const perScene = new Map<string, { name: string; persona: Persona; returning: boolean }>();

    for (const turn of scene.turns) {
      const already = perScene.get(turn.speakerRef);
      if (already) {
        out.push(already);
        continue;
      }

      const existing = this.cast.castFor(input.system, turn.speakerRef, scene.channel, this.rand);
      let entry: { name: string; persona: Persona; returning: boolean };

      if (existing) {
        entry = {
          name: existing.name,
          persona: resolvePersona(existing.persona, input.installedVoices),
          returning: true,
        };
        this.cast.touch(input.system, existing.name, new Date(input.nowMs).toISOString());
      } else {
        const context = scene.brief.tokens.station ?? input.system;
        const name = inventName(turn.speakerRef, this.rand, context);
        const persona = personas.length
          ? personas[Math.floor(this.rand() * personas.length) % personas.length]
          : { id: 'none', voice: '', timbre: 1, profile: null, quirk: 'clipped' as const };
        const member: CastMember = {
          name,
          persona,
          homeSystem: input.system,
          channel: scene.channel,
          role: turn.speakerRef,
          firstAt: new Date(input.nowMs).toISOString(),
          lastAt: new Date(input.nowMs).toISOString(),
          arcs: [],
        };
        this.cast.remember(member);
        entry = { name, persona, returning: false };
      }

      perScene.set(turn.speakerRef, entry);
      out.push(entry);
    }
    return out;
  }

  /**
   * Threads that are ready to turn.
   *
   * The grammar tier can set something up perfectly well, but it writes a weak
   * reversal — a template cannot know what it is reversing. These are exactly
   * the beats worth spending a model call on, so the engine names them and the
   * store decides whether it can afford to write one.
   *
   * Only arcs whose next beat is a payoff are returned, and only when the act
   * would actually accept that beat: offering a reversal during a quiet
   * stretch just produces a scene that gets rejected after it was paid for.
   */
  payoffDue(act: Act): Array<{ arcId: string; subjectKey: string; channel: ChannelId; speaker: string }> {
    const allowed = functionsForAct(act);
    const out: Array<{ arcId: string; subjectKey: string; channel: ChannelId; speaker: string }> = [];
    for (const { member, arc } of this.cast.openArcs()) {
      const next = nextBeatFor(arc.beats.map((b) => b.func));
      if (next !== 'reverse' && next !== 'aftermath') continue;
      if (!allowed.includes(next)) continue;
      out.push({
        arcId: arc.id,
        subjectKey: arc.subjectKey,
        channel: member.channel,
        speaker: member.role,
      });
    }
    return out;
  }

  /** Record a beat against an arc after a scene carrying it was transmitted. */
  noteArcBeat(system: string, arcId: string, func: DramaticFunction, summary: string, atIso: string): void {
    for (const { member, arc } of this.cast.openArcs()) {
      if (arc.id !== arcId) continue;
      this.cast.upsertArc(system, member.name, appendBeat(arc, { at: atIso, func, summary }));
      return;
    }
  }

  /** Persisted state — the store hands this to localStorage. */
  toJSON(): { cast: unknown; guard: unknown } {
    return { cast: this.cast.toJSON(), guard: this.guard.toJSON() };
  }

  load(json: unknown): void {
    const data = json as { cast?: unknown; guard?: unknown } | null;
    if (!data) return;
    if (data.cast) this.cast.load(data.cast);
    if (data.guard) this.guard.load(data.guard);
  }

  /** Housekeeping on a slow timer. */
  maintain(nowMs: number): void {
    this.cast.dropStaleArcs(nowMs);
    this.cast.prune(nowMs);
    this.slots.sweep(nowMs);
  }
}

/** Set union without mutating either side — channel skip lists are transient. */
function union<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): ReadonlySet<T> {
  if (!b.size) return a;
  const out = new Set(a);
  for (const v of b) out.add(v);
  return out;
}

/**
 * How long a transmission stays worth saying.
 *
 * Station traffic is about a moment — an approach, a pad, a hold — and goes
 * off fast. Crew banter and concourse announcements are about nothing in
 * particular and keep.
 */
function ttlFor(channel: ChannelId): number {
  switch (channel) {
    case 'STATION':
      return 45_000;
    case 'EMERGENCY':
      return 20_000;
    case 'LOCAL':
      return 90_000;
    default:
      return 150_000;
  }
}
