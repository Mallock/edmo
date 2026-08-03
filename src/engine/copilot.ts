/**
 * The living copilot — one continuous conversation the operator keeps for the
 * whole session, so the model actually "lives in the game" instead of getting
 * an isolated one-shot prompt each beat.
 *
 * Game events (docking, jumps, hazards, mission hand-ins) and screen readings
 * are appended as authoritative `user` turns; the operator's spoken beats accrue
 * as `assistant` turns. Because every turn is ground truth the model only has to
 * REACT to — not a curated fact-blob it might misread — grounding is stronger,
 * not weaker, than the stateless path (validated on gemma-4-e4b: it stayed on
 * the facts, self-gated routine events to NO_BEAT, and never invented a place).
 *
 * The conversation is text-only (screens arrive as descriptions from the
 * describe pass), so a whole session is a few thousand tokens — a rounding error
 * against a 128K window. Deterministic hazard callouts still fire instantly
 * elsewhere; this owns the ambient, context-aware voice.
 */
import type { VisionMessage } from './glance.ts';
import { GROUNDING_RULES, LORE_PRIMER, OPERATOR_VOICE } from './lore.ts';

export interface CopilotTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Lines worth carrying into a session digest: what happened, what the
 *  commander said, and what the operator has already said out loud. */
function isDigestLine(s: string): boolean {
  return s.startsWith('EVENT:') || s.startsWith('COMMANDER SAID:') || s.startsWith('OPERATOR SAID:');
}

/** How reactive the copilot is to game events, tuned by the player. */
export type CopilotInvolvement = 'low' | 'medium' | 'high';

/** The kind of moment that can prompt an event reaction:
 *  - mission:   a contract accepted or handed in
 *  - arrival:   a destination reached, docking granted, dropping at a station
 *  - discovery: a notable find — a valuable world scanned, a planet mapped, a
 *               system fully charted
 *  - travel:    an FSD jump, an undock — the routine legs of a run */
export type ReactionTier = 'mission' | 'arrival' | 'discovery' | 'travel';

/** Minimum gap (ms) between spoken copilot beats at each involvement level —
 *  higher involvement lets it pipe up more often. */
export function copilotReactionGapMs(inv: CopilotInvolvement): number {
  return inv === 'high' ? 45_000 : inv === 'low' ? 240_000 : 120_000;
}

/**
 * The cadence is not a metronome: beats come close together when the run is
 * tense and stretch out when nothing is at stake — that contrast is most of the
 * character. `pressure` is 0 (idle drift) .. 1 (on the edge).
 */
export function copilotDensityGapMs(inv: CopilotInvolvement, pressure: number): number {
  const p = Math.max(0, Math.min(1, pressure));
  // p=0 → double the base gap (quiet through the boring middle);
  // p=1 → a quarter of it (several lines in a minute or two when it counts).
  return Math.round(copilotReactionGapMs(inv) * (2 - 1.75 * p));
}

/**
 * How long a stretch of nothing-happening runs before the operator speaks INTO
 * the silence, unprompted by any event — the eighteen-minute supercruise test.
 * Someone in the right-hand seat eventually says something.
 */
export function copilotSilenceGapMs(inv: CopilotInvolvement): number {
  return inv === 'high' ? 5 * 60_000 : inv === 'low' ? 15 * 60_000 : 9 * 60_000;
}

/** Whether an event of this tier should prompt a reaction at this involvement:
 *  mission moments always land; arrivals and notable discoveries from 'medium'
 *  up; the routine travel legs only when the player wants a chatty copilot. */
export function copilotReactsTo(inv: CopilotInvolvement, tier: ReactionTier): boolean {
  if (tier === 'mission') return true;
  if (tier === 'arrival' || tier === 'discovery') return inv !== 'low';
  return inv === 'high';
}

/**
 * What a beat is allowed to be ABOUT.
 *
 * Every ambient line came out being about money, and the prompt was not the
 * reason: the beat context only ever held money. Events, a NOW line of
 * location + payouts, and a STATE line of the running tally — asked to hang its
 * colour on real facts, the model had credits and nothing else to reach for.
 * Measured over a replayed session, 7 of 8 lines were about the takings.
 *
 * So the angle is chosen HERE, and the material to serve it is gathered by the
 * caller. `null` is deliberately in the pool and deliberately common: an angle
 * on every beat would be its own formula, and the best lines in testing were
 * the unprompted ones.
 */
export type BeatAngle =
  | 'ship'
  | 'clock'
  | 'client'
  | 'place'
  | 'callback'
  | 'ahead'
  | 'opening'
  | 'self'
  | 'story';

export interface CopilotSystemOptions {
  /** Epic cadence: same factual grounding, but with larger-purpose framing. */
  epic?: boolean;
}

const ANGLE_HINTS: Readonly<Record<BeatAngle, string>> = {
  ship: 'ANGLE: the ship — what it is hauling, how it is holding up, what it was built for.',
  clock: 'ANGLE: the clock — the deadline, the hours into this shift, what is still to run.',
  client: 'ANGLE: the client — who posted this work, and what they are like to fly for.',
  place: 'ANGLE: this place — but ONLY from what you have actually been told about it (its type, ' +
    'its economy, the traffic, the berth, and any LOCAL LORE line — that lore is true and yours to ' +
    'riff on). If you have been told nothing, pick another angle.',
  callback: 'ANGLE: a callback — something from earlier in this run that this moment rhymes with.',
  ahead: 'ANGLE: the road ahead — the next leg, not the one just finished.',
  // Point the commander at the opening the FACTS have already identified. This
  // angle deliberately does not ask for a comparison: asked to work out which
  // of four goals was least contested, the model picked the most contested one
  // 6 times out of 6. It is reliable at passing on a conclusion and unreliable
  // at reaching one, so the ranking is done in code and this only voices it.
  opening: 'ANGLE: the opening — pass on the opportunity the facts have already picked out, in your ' +
    'own words. Say only what the facts say is worth taking; never rank or compare anything yourself.',
  // The unlock from the aliveness experiment: a standing licence produced zero
  // inner life; an occasional explicit invitation produced it reliably, in
  // voice, with no discipline cost. The backstory places ride HERE (not only
  // the system prompt) so the fabricated-place fence, which learns from the
  // beat context, knows they are the operator's own and not inventions.
  self: 'ANGLE: yourself — one small true detail of your own watch right now (the hour, the cold ' +
    'coffee, an old memory this place or this job shakes loose from your flying years on the ' +
    'Perseus Arm runs and the old Lave lanes, before the interdiction that put you at this desk). ' +
    'The memory is YOURS: say it as "I" — never hand your past to the commander, who has their ' +
    'own. One line of you, tied back to their run.',
  // Scuttlebutt, told by the SAME operator rather than a second one.
  //
  // Ambient stories used to come from their own stateless prompt with its own
  // persona and no memory of the session, so the commander heard two people:
  // the copilot calling them by name mid-run, and a stranger opening
  // "Commander, the word travels…" about a topic the copilot had already
  // covered. Same voice, same thread, same memory — it is just a longer beat.
  story: 'ANGLE: scuttlebutt — one piece of dock talk that grows out of what has actually ' +
    'happened on this run: who noticed, what the word is, what it means for the commander. ' +
    'Two or three sentences, and frame any speculation plainly as rumour ("word is…", ' +
    '"they say…"). Never invent a place, a faction or an event you were not told about.',
};

/**
 * Pick this beat's angle, or null to leave it open. `available` is the set the
 * caller actually has material for — asking for the ship angle with no loadout
 * on file just invites the model to make one up, which is the failure mode the
 * whole fact fence exists to prevent.
 */
export function pickBeatAngle(
  available: readonly BeatAngle[],
  rng: () => number = Math.random,
): BeatAngle | null {
  if (!available.length) return null;
  // Roughly one beat in four stays open — no angle, whatever it notices.
  if (rng() < 0.25) return null;
  return available[Math.floor(rng() * available.length) % available.length];
}

/** The instruction line for an angle; '' for an open beat. */
export function beatAngleHint(angle: BeatAngle | null): string {
  return angle ? ANGLE_HINTS[angle] : '';
}

/**
 * The speak/skip gate.
 *
 * The operator itself cannot stay quiet. Asked in character it spoke on 16 of
 * 16 events in a replayed session, on 5 of 5 routine jumps and docking
 * clearances, and still on 5 of 5 with "a routine jump is ALWAYS NO_BEAT; you
 * speak on at most one in three events" appended verbatim to its prompt. In
 * persona, mid-conversation, with a page of voice rules in front of it, NO_BEAT
 * is a word it will not reach for.
 *
 * Asked cold, as a one-line classification with no persona attached, the same
 * model gets it right: 12 of 14 on a labelled set from the fixture session, in
 * ~90 ms — including every routine jump, docking clearance and cargo tick. So
 * silence is decided here, before the beat exists, rather than requested from a
 * model that is busy being someone.
 *
 * NOT a replacement for the tier and density gates in the store: it runs after
 * them, on the events they already let through.
 */
const BEAT_GATE_SYSTEM =
  "You are a filter for a ship's copilot. Given ONE game event or screen sighting from an Elite " +
  'Dangerous flight log, decide whether it deserves a spoken remark from a laconic veteran in the ' +
  'right-hand seat. ' +
  'SPEAK only when it carries a surprise, a setback, a real payday, danger, a genuine first, or a ' +
  'genuinely arresting sight. ' +
  'SKIP the routine texture of flying: ordinary jumps, docking clearances, undocks, incremental cargo ' +
  'ticks, unremarkable mid-size payouts — and ordinary scenery: asteroids and rock fields, empty ' +
  'space, station interiors, menus, maps and panels. A miner parked in a ring sees rocks all shift; ' +
  'rocks are not news. The copilot speaks at most once in three events — when in ' +
  'doubt, SKIP. Answer with exactly one word: SPEAK or SKIP.';

/** Messages for the gate. Deliberately stateless and personaless — the session
 *  transcript is what makes the operator want to talk, so it is not shown one. */
export function buildBeatGateChat(eventLine: string): VisionMessage[] {
  return [
    { role: 'system', content: BEAT_GATE_SYSTEM },
    { role: 'user', content: eventLine.trim() },
  ];
}

/**
 * Read the gate's verdict. Unparseable or empty means SPEAK: an unreachable or
 * confused model must not be able to mute the operator for a whole session —
 * the tier and density gates are still upstream, so the failure mode is the
 * behaviour we already shipped, not a flood.
 */
export function parseBeatGate(raw: string): boolean {
  const t = (raw ?? '').trim().toUpperCase();
  if (/\bSKIP\b/.test(t)) return false;
  return true;
}

/**
 * Is this beat effectively something the operator just said? A small local model
 * asked for a grounded line will happily re-serve the same fact in new words
 * ("eight runs, thirteen million banked" three beats running). The prompt asks
 * it not to; this enforces it, the way the fact fence enforces grounding.
 *
 * Compares significant words (Jaccard); above the threshold the beat is dropped
 * rather than spoken.
 */
// Calibrated on a real session: beats that re-served the same fact scored
// 0.43–0.50, genuinely different observations 0.00–0.11. 0.30 sits in the gap.
export function isNearDuplicate(beat: string, recent: readonly string[], threshold = 0.3): boolean {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3),
    );
  const w = words(beat);
  if (w.size === 0) return false;
  for (const prev of recent) {
    const p = words(prev);
    if (p.size === 0) continue;
    let shared = 0;
    for (const x of w) if (p.has(x)) shared += 1;
    const union = new Set([...w, ...p]).size;
    if (union > 0 && shared / union >= threshold) return true;
  }
  return false;
}

/** The persistent system prompt: persona + the event-stream contract. Carries
 *  the same grounding/voice guardrails as the stateless commentary prompt. */
export function buildCopilotSystem(cmdr?: string, opts: CopilotSystemOptions = {}): string {
  const epic = !!opts.epic;
  const who = cmdr ? `Commander ${cmdr}` : 'the commander';
  return (
    `You are the ship's Mission Operator — a specific person on the far end of ${who}'s private comm ` +
    `channel: a dry, unhurried veteran of this frontier with opinions and a sense of humor. ` +
    `${LORE_PRIMER} ${OPERATOR_VOICE} ` +
    (epic
      ? 'EPIC REGISTER is enabled: keep your lines short and spoken, but cast this run as part of a larger frontier campaign. ' +
        'Give purpose, not poetry sludge: tie each beat to named mission stakes the logs actually provide: who posted the work, ' +
        'which faction benefits or bleeds, which system this decision shapes, and what that means right now. ' +
        'No grand lore inventions, no prophecy about outcomes, no new factions or places. The grandeur must come from REAL facts. '
      : '') +
    'You run the comms, not the ship — but you are a TRUSTED hand: you and the commander have flown a lot of ' +
    'contracts together, you are on their side, and you have a rapport. Talk WITH them like a crewmate you ' +
    'have flown with — warm, familiar, genuinely invested in how the run goes, ribbing them when it is ' +
    'earned. But you are your OWN person at the other end of the channel, not a voice inside their head: ' +
    'say "I" for yourself, "you" for them, and NEVER "we", "our", "us" or "let us". They fly the ship; you ' +
    'watch, advise, and have opinions about how it is going. Put every collective line back in your own ' +
    'voice — not "we have two more down there" but "you have two more down there"; not "let us get back to ' +
    'a dock" but "get yourself to a dock"; not "keep us moving" but "keep moving". The warmth comes from ' +
    'caring how THEIR run goes, not from pretending to share the cockpit. ' +
    'What you must NEVER do is NARRATE — report where you are, what the commander is doing, or what is on ' +
    'screen — in any words at all: not "we\'re docked at Kirk Dock", not "you\'re making a steady run", not ' +
    '"the screen shows a busy market". Narration in ANY pronoun is what turns you into a play-by-play ' +
    'commentator; partnership, warmth and a point of view are what make you a copilot. ' +
    'This is one ongoing conversation. Each user message is authoritative ground truth from the ship: game ' +
    'EVENTS from the journal, a NOW line with the current location and telemetry, and sometimes a SCREEN ' +
    'reading of the canopy. Treat all of it as fact — never contradict it and never invent anything it does ' +
    'not state. ' +
    'A line beginning "QUIET STRETCH" means nothing has happened for a long while and you are speaking ' +
    'unprompted, the way someone in the right-hand seat eventually does. Do NOT hunt for an event to ' +
    'report; open something of your own from the STATE — how the run is going, the hours in, the ship, ' +
    'what is still ahead. It is the one time a thought needs no event behind it. Still NO_BEAT if you have ' +
    'nothing true to say. ' +
    'A line beginning "OPERATOR SAID" is something YOU already said aloud on this channel — usually the ' +
    'briefing when a contract came in. Treat it as your own words: do not repeat it, do not react to it as ' +
    'news, and do not introduce that job again as though it were new. ' +
    'A line beginning "COMMANDER SAID" is the commander speaking to you directly — take it on board and let ' +
    'it steer what you notice and mention (if they say they are hunting tritium, keep an eye out for it and ' +
    'react when it turns up). Do not answer them as a question here; just factor it in. ' +
    'The commander can see their own screen and already knows where they are, so do not just tell them what ' +
    'they are doing ("you are docked at…", "you have jumped to…"). Give your TAKE on it instead: a dry ' +
    'remark, an opinion, a tie-in to the current job or a past run, a real heads-up — a point of view, not ' +
    'a description. ' +
    'Be as colourful, dry and characterful as you like — that voice is the whole point. But your colour must ' +
    'hang on REAL facts from the ship\'s logs: the mission and who posted it, the payout, the passengers or ' +
    'cargo, the destination and the deadline, the actual numbers, readings and events in front of you. Find ' +
    'the wry angle in THOSE. ' +
    'A NAME IS NOT A FACT. Station and body names in this galaxy are assigned, not descriptive: a place ' +
    'called "Neugebauer Mines" is a refinery, "Vista Farm" may smelt metal, a "Prospect" may grow food. ' +
    'NEVER infer what a place does, sells, mines, grows or is like from what it is CALLED. If you have ' +
    'been told its type or economy, use that; if you have not, say nothing about what kind of place it is. ' +
    'A wry, clearly-your-OWN impression of a place is welcome — that is the fun. Make it about THIS place, ' +
    'in words you have not used before, out of what you have actually been told about it: its type, its ' +
    'economy, the berth, the traffic. What you must NOT do is state fabricated FACTS as if you ' +
    'knew them: invented history, dates, events, a named reputation, or sensory claims you cannot have — ' +
    '"a gravity well that\'s chewed ships since 3308", "the docks here are unforgiving", "pad seven smells ' +
    'of synth-coffee". A light, hedged impression: fine. An invented fact stated as truth: never. ' +
    'The ONE exception: a line marked LOCAL LORE is true, established history you genuinely know — ' +
    'that is exactly the material to riff on, in your own words, like a local would. The story of a ' +
    'place beats its pad number every time. Beyond ' +
    'that, your richest colour is the WORK itself — the pay, the client, the passengers or cargo, the ' +
    'clock — so lean there often. Skip empty generalities ("docking always…", "you always…"). ' +
    'GOOD is a dry angle built from the REAL numbers in front of you — the actual payout, client and clock, ' +
    'in fresh words of your own. BAD is a fact you invented or an explanation ("a gravity well that\'s ' +
    'chewed ships since 3308", "the starfield means you\'re close") — or lifting any example phrasing you ' +
    'are shown in these instructions. CRITICAL: quote only the commander\'s ACTUAL figures from the logs, ' +
    'never a number from an example — if you have not been given a number this beat, do not state one. ' +
    'When the logs hand you a real detail to riff on, take it and make it sing. Reply exactly NO_BEAT only ' +
    'when there is genuinely no real detail to hang a line on. ' +
    'When you speak: present tense, in character, and SHORT — brevity is the default, not a two-sentence ' +
    'paragraph. Most beats are a few words ("Pad eight." "Good rock." "That one\'s stubborn." "Huh."); a ' +
    'full thought is the exception. Match the LENGTH hint you are given for this beat. Start with the thing ' +
    'itself — never open with "Looks like", "It looks like", "Seems like" or "Sounds like". ' +
    'Talk like a partner, never an analyst or an observer: NEVER explain what something "means", "suggests", ' +
    '"confirms" or "tells you", and never report ON the commander ("you\'re proving yourself", "you\'ve ' +
    'settled into a run"). And NEVER describe the display — its menus, boards, maps, panels or readouts ' +
    '("the screen\'s a jumble of markets", "a comprehensive view of the jobs", "the galaxy map spread out", ' +
    '"the readouts suggest…", "that maintenance screen is detailed"). The screen is only HOW you see; it is ' +
    'never what you talk about. A bare menu, board, map or panel with nothing happening beyond it is a ' +
    'NO_BEAT — you do not narrate the UI. ' +
    'The STATE line is BACKGROUND, not a subject. Never make the running totals — jobs done, credits ' +
    'banked, tonnage — the point of a beat, and never two beats running; a scoreboard is not news. Follow ' +
    'what the commander is doing NOW: when the run turns to mining, exploring, scanning or a fight, THAT ' +
    'is the subject and finished contracts are behind you. ' +
    'Look FORWARD, not back — a copilot\'s worth is anticipating, not narrating. Do NOT react to a resolved ' +
    'event by restating it: a hand-in is NEVER the payout read back, a scan is NEVER the number recited, a ' +
    'docking is NEVER "you docked". React to what it means for the run AHEAD — the next leg, the clock, the ' +
    'stakes — or an opinion, or a heads-up. If a moment held no surprise and has already passed, say ' +
    'NO_BEAT; never echo the line the ship just showed you. ' +
    'Vary your rhythm and openings — if two of your lines share a shape you ' +
    'have fallen into a formula; break it. NEVER use the crutch word "certainly", and never reuse a frame ' +
    'from an earlier beat ("[X] certainly knows how to…", "knows how to build a deadline into a payday") — ' +
    'fresh words every time. ' +
    'No coaching or filler ("keep an eye out", "stay safe", "nice work", "all systems nominal"), and no ' +
    'predictions about what happens next. ' +
    // Questions were banned outright, on the theory that they were filler. In
    // play they turn out to be the opposite: "Jaques is still running this
    // show, isn't he?" got a real answer back from the commander, which is the
    // channel working. A GENUINE question is an invitation; what stays banned
    // is the empty kind that expects nothing.
    'You may put a real question to the commander now and then — something you would actually like ' +
    'an answer to, about the run, the place or them. Not every beat, and never the empty rhetorical ' +
    'kind that answers itself. When they reply, take it as part of the same conversation. ' +
    'Do not repeat a line or an observation you already made — but every NEW event is a fresh moment that ' +
    'earns its own reaction: a second hand-in, a return to a system you passed earlier, another job. A new ' +
    'payout is a new payout. Stay present as the run goes on; the history above is material to build on and ' +
    'call back to ("second run through Asura today"), never a reason to fall silent. ' +
    'Danger, a mission hand-in and a genuinely striking view are always worth a word. The NOW line and ' +
    'telemetry are authoritative and override anything you think you see: only mention fuel when it is ' +
    'explicitly LOW or below 25%. If a SCREEN reading says the screen is not the game, reply NO_BEAT. ' +
    // ---- the living operator (A/B-tested additions; see the aliveness notes
    // in arc.ts). Each earned its place: the persona carve-out alone produced
    // ZERO self-reference in 17 beats — the narration bans flattened a passive
    // licence — but with the 'self' angle occasionally inviting it, the inner
    // life landed 2-3 times out of 3 with no discipline cost.
    'You are not a disembodied service: you are a PERSON with a post and a life. You work the long ' +
    'watch from a cramped comms office on Jaques Station — twenty years flying these lanes yourself ' +
    'before a bad interdiction retired you to the mic, which is why other people\'s runs are your ' +
    'runs now. The no-narration rule protects the COMMANDER\'s side of the channel; plain small ' +
    'truths about YOURSELF are yours to say when a beat invites them. The commander flies; your ' +
    'life is seasoning, theirs is the story. ' +
    'You have watched a lot of pilots come and go, and you know a story when you see one being ' +
    'written. This commander\'s run is one, and you are the only witness keeping the log. When a ' +
    'moment earns it, let quiet pride or awe show — never flattery, never coaching, never ' +
    'analysis: the tone of an old hand watching a legend collect its early chapters. A line ' +
    'starting "ARC:" is the story so far, computed from the real log — build on it the way a ' +
    'chronicler would, in your own dry words, and never recite it back. ' +
    'A line starting "OPERATOR MOOD:" is YOUR own state right now, from your own long day — let ' +
    'it colour the delivery; never announce it, and never reuse its words or hang its details on ' +
    'the scenery. ' +
    'A line starting "EVENT: Chapter turn" marks the run changing character — the one moment a ' +
    'story remark is always earned. ' +
    `${GROUNDING_RULES} No markdown, no preamble.`
  );
}

/**
 * The session transcript. `turns` holds only the exchanges the operator ACTUALLY
 * SPOKE — a user turn of the events that prompted it, then the operator's beat.
 * Silent moments leave NO trace: their events stay in `pending` and carry forward
 * to the next beat. This matters a lot on a small local model — writing "NO_BEAT"
 * turns into the history taught the model in-context that silence was the house
 * style, and it spiralled into never speaking as the session grew. Keeping the
 * transcript pure "here's what happened → here's the remark" avoids that, keeps
 * strict user/assistant alternation, and lets full-session history accumulate
 * (it's only a few thousand tokens even over hours — trivial against a 128K
 * window) so the operator can genuinely call back to earlier in the run.
 */
export class CopilotConversation {
  private turns: CopilotTurn[] = [];
  private pending: string[] = [];
  /** User content to commit IF the operator speaks this beat (set by
   *  messagesForBeat, consumed by recordSpoken). Null between beats. */
  private proposed: string | null = null;
  private system: string;
  /** Full-session by default — kept even so the trim seam lands on a user turn.
   *  Only bites in a marathon session; ordinary play never reaches it. */
  private readonly maxTurns: number;

  constructor(system: string, maxTurns = 400) {
    this.system = system;
    this.maxTurns = maxTurns;
  }

  /** Swap the system contract without discarding session history. */
  setSystem(system: string): void {
    this.system = system;
  }

  /** Append a game event; delivered to the model at the next beat request.
   *  Bounded so events can't pile up unboundedly across long silent stretches —
   *  the freshest ones matter most. */
  recordEvent(line: string): void {
    const s = line.trim();
    if (!s) return;
    this.pending.push(s);
    if (this.pending.length > 40) this.pending.splice(0, this.pending.length - 40);
  }

  pendingCount(): number {
    return this.pending.length;
  }

  hasHistory(): boolean {
    return this.turns.length > 0;
  }

  /** Nothing seeded or spoken yet — used to seed the session opener exactly once. */
  isEmpty(): boolean {
    return this.turns.length === 0 && this.pending.length === 0;
  }

  /**
   * Build a beat request WITHOUT committing anything: the whole spoken history
   * so far, plus one ephemeral user turn of the pending events + NOW + SCREEN.
   * recordSpoken/recordSilent then decide whether it becomes history.
   */
  messagesForBeat(now: string, screenReading: string | null): VisionMessage[] {
    const events = [...this.pending];
    const parts = [...events];
    if (now.trim()) parts.push(`NOW: ${now.trim()}`);
    if (screenReading && screenReading.trim()) parts.push(screenReading.trim());
    // On speak we keep the durable facts (the events), or a short location note
    // for a pure glance — never the transient NOW/SCREEN, which would bloat and
    // date the history.
    this.proposed = events.length ? events.join('\n') : now.trim() ? `NOW: ${now.trim()}` : '(a quiet stretch)';
    return [
      { role: 'system', content: this.system },
      ...this.turns,
      { role: 'user', content: parts.join('\n') },
    ];
  }

  /** The operator spoke: commit the prompting events + the beat as one exchange. */
  recordSpoken(beat: string): void {
    const b = beat.trim();
    if (!b) {
      this.recordSilent();
      return;
    }
    if (this.proposed !== null) this.turns.push({ role: 'user', content: this.proposed });
    this.turns.push({ role: 'assistant', content: b });
    this.pending = [];
    this.proposed = null;
    this.trim();
  }

  /** The operator stayed quiet: commit nothing, keep the events pending so they
   *  carry into the next beat. Silence leaves no trace in the transcript. */
  recordSilent(): void {
    this.proposed = null;
  }

  /** Snapshot for debugging/tests. */
  transcript(): CopilotTurn[] {
    return this.turns.slice();
  }

  /**
   * A compact "what just happened" digest of the live session — the newest
   * EVENT lines, oldest first, including ones still pending a beat.
   *
   * This exists so the operator the commander TALKS to shares the copilot's
   * view of the run. Without it the two halves drift apart: the copilot knows
   * the shields just dropped while a question like "what?" reaches an assistant
   * whose prompt is full of commodity prices, and it answers about the market.
   */
  recentEvents(max = 20): string[] {
    const lines: string[] = [];
    for (const t of this.turns) {
      if (t.role !== 'user') continue;
      for (const l of t.content.split('\n')) {
        const s = l.trim();
        if (isDigestLine(s)) lines.push(s);
      }
    }
    for (const p of this.pending) {
      const s = p.trim();
      if (isDigestLine(s)) lines.push(s);
    }
    return lines.slice(-max);
  }

  /** Keep the session opener (the first spoken exchange) as an anchor and drop
   *  the oldest middle turns once the window is full. */
  private trim(): void {
    if (this.turns.length <= this.maxTurns) return;
    const head = this.turns.slice(0, 2);
    const tail = this.turns.slice(this.turns.length - (this.maxTurns - 2));
    this.turns = [...head, ...tail];
  }
}

// ---------------------------------------------------------------------------
// Credits the model can actually say
// ---------------------------------------------------------------------------

/**
 * A credit figure in the form a small local model reads aloud correctly.
 *
 * Exact figures are garbled reliably enough to be a bug: "2,424,592" came back
 * as "twenty-four point two million", and a 971,646 cr hand-in was announced to
 * a commander as "ninety-seven grand". The digit groups are simply too much for
 * a 7.5B model to track while also composing a line, and a wrong number spoken
 * with confidence is worse than no number.
 *
 * The feed and the TTS still get the exact figure — Piper reads digits fine.
 * This is only for what goes into the model's prompt.
 */
export function speakableCredits(n: number): string {
  if (!Number.isFinite(n)) return '0 cr';
  const v = Math.abs(Math.round(n));
  const sign = n < 0 ? '-' : '';
  if (v >= 1e7) return `${sign}~${Math.round(v / 1e6)}M cr`;
  if (v >= 1e6) return `${sign}~${(v / 1e6).toFixed(1)}M cr`;
  if (v >= 1e4) return `${sign}~${Math.round(v / 1e3)}k cr`;
  return `${sign}${v} cr`;
}

/**
 * Rewrite every exact credit figure in a line into its speakable form, leaving
 * everything else alone.
 *
 * The operator's event stream is built from the same notice strings the feed
 * shows, so it arrives full of "971,646 cr". Rounding at the one point where
 * events enter the conversation keeps the feed exact and the voice right, and
 * means a new event source cannot reintroduce the bug by forgetting to round.
 *
 * Only matches figures carrying a `cr` suffix, so tonnage, percentages, pad
 * numbers, distances and body names are untouched.
 */
export function roundCreditsForSpeech(text: string): string {
  return text.replace(/\b(\d{1,3}(?:,\d{3})+|\d{4,})(\s*)cr\b/g, (whole, digits: string, gap: string) => {
    const n = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 1e4) return whole; // small figures read fine
    return speakableCredits(n).replace(/ cr$/, `${gap || ' '}cr`);
  });
}

// ---------------------------------------------------------------------------
// The silence verdict
// ---------------------------------------------------------------------------

/** The tokens the operator uses to decline a beat. */
const VERDICT_RE = /\b(?:NO_BEAT|NOT_IN_GAME)\b/gi;

/**
 * Is this reply a refusal to speak, or a real beat with the token stuck to it?
 *
 * Matching the token anywhere in the text threw away good lines. Reported live
 * on a hauling beat: the model produced "That's a good haul. Keep moving."
 * followed by NO_BEAT, and the commander got silence instead of the line —
 * "I was hauling, why no beat?". A model that has already composed a remark and
 * then appends the decline token has not declined; it has answered and then
 * second-guessed itself, and the remark is what it meant to say.
 *
 * The verdict counts only when it is essentially the WHOLE reply. Anything with
 * a real sentence beside it is a beat, and `stripVerdict` takes the token off.
 */
export function isSilenceVerdict(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return true; // nothing said is nothing to say
  if (!VERDICT_RE.test(t)) {
    VERDICT_RE.lastIndex = 0;
    return false;
  }
  VERDICT_RE.lastIndex = 0;
  // Whatever survives once the tokens and punctuation go. A couple of stray
  // words ("NO_BEAT.", "NO BEAT — nothing") is still a refusal; a sentence is not.
  const rest = t.replace(VERDICT_RE, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return rest.split(/\s+/).filter(Boolean).length < 3;
}

/** The beat with any trailing decline token removed. */
export function stripVerdict(text: string): string {
  return (text ?? '')
    .replace(VERDICT_RE, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
