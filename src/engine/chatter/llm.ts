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
 * INVENTION. This tier is allowed to make things up, always, on every channel
 * and in every act. It used to be fenced: a verifier compared every scene to a
 * list of licensed nouns and figures and dropped the whole thing over a hauler
 * nobody had named. That cost about nine scenes in ten and bought nothing —
 * nothing downstream reads comms, and the commander is never addressed by it.
 * Grounding now comes from volume of real material instead: a scene handed this
 * system's faction board, signal list and station names writes about this system
 * because that is what is in front of it.
 */
import type { ChatMessage } from '../lmstudio.ts';
import { UNIVERSE_REGISTER } from '../lore.ts';
import type { Brief } from './brief.ts';
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
  /**
   * What is actually in this system, as a plain briefing.
   *
   * Background, never a whitelist. The scene is grounded by having enough real
   * material in front of it that writing about somewhere else would take more
   * effort than writing about here — not by a rule forbidding invention.
   */
  dossier?: string;
}

/**
 * The prompt.
 *
 * Written to ask for one thing — prose in a voice — and to ask for nothing else.
 *
 * The version this replaces did the opposite. It stated a whitelist of permitted
 * names twice, forbade everything outside it, and demanded a `[speakerRef]` tag
 * on every line so the reply could be parsed. Both were attempts to control the
 * model with instructions, and both failed in the same direction: the fence
 * discarded roughly nine scenes in ten for naming a hauler nobody had licensed,
 * and the tag protocol drifted out of the model's own rolling transcript until
 * every reply parsed to nothing.
 *
 * So structure moved into code — the caller already knows who is on the channel
 * and in what order, so it assigns the speakers itself — and grounding moved
 * into data. A model handed a real faction board, a real signal list and real
 * station names writes about this system because that is what is in front of it,
 * not because it was told it must.
 */
export function buildSceneChat(req: SceneRequest, history: ChatMessage[] = []): ChatMessage[] {
  const { brief } = req;
  const hedge = hedgeToken(brief);

  const roster = req.speakers
    .map((ref, i) => {
      const who = req.cast?.find((c) => c.ref === ref);
      const name = who?.name ?? req.speakerNames[ref] ?? ref;
      const character = who ? `, who ${who.character}` : '';
      const seen = who?.returning ? ' — the commander has heard them before' : '';
      return `${i + 1}. ${name}${character}${seen}`;
    })
    .join('\n');

  const staleness =
    framingFor(brief) === 'hearsay'
      ? `\n\nIMPORTANT: this information is OLD. Do not state it as the current situation. ` +
        `Frame it as something the speaker last heard — for example "${hedge}".`
      : '';

  const n = req.speakers.length;

  return [
    {
      role: 'system',
      content:
        'You write short overheard radio exchanges in the Elite Dangerous universe. The player ' +
        'is not being addressed — they are a third party listening in on a channel. ' +
        `This channel is ${CHANNEL_STYLE[req.channel]} ` +
        `${UNIVERSE_REGISTER} ` +
        'Write natural dialogue FIRST. You have a briefing on this system below: it is the world ' +
        'these people live in, not a script and not a list of words to fit into sentences. Invent ' +
        'freely on top of it — a ship, a hauler, a cargo, a price, a rumour, whoever they are ' +
        'waiting on. Nobody is fact-checking a radio channel. What you may not do is sound like ' +
        'you are reading a label: nobody says "the 2401 ls out is fine" or "another Resource ' +
        'Extraction Site [Hazardous]". Most good lines name nothing at all. ' +
        'Never address the player, never mention their ship, and never have anyone comment on ' +
        'how vast or beautiful space is. ' +
        'Write people who belong to THIS system specifically. A hazardous extraction site, a ' +
        'contested faction board, a low security rating, a station that is 900 ls out — each one ' +
        'changes what these people worry about, complain about and take for granted. A scene that ' +
        'would work in any system is a scene that has failed. ' +
        'Speakers keep their own character across the whole session; write them consistently. ' +
        'BREVITY IS THE STYLE. Every line is UNDER TWELVE WORDS. This is radio, not prose: ' +
        'people say the minimum and stop. "Understood. Just point the way." is a good line. ' +
        '"The primary feeder route seems clear enough to attempt a lower approach, if that is ' +
        'permissible" is four times too long and nobody talks like that on a working channel. ' +
        'No hedging, no "I believe", no "if that is permissible". ' +
        `Write exactly ${n} line${n === 1 ? '' : 's'}, one per line, and nothing else — no ` +
        'preamble, no narration, no speaker names, no labels, no markdown, no quotation marks. ' +
        'Just the spoken words, one line each. ' +
        'Everything you have already written this session is above. Do not reuse a joke, an image, ' +
        'a complaint or a sentence shape you have used before — write something you have not ' +
        'written yet.',
    },
    ...history,
    {
      role: 'user',
      content:
        (req.dossier
          ? `WHERE THIS IS HAPPENING — the world these people live in:\n${req.dossier}\n\n`
          : `Background: ${brief.summary}\n\n`) +
        `WHO IS SPEAKING, in order — your lines will be given to them in this order:\n${roster}\n\n` +
        `THIS SCENE MUST: ${FUNCTION_BRIEF[req.func]}\n` +
        (req.situation ? `WHAT IS HAPPENING: ${req.situation}\n` : '') +
        staleness +
        `\nWrite the ${n} line${n === 1 ? '' : 's'} now. Invent whatever the scene needs.`,
    },
  ];
}

/**
 * Strip whatever ornament the model put in front of a line.
 *
 * The prompt asks for bare spoken words, and most of the time that is what
 * comes back. But a model that has written radio dialogue before has seen
 * screenplay format, and it will sometimes volunteer `[control]` or
 * `Yusuf Fiore:` or a list bullet out of sheer habit. None of that is trusted —
 * the speaker is decided by position — so it is simply removed.
 *
 * Only ONE leading label is stripped, and only when it is short. A line like
 * "Control: hold" loses its prefix; "Told you: it never works" does not, because
 * the guard on length and word count keeps a mid-sentence colon from eating half
 * the line.
 */
function stripOrnament(raw: string): string {
  let s = raw.trim();
  // List bullets and dashes, then a bracketed tag of any flavour.
  s = s.replace(/^[-*•>]+\s*/, '');
  // A tag can be followed by its own colon — "[control]: Hold" — and leaving it
  // behind puts a stray colon on the air.
  s = s.replace(/^[[{(][^\]})\n]{0,40}[\]})]\s*:?\s*/, '');
  // A bare "Name:" or "ref:" prefix — at most four words before the colon, so
  // dialogue containing a colon survives intact.
  s = s.replace(/^([\p{L}][\p{L}\d ._'-]{0,30}?):\s+(?=\S)/u, (m, label: string) =>
    label.trim().split(/\s+/).length <= 4 ? '' : m,
  );
  s = s.replace(/^[-–—]\s*/, '').trim();
  // Wrapping quotes, only when they wrap the WHOLE line.
  s = s.replace(/^"([^"]*)"$/, '$1').replace(/^'([^']*)'$/, '$1');
  return s.trim();
}

/**
 * Parse the model's reply into turns.
 *
 * One line in, one turn out, and the speaker comes from the line's POSITION in
 * the roster the caller already chose. That is the whole design, and it is worth
 * saying why, because the version this replaces was cleverer and much worse.
 *
 * That one asked the model to tag every line `[speakerRef]`, and grew a
 * five-way alias table — ref, namespace tail, display name, first name, three
 * bracket flavours — because a small model hits an obscure syntax unreliably.
 * Anything it could not map was discarded. Worse, the accepted output was
 * recorded into the rolling transcript with the tags stripped off, so the
 * model's own visible history taught it that the house style was untagged
 * prose. It obliged, every reply parsed to zero turns, and because rejected
 * scenes are never recorded no tagged example could ever get back in. The
 * failure was absorbing, it persisted to disk, and it survived restarts.
 *
 * Positional assignment cannot drift, because there is nothing to drift out of.
 * `COMMS_SPEAKER_REFS` is call-then-response on every channel and the prompt
 * hands the model the roster in that order, so line 1 is the caller and line 2
 * is the reply — which is what these scenes almost always are. The cost is that
 * one voice can no longer take two consecutive turns. The gain is that a
 * non-empty reply always produces a playable scene.
 */
export function parseSceneReply(reply: string, speakers: readonly string[]): SceneTurn[] {
  if (!speakers.length) return [];

  const lines = reply
    .replace(/\r\n?/g, '\n')
    // Emphasis markers carry no meaning here and only confuse the strippers.
    .replace(/\*\*|__/g, '')
    .split('\n')
    .map(stripOrnament)
    .filter(Boolean);

  return lines.slice(0, MAX_TURNS).map((text, i) => ({
    speakerRef: speakers[i % speakers.length],
    text,
  }));
}

export type SceneRejection =
  | { ok: false; why: 'no-turns' }
  | { ok: false; why: 'invalid'; detail: string };

export type SceneOutcome = { ok: true; scene: Scene } | SceneRejection;

/**
 * Turn a model reply into a transmittable scene, or explain why not.
 *
 * There is no fact check here and there is not meant to be one. Overheard radio
 * is the one voice in this app that is allowed to make things up: nothing
 * downstream reads it, the commander is never addressed by it, and the fence
 * that used to police it cost roughly nine scenes in ten to catch fabrications
 * that were never doing any harm. What survives is structural — an empty turn or
 * an unbound token is a bug, not a fiction.
 */
export function acceptSceneReply(
  reply: string,
  req: SceneRequest,
  id: string,
  ttlMs: number,
  arcId?: string,
): SceneOutcome {
  const turns = parseSceneReply(reply, req.speakers);
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
