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
import { isModelAside } from '../aside.ts';
import { commsAnchorLean, commsRegister, sceneEnergy } from '../tone.ts';
import type { Act, ChannelId, DramaticFunction } from './types.ts';

/** How each channel should sound to the model. */
const CHANNEL_STYLE: Readonly<Record<ChannelId, string>> = {
  STATION:
    'station traffic control talking to a ship. Formal, clipped, procedural. They are busy and ' +
    'the commander is not important to them. Real radio protocol is the poetry of this channel: ' +
    'callsign address, clearances, read-backs, a brisk acknowledgment to close — the furniture ' +
    'of working radio, worn smooth by use.',
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
  /**
   * Rotates the register the scene is pitched in — see tone.ts.
   *
   * The dossier varies now, but the INSTRUCTIONS around it did not: the same
   * channel style on every call for ever, which is the half of the prompt that
   * pulls hardest toward the answer the model gave last time.
   */
  rotate?: number;
  /**
   * How many lines to ask for (default: one per speaker). Real radio calls
   * run past two — request, answer, read-back, close — and the reference
   * corpus of the genre (EDCoPilot's chatter files) runs three to five turns.
   * Positional assignment wraps the roster, so line 3 is the caller again;
   * capped by MAX_TURNS regardless.
   */
  lines?: number;
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

  const n = Math.max(1, Math.min(MAX_TURNS, req.lines ?? req.speakers.length));

  return [
      {
      role: 'system',
      content:
        'You write short overheard radio exchanges in the Elite Dangerous universe. The player ' +
        'is a third party listening in on a channel; all dialogue is between people already using it. ' +
        `This channel is ${CHANNEL_STYLE[req.channel]} ` +
        `${UNIVERSE_REGISTER} ` +
        'Write natural dialogue FIRST. You have a briefing on this system below: it describes the ' +
        'world these people live in rather than a script or vocabulary list. Invent freely on top ' +
        'of it — a ship, a hauler, a cargo, a price, a rumour, whoever they are waiting on. Radio ' +
        'chatter can contain assumptions, gossip, mistakes and incomplete information. ' +
        'People speak from lived experience. They refer to places and circumstances the way locals ' +
        'would: casually, indirectly and only when relevant — offhand and lived-in, never reciting ' +
        'formal location names, distances or classification labels. ' +
        // No worked example here. This sentence used to include one model
        // line in quotes, and it surfaced VERBATIM in four scenes of ten —
        // same leak as the faction-board incident: anything quotable in the
        // prompt eventually gets quoted.
        'Most strong lines need no proper noun at all. ' +
        // Round-2 residue: the writer recited "Minerva Federal Company" four
        // times in five scenes. No shortening examples here — worked examples
        // get memorised as vocabulary (see the faction-board incident above).
        // And no vivid verbs: an earlier wording of this sentence used the
        // word "clip" and a scene promptly described a voice as "clipped".
        'Names shrink with familiarity: nobody on a working channel gives an organisation its ' +
        'full registered name twice. ' +
        'Keep every exchange entirely between local speakers. Their attention stays on immediate ' +
        'work, danger, money, traffic, cargo, factions, repairs, schedules, rumours and each other. ' +
        // The old version of this passage gave worked examples ("a contested
        // faction board might produce rumours…") and the model memorised them
        // as vocabulary: "board" turned up in eight scenes out of ten as a
        // magic institution that held meetings and issued numbers. Guidance
        // survives here; recyclable nouns do not.
        'Make every scene unmistakably belong to THIS system: let the briefing shape what these ' +
        'people worry about, complain about and take for granted, expressed through ordinary talk ' +
        'rather than explanation. ' +
        // The anomaly magnet. Handed a system where everything works, the
        // model breaks something for tension — a relay, then a beacon, four
        // scenes running. Give it where trouble actually lives instead.
        'When a scene needs trouble, it comes from people — schedules slipping, margins thinning, ' +
        'patience running out, a favour called in, somebody late, somebody lying. The hardware of ' +
        'this system works fine and is the least interesting thing on the channel. ' +
        'The lines are ONE conversation: each line answers, refuses, confirms or needles the one ' +
        'before it, from its own speaker’s seat, in its own words — never an echo of the other ' +
        'line’s phrasing. ' +
        'People sound like their jobs: control is brief and procedural, pilots grumble, crew talk ' +
        'like family, a PA reads notices. Two voices in one exchange never sound like one person. ' +
        // NOTE — a "liveliness paragraph" was A/B tested here (appetite,
        // pettiness, human-scale details, phrased abstractly) and REMOVED on
        // the evidence: zero visible effect on the prose, worse noun
        // clustering, and one second-person-narration regression. For this
        // model size, style lives in the rotating pools (tone.ts) and the
        // situations — concrete, one at a time — never in standing prose
        // instructions, which only dilute the ones that matter.
        'Speakers keep their own character across the whole session; write them consistently. ' +
        // Loosened from a hard "UNDER TWELVE WORDS". That cap was armour
        // against small-model rambling, but it also flattened every exchange
        // into clipped fragments — a hauler mid-complaint or a controller
        // explaining a hold legitimately runs a sentence or two. The rambling
        // failure the cap guarded against is now caught downstream instead
        // (asides stripped, MAX_TURNS, the register rotation), so the style
        // can breathe. Radio-plausible is the bar, not a word count.
        'Radio length, not prose length: most lines are short, and a line may run to a sentence ' +
        'or two when the moment carries it — a complaint, an explanation, a story half-told. ' +
        'Never padding. "Understood. Just point the way." is still a fine line. Use decisive ' +
        'speech with concrete wording and direct intent. ' +
        `Write exactly ${n} line${n === 1 ? '' : 's'}, one spoken utterance per line. ` +
        'Output only the spoken words. Each line stands alone as intercepted radio dialogue. ' +
        'The order of the lines is the ONLY attribution: never begin a line with the name of the ' +
        'person saying it, and a speaker never says their own name. Addressing the OTHER person ' +
        'by name is fine, people do that on radio. ' +
        'Everything you have already written this session is above. Treat earlier material as used ' +
        'territory. Give each new batch fresh situations, imagery, complaints, rhythms and sentence ' +
        'shapes. Surprise the listener with something that has not appeared earlier.',
    },
    ...history,
    {
      role: 'user',
      content:
        (req.dossier
          ? `WHERE THIS IS HAPPENING — the world these people live in:\n${req.dossier}\n\n`
          : `BACKGROUND — the local situation:\n${brief.summary}\n\n`) +

        `WHO IS SPEAKING — line 1 is spoken by the first person below, line 2 by the second. ` +
        `Their names are for YOU, not for the lines:\n${roster}\n\n` +

        `SCENE PURPOSE — this exchange exists to: ${FUNCTION_BRIEF[req.func]}\n` +
        // The one line of the prompt that is different every time. Rotating the
        // facts stopped the briefing repeating; this stops the INSTRUCTIONS
        // repeating, which is the half a model leans on hardest.
        `REGISTER — how to pitch it: ${commsRegister(req.rotate ?? 0)}\n` +
        // An axis independent of the situation: the same situation under a
        // different kind of moment is a different scene. Coprime pool sizes
        // mean the register/moment pair does not recur for 3,575 calls.
        `THE MOMENT — what kind of exchange this is: ${sceneEnergy(req.rotate ?? 0)}\n` +

        (req.situation
          ? `IMMEDIATE SITUATION — what is happening right now:\n${req.situation}\n`
          : '') +

        staleness +

        `\nBuild a ${n}-line radio scene from these conditions. ` +
        `Invent the concrete details needed to make the moment feel already underway.\n\n` +

        `GROUND THE SCENE IN THIS SYSTEM: choose one concrete fact from the briefing above and make ` +
        `it the cause, obstacle, opportunity or shared concern driving the exchange. It might be a ` +
        `faction's current activity, a station, a signal source, local traffic, security conditions, ` +
        `distance, economy, conflict or another system-specific fact. Let the speakers react to its ` +
        `practical consequences as something they already know and are already dealing with. ` +
        `ONE fact is plenty — the rest of the briefing is the world outside the window, not the ` +
        `script, and a line that chains three briefing facts together is paperwork, not speech. ` +
        `The system detail should emerge naturally through what they need, fear, expect, argue about ` +
        `or are trying to accomplish. ` +
        // The data half of the randomizer. Told only to "choose one concrete
        // fact", a model chooses the SAME standout figure every time — a live
        // session produced five consecutive scenes about one steel quota, over
        // thirteen minutes, in different words. This rotates which part of the
        // briefing carries the scene; when the named part is absent it reads as
        // a preference and the model falls back to what is there.
        `${commsAnchorLean(req.rotate ?? 0)}\n\n` +

        `Write the ${n} line${n === 1 ? '' : 's'} now.`,
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
  // Ordered-list numbering: "1. ", "2) ", "3] ".
  //
  // Asking for "exactly 2 lines" invites a model to number them, and this cost
  // twice what it looks like. The number itself reached the air — but it also
  // blocked the name strip below, which needs a LETTER first, so lines came out
  // as "1. HIP 71120: The Explorer on Tour is pushing the expansion too
  // quickly" with both the index and the speaker's own name spoken aloud beside
  // the name the panel was already showing. One missing rule, two artefacts.
  s = s.replace(/^\d+\s*[.)\]]\s+/, '');
  // A tag can be followed by its own colon — "[control]: Hold" — and leaving it
  // behind puts a stray colon on the air.
  s = s.replace(/^[[{(][^\]})\n]{0,40}[\]})]\s*:?\s*/, '');
  // A bare "Name:" or "ref:" prefix — at most four words before the colon, so
  // dialogue containing a colon survives intact.
  s = s.replace(/^([\p{L}][\p{L}\d ._'-]{0,30}?):\s+(?=\S)/u, (m, label: string) =>
    label.trim().split(/\s+/).length <= 4 ? '' : m,
  );
  s = s.replace(/^[-–—]\s*/, '').trim();
  // Speech-verb narration: `Control says, "Pad four's held"` — the model
  // novelising its own radio; observed three scenes out of ten in one round
  // of prompt tuning. The tell that separates it from dialogue ABOUT speech
  // ('He said "clear" and then went quiet.') is the quote running to the END
  // of the line: when the whole remainder is quoted, the prefix is stage
  // direction. Two shapes — a narrative clause ending in a colon, and a
  // short clause ending in a speech verb.
  const quoteToEol = /(?=["“][^"“”]*["”]\s*$)/.source;
  s = s.replace(new RegExp(`^[^"“”]{0,80}:\\s*${quoteToEol}`, 'u'), '');
  s = s.replace(
    new RegExp(
      `^[^"“”]{0,60}\\b(says?|said|replies|replied|answers?|answered|responds?|responded|calls?|announces?|adds?|asks?|crackles?),?\\s*${quoteToEol}`,
      'iu',
    ),
    '',
  );
  // Wrapping quotes, only when they wrap the WHOLE line — straight or curly.
  s = s.replace(/^"([^"]*)"$/, '$1').replace(/^'([^']*)'$/, '$1');
  s = s.replace(/^“([^“”]*)”$/, '$1');
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
export function parseSceneReply(
  reply: string,
  speakers: readonly string[],
  /**
   * Display names for the roster, so a name ON ITS OWN LINE can be dropped.
   *
   * Screenplay habit, and it survived every other guard because it is not
   * ornament attached to a line — it IS the line. Observed live:
   *
   *     HIP 71120
   *     Wood's Pride, you're cleared for departure.
   *     Dmitri Sarkis
   *     Just be careful.
   *
   * Four lines, so positional assignment made four turns, and the panel spoke
   * "HIP 71120" and "Dmitri Sarkis" aloud as though they were dialogue — next
   * to the very same names already printed beside them.
   */
  names: Readonly<Record<string, string>> = {},
): SceneTurn[] {
  if (!speakers.length) return [];

  // Everything a bare line might be calling a speaker: the ref, its namespace
  // tail, the display name, and the first word of that name.
  const labels = new Set<string>();
  for (const ref of speakers) {
    labels.add(ref.toLowerCase());
    const tail = ref.split(':').pop();
    if (tail) labels.add(tail.toLowerCase());
    const name = names[ref];
    if (name) {
      labels.add(name.toLowerCase());
      const first = name.split(/\s+/)[0];
      if (first && first.length > 2) labels.add(first.toLowerCase());
    }
  }
  const isBareName = (line: string): boolean =>
    labels.has(line.toLowerCase().replace(/[.:,\s]+$/, '').trim());

  /**
   * Split a line that carries BOTH turns, at a mid-line `Name:` boundary.
   *
   * Longer lines made this real: relaxing the twelve-word cap, the first live
   * scene came back as one line — "...you're holding the slot for everyone
   * else. Inbound Traffic: I'm already in the bay." — and positional
   * assignment glued the second speaker's dialogue (label and all) into the
   * first speaker's turn, to be read aloud in the wrong voice.
   *
   * Only KNOWN roster names followed by a colon split; addressing somebody
   * uses a comma ("Dmitri Sarkis, hold at the marker") and is left intact.
   */
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const splitter = new RegExp(`(?=\\b(?:${[...labels].map(esc).join('|')})\\s*:)`, 'i');

  const lines = reply
    .replace(/\r\n?/g, '\n')
    // Emphasis markers carry no meaning here and only confuse the strippers.
    // Single-asterisk pairs too: a 40-scene run italicised its invented ship
    // names (*Wanderlust*) and the stars would have reached the air.
    .replace(/\*\*|__/g, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .split('\n')
    .flatMap((l) => l.split(splitter))
    .map(stripOrnament)
    .filter(Boolean)
    // A model that finishes a scene by explaining the scene would have that
    // explanation SPOKEN, in a voice, on a radio channel. Caught on the news
    // wire — "(Note: as per your instructions, I've created new people...)" —
    // and there is no reason comms is immune to the same instinct.
    .filter((l) => !isModelAside(l))
    // A line that is only a speaker's name is a stage direction, not speech.
    .filter((l) => !isBareName(l))
    // So is a line that is only a script label — "Line 1:" observed as its
    // own turn during prompt tuning, spoken aloud as dialogue and shunting
    // every later line onto the wrong speaker. Colon required: "Line 3." can
    // be an actual utterance; "Line 3:" cannot.
    .filter((l) => !/^(line|scene|turn|exchange)\s*\d*\s*:$/i.test(l))
    // And so is second-person narration — "You hear a faint beep under the
    // chatter" is the model describing the scene TO the listener, not a
    // person speaking on it. Observed once during style testing; nobody on
    // a radio tells you what you hear.
    .filter((l) => !/^you (hear|see|notice|feel|smell)\b/i.test(l));

  /** Every label that could mean "this speaker": ref, tail, full display
   *  name, and its first and last words ("Ines Sarkis" is addressed as either). */
  const selfLabels = (ref: string): string[] => {
    const out = [ref];
    const tail = ref.split(':').pop();
    if (tail) out.push(tail);
    const name = names[ref];
    if (name) {
      out.push(name);
      for (const w of name.split(/\s+/)) if (w.length > 2) out.push(w);
    }
    return [...new Set(out)];
  };

  return lines.slice(0, MAX_TURNS).map((text, i) => {
    const speakerRef = speakers[i % speakers.length];
    // A speaker never says their own name. The 9B labels lines "Name, rest of
    // the line" — comma, not colon — which collided with the guard that keeps
    // "Kowalczyk, the signal is bleeding" intact when SARKIS says it. Position
    // resolves the ambiguity: only the name of the speaker this line already
    // belongs to is stripped, so cross-address survives untouched and a live
    // panel stops reading "Ines Sarkis: Ines Sarkis, just keep the beacon
    // clear."
    let spoken = text;
    for (const label of selfLabels(speakerRef)) {
      const m = new RegExp(`^${esc(label)}\\s*[,:—–-]\\s+`, 'i').exec(spoken);
      if (m) {
        spoken = spoken.slice(m[0].length);
        break;
      }
    }
    return { speakerRef, text: spoken.trim() || text };
  });
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
/**
 * A turn caught in a degeneration loop — one clause repeated until the token
 * budget ran out. Observed verbatim from a candidate model on the bench:
 * "I've been doing the whole thing." sixty times in one 47-second turn, and
 * every guard passed it, because the repetition filters compare across scenes
 * and this is repetition WITHIN one turn. It would have been spoken aloud,
 * sentence by sentence. Any model can degenerate on a bad day; the guard is
 * model-agnostic.
 */
function isDegenerateTurn(text: string): boolean {
  const sentences = text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 3);
  if (sentences.length < 4) return false;
  const counts = new Map<string, number>();
  for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1);
  const top = Math.max(...counts.values());
  // One sentence said four times in a single breath is a stuck record, not
  // emphasis — real speech repeats a clause twice, maybe three times for
  // effect, never four identically.
  return top >= 4;
}

export function acceptSceneReply(
  reply: string,
  req: SceneRequest,
  id: string,
  ttlMs: number,
  arcId?: string,
): SceneOutcome {
  const turns = parseSceneReply(reply, req.speakers, req.speakerNames);
  if (!turns.length) return { ok: false, why: 'no-turns' };
  if (turns.some((t) => isDegenerateTurn(t.text))) {
    return { ok: false, why: 'invalid', detail: 'degenerate turn — one clause on repeat' };
  }

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

  // 1,200, down from 3,000 — measured, not guessed. The transcript is how the
  // model avoids repeating itself, but it is ALSO how one noun snowballs: at
  // 3,000 tokens (fifteen-plus scenes) a 40-scene audit put the same station
  // in half the air, because every early mention kept arguing for the next
  // one. Six-ish scenes of history is plenty of "used territory" to steer
  // clear of, and it lets a hot noun actually FALL OUT of sight once the
  // accept-time gate stops admitting it.
  constructor(tokenBudget = 1_200) {
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
 *
 * Authoring rules, learned the hard way:
 * - Prefer events already in motion over people merely discussing a topic.
 * - Concrete enough to act on, incomplete enough that the model still invents
 *   the actual event, personalities, stakes and outcome.
 * - Mundane, funny, tense, warm, suspicious and strange all belong; not every
 *   exchange needs danger or plot significance.
 * - Small human problems are more convincing than large dramatic ones, and
 *   some situations should leave unanswered questions.
 *
 * The situation is WHAT the scene is about. The independent MOMENT axis in
 * tone.ts (sceneEnergy) is what KIND of exchange it is — the same situation
 * under a different energy is a different scene, and the multiplication is
 * what makes the air feel alive rather than merely large.
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
    'a services problem — fuel, lifts, repair bay, or cargo handling',
    'a shift change handover already going badly',
    'a vessel in the wrong place',
    'a routine arrival handled briskly',
    'somebody being told off, politely',
    'a docking computer glitch nobody will admit to',
    'an overdue departure blocking a pad',
    'a misfiled manifest holding everything up',
    'an unscheduled inspection announced too cheerfully',
    'a pad held for someone who has not arrived',
    'a noise complaint about thrusters on approach',
    'a pilot insisting they were assigned a pad that does not exist',
    'ground crew waiting for a ship whose commander has gone missing',
    'a damaged landing gear forcing an awkward arrival',
    'a courier demanding priority because the cargo is supposedly urgent',
    'a security seal that does not match the paperwork',
    'somebody requesting permission for something nobody has requested before',
    'an arriving ship refusing assistance it very obviously needs',
    'a departure delayed because one passenger has not boarded',
    'a ship requesting fuel with almost nothing left in reserve',
    'a traffic controller recognising a callsign they would rather not recognise',
    'a station-side system restarting at exactly the wrong moment',
    'an anonymous tip causing security to inspect an otherwise ordinary vessel',
    'a freighter occupying two pads worth of everybody’s patience',
    'a pilot attempting to negotiate docking fees over an open channel',
    'a vessel reporting debris near the slot',
    'a temporary exclusion zone appearing without explanation',
    'a maintenance crew asking traffic control to buy them five more minutes',
    'an outbound commander discovering their cargo clearance has expired',
    'a pilot reporting something odd seen on approach, tactfully',
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
    'an argument about the best route in',
    'somebody fishing for a wing to run with',
    'a debt being called in, gently',
    'a ship acting strangely on the scanner',
    'somebody bragging about a near miss',
    'a price somebody swears was different yesterday',
    'a pilot asking whether anybody else saw the same scanner contact',
    'someone warning everyone away from a supposedly easy contract',
    'two commanders comparing repair bills',
    'a trader trying to discover where everyone is selling',
    'a bounty hunter asking questions without admitting why',
    'somebody celebrating a payout that clearly was not worth the risk',
    'a pilot trying to identify a ship from a vague description',
    'an argument over who actually discovered something first',
    'someone broadcasting music until another pilot complains',
    'a commander asking for directions despite having navigation data',
    'somebody looking for fuel and pretending not to be desperate',
    'a pilot announcing a shortcut everybody else thinks is stupid',
    'two strangers discovering they came from the same station',
    'someone asking whether a particular system is always this quiet',
    'a commander offering coordinates but refusing to say what is there',
    'a trader warning others about a buyer who changes the deal on arrival',
    'someone reporting an interdiction that ended strangely peacefully',
    'a pilot returning after years away and asking what changed',
    'a disagreement about whether a contact is hostile or merely incompetent',
    'someone trying to organise an impromptu convoy',
    'a commander noticing another ship has been following them for several jumps',
    'somebody asking who keeps leaving cargo canisters near the beacon',
    'a pilot with an expensive ship admitting they have no idea what they are doing',
    'an old feud resurfacing over something embarrassingly minor',
    'somebody describing a ship they could not identify, badly',
    'a light on the scanner where nothing is charted',
    'wreckage spotted today that was not there yesterday',
    'a manoeuvre witnessed so bad it has to be retold immediately',
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
    'a bet between crew members, stakes undisclosed',
    'someone hiding how tired they are, badly',
    'a request to reroute power, resisted',
    'an inventory discrepancy nobody wants to own',
    'a repair that works but looks deeply unprofessional',
    'someone discovering food has disappeared from the galley',
    'a minor alarm everyone has learned to ignore',
    'an argument over whose turn it is to inspect something unpleasant',
    'a crew member noticing the commander has repeated the same mistake twice',
    'a sensor reading that changes whenever somebody looks directly at it',
    'someone making coffee during entirely the wrong phase of flight',
    'a component running hotter than its documentation says it should',
    'a quiet disagreement about whether to wake the commander',
    'somebody admitting they broke something several hours ago',
    'an old repair finally becoming somebody’s problem again',
    'a crew member improvising a fix from equipment intended for something else',
    'an unnecessary checklist being followed with religious seriousness',
    'an important checklist being ignored because everyone knows it by heart',
    'someone finding an object aboard that nobody claims',
    'a disagreement over cabin temperature becoming strangely personal',
    'a crew member requesting shore leave before they have even arrived',
    'a strange vibration that disappears whenever the engines idle',
    'someone hearing a noise nobody else can hear',
    'an unexpected message arriving for one member of the crew',
    'a crew member quietly covering for somebody else’s mistake',
    'the commander making a surprisingly good landing and nobody wanting to say so',
    'a routine systems test producing one deeply non-routine result',
    'someone realising they loaded the wrong supplies several jumps ago',
    'something seen out the viewport that nobody can explain and nobody will log',
  ],
  DEEP: [
    'the sheer absence of traffic',
    'a signal that might have been nothing',
    'the last relay dropping out of range',
    'the discipline of keeping a receiver open for nobody',
    'a count of jumps since the last human voice',
    'a test transmission nobody answers',
    'an old navigation beacon still transmitting long after it should have failed',
    'a weak carrier signal appearing where no carrier is listed',
    'a system already mapped by somebody who never came back this way',
    'a distant contact disappearing before identification completes',
    'a transmission fragment repeating every few hours',
    'a starfield that makes somebody realise how far home actually is',
    'the first artificial signal after days of silence',
    'a navigation entry carrying a commander name somebody recognises',
    'a planet nobody intended to stop at proving unexpectedly beautiful',
    'a routine scan returning something worth turning around for',
    'a jump that leaves the ship facing something nobody expected',
    'a damaged probe discovered where traffic should be almost nonexistent',
    'an empty system containing one inexplicable human-made object',
    'a message queued days ago finally finding enough signal to transmit',
    'somebody calculating how long rescue would take from here',
    'a fuel calculation that suddenly matters more than it did five minutes ago',
    'an expedition marker left by people who passed through years earlier',
    'a stellar phenomenon making instruments disagree with each other',
    'the uncomfortable realisation that another ship may be travelling the same route',
    'a voice transmission too weak to determine whether it is live',
    'a familiar callsign appearing impossibly far from where it belongs',
    'the crew debating whether curiosity justifies another ten jumps',
    'a system that looks ordinary until one scan refuses to fit',
    'a moment when nobody speaks because there is genuinely nothing useful to say',
  ],
  EMERGENCY: [
    'a vessel losing systems',
    'a call for medical assistance',
    'an emergency stood down',
    'a false alarm being logged, tersely',
    'a ship reporting uncontrolled rotation',
    'a pilot who cannot get their landing gear down',
    'an overheating vessel requesting immediate assistance',
    'a collision narrowly avoided and both crews talking at once',
    'someone declaring an emergency far too late',
    'someone declaring an emergency far too early',
    'a ship losing atmosphere but insisting the situation is under control',
    'a vessel running out of fuel within sight of safety',
    'a cargo fire whose exact contents suddenly matter',
    'a navigation failure during final approach',
    'a pilot becoming unresponsive after requesting help',
    'an emergency beacon transmitting inconsistent coordinates',
    'a rescue vessel discovering there are more casualties than reported',
    'a passenger vessel requesting priority without explaining why',
    'a power failure knocking several systems offline at once',
    'a damaged ship refusing to abandon cargo',
    'an evacuation order nobody quite believes',
    'a distress call abruptly cutting off mid-sentence',
    'a medical emergency complicated by docking delays',
    'an emergency channel being clogged by somebody who does not understand protocol',
    'a commander trying to assist another vessel without making things worse',
    'a crisis resolved by something embarrassingly simple',
    'a supposed emergency turning out to conceal something else',
    'a rescue completed, followed by an argument about who caused it',
  ],
  CARRIER: [
    'services being advertised to local traffic',
    'a departure warning',
    'an announcement made with unearned grandeur',
    'a docking window closing sooner than promised',
    'a tritium request dressed up as an announcement',
    'a jump delayed because one commander is still returning',
    'a jump delayed for reasons nobody is willing to announce',
    'a sudden destination change',
    'a carrier captain pretending the fuel situation is completely normal',
    'a visiting pilot complaining about service prices',
    'a market opportunity being announced before anybody checks whether it is real',
    'crew being reminded not to leave ships aboard indefinitely',
    'someone discovering the carrier is going somewhere they did not intend to go',
    'a departure countdown interrupted and restarted',
    'a carrier appearing in system and immediately attracting questions',
    'local traffic asking whether the carrier plans to stay',
    'a jump announcement causing a minor rush back to the pads',
    'a service going offline until further notice',
    'a service coming back online to disproportionate celebration',
    'a commander requesting the carrier wait for them',
    'an announcement thanking everyone for patience nobody actually showed',
    'a tritium donor being praised with suspicious enthusiasm',
    'a carrier crew member trying to recruit miners over local comms',
    'a destination selected because somebody swears there is money there',
    'an argument over whether one more jump can be squeezed from the reserves',
    'somebody discovering they left a ship on the carrier several systems ago',
    'a visiting commander asking where the carrier is going next',
    'the carrier owner changing plans halfway through explaining the plans',
  ],
  CONCOURSE: [
    'a delay announcement',
    'a lost item or unattended container',
    'a shift rotation notice',
    'a safety reminder nobody heeds',
    'a commercial notice',
    'a queue management announcement that manages nothing',
    'a lost item described in too much detail',
    'maintenance scheduled for the worst possible time',
    'a boarding gate changing after everyone has already walked there',
    'a vendor loudly disputing a station fee',
    'someone being paged repeatedly and apparently refusing to respond',
    'an escalator or lift failure redirecting half the concourse',
    'a security checkpoint opening exactly as another one closes',
    'a child asking questions louder than their exhausted parent can answer',
    'an argument at a ticket or transport desk',
    'a restaurant announcing it has run out of the thing everyone ordered',
    'someone sleeping somewhere clearly not intended for sleeping',
    'a public terminal refusing to recognise anybody’s credentials',
    'an announcement asking the owner of a parked vehicle to move it immediately',
    'a promotion attracting far more people than expected',
    'a maintenance robot becoming a temporary local attraction',
    'a traveller insisting their luggage was sent to another system',
    'a shop closing early without explanation',
    'a security team moving quickly while announcements insist everything is normal',
    'a musician or performer drawing an unexpected crowd',
    'somebody trying to sell passage privately',
    'an arrival board changing several times in less than a minute',
    'a smell from one food stall becoming impossible to ignore',
    'a public argument abruptly becoming very quiet when security appears',
    'a station employee giving directions with the confidence of someone completely wrong',
    'an old acquaintance unexpectedly meeting someone between flights',
    'a local news bulletin causing half the concourse to look up at once',
    'a vending machine becoming the focus of a disproportionate dispute',
    'someone realising their departure was yesterday',
    'a passenger discovering their ship has departed without them',
    'a maintenance announcement accidentally broadcasting an internal conversation',
    'a traveller retelling something they saw on the way in, embellishing freely',
  ],
};
