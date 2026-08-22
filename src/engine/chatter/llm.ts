/**
 * The LLM tier — for the beats that earn a model call.
 *
 * Roughly one transmission in five. The grammar tier fills the air for free
 * and cannot lie; this exists for the moments where a template would show its
 * seams: an arrival at a specific port, the world reacting to a specific
 * fight, the payoff of a thread the commander has been half-hearing for a
 * week.
 *
 * Two rules shape everything here.
 *
 * TIMING. Latency is what makes generated chatter feel fake. A traffic-control
 * exchange arriving four seconds after the docking clamps engage is worse than
 * one that never arrives. But the destination is known the moment a route is
 * set, so the scene is written, verified and synthesized minutes early and
 * parked in a slot. If it is not ready when its moment comes, the grammar tier
 * covers and the late one is thrown away — never spoken out of time.
 *
 * TRUTH. Every generated scene goes through the same verifier as everything
 * else, before synthesis, and a scene that reached for anything outside its
 * brief is dropped whole. The prompt is written to make that rare, but the
 * prompt is not the guarantee — the verifier is.
 */
import type { ChatMessage } from '../lmstudio.ts';
import { GROUNDING_RULES } from '../lore.ts';
import { verifyAgainstBrief, type Brief } from './brief.ts';
import { framingFor, hedgeToken } from './briefs.ts';
import { MAX_TURNS, validateScene, type Scene, type SceneTurn } from './scenes.ts';
import { estimateTokens } from '../copilot.ts';
import type { Act, ChannelId, DramaticFunction } from './types.ts';

/** How each channel should sound to the model. */
const CHANNEL_STYLE: Readonly<Record<ChannelId, string>> = {
  STATION:
    'station traffic control talking to a ship. Formal, clipped, procedural. They are busy and ' +
    'the commander is not important to them.',
  LOCAL:
    'two working pilots on the open channel. Off duty, unguarded, mildly fed up. Nobody is ' +
    'performing for anyone.',
  CREW:
    "the commander's own crew on the intercom, three metres apart. Familiar, elliptical, the " +
    'shorthand of people who work together every day.',
  DEEP:
    'a long-range channel with almost nothing on it. Short, spaced-out, slightly flattened by ' +
    'distance. Say less than feels comfortable.',
  EMERGENCY: 'a real emergency call. Urgent, stripped down, no wit whatsoever.',
  CARRIER: 'a fleet carrier broadcasting to local traffic. Institutional, unhurried, faintly smug.',
  CONCOURSE:
    'a public-address announcement inside a station concourse. Bureaucratic, bloodless, ' +
    'accidentally funny.',
};

/** What each dramatic function is asking the scene to accomplish. */
const FUNCTION_BRIEF: Readonly<Record<DramaticFunction, string>> = {
  establish: 'Introduce the situation or the person. Leave something unresolved.',
  complicate: 'The situation just got worse or more awkward. Do not resolve it.',
  reverse: 'Turn it. What everyone assumed was true is not, or it lands the other way up.',
  aftermath: 'Something already happened. These people are dealing with the consequences.',
  texture: 'Nothing is at stake. Two people simply exist on this channel.',
};

export interface SceneRequest {
  channel: ChannelId;
  func: DramaticFunction;
  act: Act;
  brief: Brief;
  /** Speaker refs the scene must use, in the order they should first appear. */
  speakers: string[];
  /** Display names for those refs, so the model writes them consistently. */
  speakerNames: Record<string, string>;
  /**
   * The specific thing this scene is about.
   *
   * Without it every STATION/texture request is byte-identical input, and a
   * model handed identical input returns its favourite answer — at any
   * temperature. Temperature varies the wording; this varies the idea.
   */
  situation?: string;
  /** Who each speaker IS — name and character, so they stay themselves. */
  cast?: Array<{ ref: string; name: string; character: string; returning: boolean }>;
  /** Everything true about this system, as plain lines the model may use. */
  systemFacts?: string;
  /** Allow plausible invented specifics beyond the observed fact list. */
  allowFiction?: boolean;
}

/**
 * The prompt.
 *
 * The fact fence is stated twice — once as rules and once as an explicit list
 * immediately before the instruction to write — because a small model reads
 * the last thing best, and this is the same lesson the news wire already
 * learned the hard way.
 */
export function buildSceneChat(req: SceneRequest, history: ChatMessage[] = []): ChatMessage[] {
  const { brief } = req;
  const strictFacts = !req.allowFiction;
  const nouns = brief.nouns.map((n) => n.value);
  const figures = brief.figures.map((f) => f.value);
  const hedge = hedgeToken(brief);

  const roster = req.speakers
    .map((ref) => {
      const who = req.cast?.find((c) => c.ref === ref);
      if (!who) return `- ${ref}: ${req.speakerNames[ref] ?? ref}`;
      const seen = who.returning ? ' — the commander has heard them before' : '';
      return `- ${ref}: ${who.name}, who ${who.character}${seen}`;
    })
    .join('\n');

  const staleness =
    framingFor(brief) === 'hearsay'
      ? `\n\nIMPORTANT: this information is OLD. Do not state it as the current situation. ` +
        `Frame it as something the speaker last heard — for example "${hedge}".`
      : '';

  return [
    {
      role: 'system',
      content:
        'You write short overheard radio exchanges in the Elite Dangerous universe. The player ' +
        'is not being addressed — they are a third party listening in on a channel. ' +
        `This channel is ${CHANNEL_STYLE[req.channel]} ` +
        `${GROUNDING_RULES} ` +
        'Write natural dialogue FIRST. The fact list is a fence, not a shopping list: it is what ' +
        'you are ALLOWED to name if a name comes up, not a set of words to fit into sentences. ' +
        'Most good lines name nothing at all. Never read a fact aloud as though it were a label — ' +
        'nobody says "the 2401 ls out is fine" or "another Resource Extraction Site [Hazardous]". ' +
        'If you cannot use a name naturally, do not use it. ' +
        (strictFacts
          ? 'The one hard rule: you may not name a faction, station, system, commodity, person or '
              + 'quantity that is not in the fact list. Write around it or leave it out. '
          : 'Prefer names and figures from the fact list when they fit naturally; if none fit, '
              + 'you may invent plausible local specifics. ') +
        'Never address the player, never mention their ship, and never have anyone comment on ' +
        'how vast or beautiful space is. ' +
        'Write people who belong to THIS system specifically — a hazardous extraction site, a ' +
        'contested faction board or a security rating changes what these people worry about and ' +
        'what they complain about. A scene that would work anywhere is a scene that has failed. ' +
        'Speakers keep their own character across the whole session; write them consistently. ' +
        'BREVITY IS THE STYLE. Every turn is UNDER TWELVE WORDS. This is radio, not prose: ' +
        'people say the minimum and stop. "Understood. Just point the way." is a good turn. ' +
        '"The primary feeder route seems clear enough to attempt a lower approach, if that is ' +
        'permissible" is four times too long and nobody talks like that on a working channel. ' +
        'No hedging, no "I believe", no "if that is permissible". ' +
        `Output ${req.speakers.length} turn(s) and ` +
        'nothing else — no preamble, no narration, no markdown. ' +
        'Format each turn as: [speakerRef] the line — for example:\n' +
        '[control] Hold at the marker, we have an outbound on your vector.\n' +
        '[hauler] Holding. Again.\n' +
        'Notice that the example names nothing and is still worth overhearing. ' +
        'Everything you have already written this session is above. Do not reuse a joke, an image, ' +
        'a complaint or a sentence shape you have used before — write something you have not ' +
        'written yet.',
    },
    ...history,
    {
      role: 'user',
      content:
        (req.systemFacts
          ? `WHERE THIS IS HAPPENING — background, not a script:\n${req.systemFacts}\n\n`
          : `Background: ${brief.summary}\n\n`) +
        (strictFacts
          ? `THE FENCE — you may not name anything outside this, and you need not use any of it:\n`
          : `FACTS YOU CAN USE if useful (optional):\n`) +
        `  names: ${nouns.length ? nouns.join(', ') : '(none — name nothing)'}\n` +
        `  numbers: ${figures.length ? figures.join(', ') : '(none — state no numbers)'}\n\n` +
        `SPEAKERS, in order:\n${roster}\n\n` +
        `THIS SCENE MUST: ${FUNCTION_BRIEF[req.func]}\n` +
        (req.situation ? `WHAT IS HAPPENING: ${req.situation}\n` : '') +
        staleness +
        (strictFacts
          ? `\nWrite the ${req.speakers.length} turn(s) now. Name nothing outside the FACTS list.`
          : `\nWrite the ${req.speakers.length} turn(s) now. Prefer grounded facts, but invention is allowed.`),
    },
  ];
}

/**
 * Parse the model's reply into turns.
 *
 * Tolerant of the usual small-model noise — a preamble line, markdown bullets,
 * curly brackets instead of square — because rejecting a good scene over a
 * stray asterisk wastes a call. Anything it cannot map to a known speaker is
 * dropped rather than guessed at.
 */
export function parseSceneReply(
  reply: string,
  speakers: readonly string[],
  speakerNames: Readonly<Record<string, string>> = {},
): SceneTurn[] {
  const turns: SceneTurn[] = [];
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * Every label the model might plausibly use for a speaker.
   *
   * Observed live: asked for `crew:ops` it answered `[ops]`, and asked for
   * `crew:engineering` — displayed as "Halloran" — it answered `[Halloran]`.
   * Both are entirely reasonable readings of the roster it was handed, and
   * both used to be discarded as unknown speakers.
   */
  const byLower = new Map<string, string>();
  for (const ref of speakers) {
    byLower.set(ref.toLowerCase(), ref);
    // The tail of a namespaced ref: crew:ops -> ops.
    const tail = ref.split(':').pop();
    if (tail && tail !== ref) byLower.set(tail.toLowerCase(), ref);
    // The display name, and its first word: "Priya Achebe" -> "Priya".
    const name = speakerNames[ref];
    if (name) {
      byLower.set(name.toLowerCase(), ref);
      const first = name.split(/\s+/)[0];
      if (first && first.length > 2) byLower.set(first.toLowerCase(), ref);
    }
  }
  // Longest first, so `crew:ops` wins over `ops` when both could match.
  const alts = [...byLower.keys()]
    .sort((a, b) => b.length - a.length)
    .map(esc)
    .join('|');
  if (!alts) return turns;

  const push = (rawRef: string, rawText: string): void => {
    const ref = byLower.get(rawRef.trim().toLowerCase());
    if (!ref) return;
    const text = rawText
      .trim()
      // A segment runs up to the NEXT label, so it can end with the bullet or
      // dash that was introducing that label's line. Clean both ends before
      // the quote strip, or the trailing quote is no longer at the end.
      .replace(/^[:\-–—]\s*/, '')
      .replace(/[\s\-*•]+$/, '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    if (!text) return;
    turns.push({ speakerRef: ref, text });
  };

  const clean = reply.replace(/\*\*/g, '');

  // Pass 1: split the WHOLE reply on bracketed labels, wherever they fall.
  //
  // Splitting by line was wrong: a model will happily put an entire exchange on
  // one line — "[crew:ops] Signal is stable. [crew:engineering] Barely." — and
  // a line-based parser swallows the second label into the first turn's text.
  // The verifier then flags the stray capital as an unlicensed name and drops
  // a scene that was perfectly good.
  const bracketed = new RegExp(`[\\[{(]\\s*(${alts})\\s*[\\]})]`, 'gi');
  const marks = [...clean.matchAll(bracketed)];
  if (marks.length) {
    marks.forEach((m, i) => {
      const from = m.index! + m[0].length;
      const to = i + 1 < marks.length ? marks[i + 1].index! : clean.length;
      push(m[1], clean.slice(from, to));
    });
    return turns.slice(0, MAX_TURNS);
  }

  // Pass 2: no brackets anywhere. Models drop them often, so accept a bare
  // label at the start of a line — but only a line, because a bare ref mid
  // sentence is far more likely to be a word than a speaker change.
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*•]\s*/, '');
    if (!line) continue;
    const bare = new RegExp(`^(${alts})\\s*:?\\s+(.+)$`, 'i');
    const m = bare.exec(line);
    if (m) push(m[1], m[2]);
    if (turns.length >= MAX_TURNS) break;
  }
  return turns.slice(0, MAX_TURNS);
}

export type SceneRejection =
  | { ok: false; why: 'no-turns' }
  | { ok: false; why: 'invalid'; detail: string }
  | { ok: false; why: 'unverified'; offending: string[] };

export type SceneOutcome = { ok: true; scene: Scene } | SceneRejection;

export interface SceneAcceptOptions {
  /** Disable the brief verifier when fiction is intentionally allowed. */
  verifyAgainstBrief?: boolean;
}

/**
 * Turn a model reply into a transmittable scene, or explain why not.
 *
 * Verification runs here by default, before the caller synthesizes anything,
 * so accidental fabrications are dropped before they reach the air.
 */
export function acceptSceneReply(
  reply: string,
  req: SceneRequest,
  id: string,
  ttlMs: number,
  arcId?: string,
  options: SceneAcceptOptions = {},
): SceneOutcome {
  const turns = parseSceneReply(reply, req.speakers, req.speakerNames);
  if (!turns.length) return { ok: false, why: 'no-turns' };

  const scene: Scene = {
    id,
    channel: req.channel,
    func: req.func,
    turns,
    brief: req.brief,
    ttlMs,
    arcId,
    tier: 'llm',
  };

  const structural = validateScene(scene);
  if (structural) return { ok: false, why: 'invalid', detail: structural };

  if (options.verifyAgainstBrief !== false) {
    const text = turns.map((t) => t.text).join(' ');
    const verdict = verifyAgainstBrief(text, req.brief);
    if (!verdict.ok) return { ok: false, why: 'unverified', offending: verdict.offending };
  }

  return { ok: true, scene };
}

// ---------------------------------------------------------------------------
// Pre-rendering
// ---------------------------------------------------------------------------

/**
 * A scene written ahead of the moment it is for.
 *
 * `readyBy` is the moment it stops being useful — not a timeout on generation
 * but a statement about the world. An arrival scene is for the arrival; a
 * minute after docking it is litter.
 */
export interface PreparedSlot {
  key: string;
  scene: Scene | null;
  readyBy: number;
  /** Set while generation is in flight, so the slot is not requested twice. */
  pending: boolean;
}

/**
 * Holds scenes generated in advance.
 *
 * Keyed by what the scene is FOR ("arrival:Kepler Landing"), so the store can
 * ask "is there one ready for this?" at the moment it matters without knowing
 * or caring when it was written.
 */
export class SceneSlots {
  private slots = new Map<string, PreparedSlot[]>();
  /** How many written-ahead scenes a channel may hold. */
  private readonly depth: number;

  constructor(depth = 3) {
    this.depth = Math.max(1, depth);
  }

  private list(key: string): PreparedSlot[] {
    return this.slots.get(key) ?? [];
  }

  /** Ready-to-speak scenes waiting on this key. */
  ready(key: string): number {
    return this.list(key).filter((s) => !s.pending && s.scene).length;
  }

  /** Everything held for this key, including generations still in flight. */
  count(key: string): number {
    return this.list(key).length;
  }

  /** True when this key is full — do not ask for more. */
  full(key: string): boolean {
    return this.count(key) >= this.depth;
  }

  /** Backwards-compatible: is anything held or in flight for this key? */
  has(key: string): boolean {
    return this.count(key) > 0;
  }

  /** Reserve a slot before starting generation. */
  reserve(key: string, readyBy: number): void {
    if (this.full(key)) return;
    const list = this.list(key);
    list.push({ key, scene: null, readyBy, pending: true });
    this.slots.set(key, list);
  }

  /**
   * Generation finished. A scene arriving after its moment is discarded.
   *
   * Fills the OLDEST pending reservation, so several generations in flight for
   * one channel resolve in the order they were asked for.
   */
  fulfil(key: string, scene: Scene | null, nowMs: number): boolean {
    const list = this.list(key);
    const slot = list.find((x) => x.pending);
    if (!slot) return false;
    slot.pending = false;
    const drop = (): void => {
      this.slots.set(key, list.filter((x) => x !== slot));
    };
    if (!scene) {
      drop();
      return false;
    }
    if (nowMs > slot.readyBy) {
      // Written too late to be about anything. Throw it away rather than
      // transmit a docking exchange to a ship that docked four minutes ago.
      drop();
      return false;
    }
    slot.scene = scene;
    return true;
  }

  /** Take the next scene for this moment, if one is ready and still current. */
  take(key: string, nowMs: number): Scene | null {
    const list = this.list(key);
    const i = list.findIndex((x) => !x.pending && x.scene);
    if (i < 0) return null;
    const [slot] = list.splice(i, 1);
    this.slots.set(key, list);
    if (nowMs > slot.readyBy) return null;
    return slot.scene;
  }

  /** Forget slots whose moment has passed. */
  sweep(nowMs: number): number {
    let n = 0;
    for (const [key, list] of this.slots) {
      const keep = list.filter((x) => {
        if (nowMs > x.readyBy) {
          n += 1;
          return false;
        }
        return true;
      });
      if (keep.length) this.slots.set(key, keep);
      else this.slots.delete(key);
    }
    return n;
  }

  get size(): number {
    let n = 0;
    for (const list of this.slots.values()) n += list.length;
    return n;
  }

  clear(): void {
    this.slots.clear();
  }
}

// ---------------------------------------------------------------------------
// The rolling conversation
// ---------------------------------------------------------------------------

/**
 * What the model has already put on the air this session.
 *
 * The first cut passed a short "do not echo these" list in the user turn, which
 * is the wrong shape: it asks the model to avoid something while showing it the
 * thing to avoid, and it fights the model's own machinery. A chat model already
 * has a mechanism for not repeating itself — its own transcript. Everything it
 * has written becomes an `assistant` turn and the next request is a `user` turn,
 * exactly as CopilotConversation does for the operator, and it declines to
 * repeat itself for the same reason a person would: it can see that it already
 * said that.
 *
 * Trimmed by estimated tokens rather than turn count, always on a user
 * boundary, so the transcript never opens mid-exchange.
 */
export class ChatterConversation {
  private turns: ChatMessage[] = [];
  private readonly tokenBudget: number;

  constructor(tokenBudget = 3_000) {
    this.tokenBudget = tokenBudget;
  }

  get length(): number {
    return this.turns.length;
  }

  /** History to splice between the system prompt and the new request. */
  history(): ChatMessage[] {
    return this.turns.slice();
  }

  /**
   * Commit an exchange, once the scene has actually been ACCEPTED.
   *
   * Rejected scenes are deliberately not recorded. A line that failed its
   * brief was never transmitted, so teaching the model it "already said" it
   * would suppress a perfectly good idea it has not in fact used — and worse,
   * would fill the transcript with exactly the fabrications the verifier
   * exists to keep off the air.
   */
  record(channel: string, situation: string | undefined, sceneText: string): void {
    const ask = situation ? `${channel}: ${situation}` : channel;
    this.turns.push({ role: 'user', content: ask });
    this.turns.push({ role: 'assistant', content: sceneText });
    this.trim();
  }

  private trim(): void {
    const cost = (m: ChatMessage): number => estimateTokens(m.content);
    let total = this.turns.reduce((n, t) => n + cost(t), 0);
    // Drop whole exchanges from the front so the history always starts on a
    // user turn — a transcript opening on an assistant reply reads as though
    // the model answered a question nobody asked.
    while (total > this.tokenBudget && this.turns.length >= 2) {
      total -= cost(this.turns[0]) + cost(this.turns[1]);
      this.turns.splice(0, 2);
    }
  }

  load(json: unknown): void {
    if (!Array.isArray(json)) return;
    this.turns = (json as ChatMessage[]).filter(
      (t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string',
    );
    this.trim();
  }

  toJSON(): ChatMessage[] {
    return this.turns;
  }

  clear(): void {
    this.turns = [];
  }
}

/**
 * Situations to ask about, per channel.
 *
 * Chosen least-recently-used, the same way templates are, because this is the
 * same problem: a finite set picked at random clusters. These are the ideas the
 * model dresses; the transcript above is what stops it dressing them the same
 * way twice.
 */
export const SITUATIONS: Readonly<Record<ChannelId, readonly string[]>> = {
  STATION: [
    'a pad reassignment nobody is happy about',
    'a customs or manifest check',
    'a delay with a reason that does not quite add up',
    'a departure clearance',
    'a priority vessel bumping the queue',
    'a docking request from someone unfamiliar with the procedure',
    'a warning about approach speed',
    'a services problem — fuel, lifts, or repair bay',
    'a shift change handover',
    'a vessel in the wrong place',
    'a routine arrival handled briskly',
    'somebody being told off, politely',
  ],
  LOCAL: [
    'a complaint about what a run pays',
    'a question about the route ahead',
    'two pilots who clearly know each other',
    'a warning about something on the lane',
    'a rumour nobody can source',
    'somebody who has been awake far too long',
    'a newcomer asking an obvious question',
    'a mild disagreement about right of way',
    'somebody trying to sell something',
    'an offer of help nobody asked for',
  ],
  CREW: [
    'a maintenance niggle that will not resolve',
    'a watch handover',
    'a small competence, quietly noted',
    'boredom on a long leg',
    'a disagreement about procedure',
    'something aboard that smells, sounds or reads wrong',
    'a dry observation about the commander’s flying',
    'supplies running lower than anybody wants to say',
  ],
  DEEP: [
    'the sheer absence of traffic',
    'a signal that might have been nothing',
    'the last relay dropping out of range',
    'the discipline of keeping a receiver open for nobody',
  ],
  EMERGENCY: [
    'a vessel losing systems',
    'a call for medical assistance',
    'an emergency stood down',
  ],
  CARRIER: [
    'services being advertised to local traffic',
    'a departure warning',
    'an announcement made with unearned grandeur',
  ],
  CONCOURSE: [
    'a delay announcement',
    'a lost item or unattended container',
    'a shift rotation notice',
    'a safety reminder nobody heeds',
    'a commercial notice',
  ],
};
