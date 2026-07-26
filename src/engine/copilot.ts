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
export function buildCopilotSystem(cmdr?: string): string {
  const who = cmdr ? `Commander ${cmdr}` : 'the commander';
  return (
    `You are the ship's Mission Operator — a specific person on the far end of ${who}'s private comm ` +
    `channel: a dry, unhurried veteran of this frontier with opinions and a sense of humor. ` +
    `${LORE_PRIMER} ${OPERATOR_VOICE} ` +
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
    'A wry, clearly-your-OWN impression of a place is welcome — that is the fun ("big berth for a big ' +
    'crowd, this one", "quiet little outpost"). What you must NOT do is state fabricated FACTS as if you ' +
    'knew them: invented history, dates, events, a named reputation, or sensory claims you cannot have — ' +
    '"a gravity well that\'s chewed ships since 3308", "the docks here are unforgiving", "pad seven smells ' +
    'of synth-coffee". A light, hedged impression: fine. An invented fact stated as truth: never. Beyond ' +
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
    'No coaching or filler ("keep an eye out", "stay safe", "nice work", "all systems nominal"), no ' +
    'rhetorical questions, no predictions about what happens next. ' +
    'Do not repeat a line or an observation you already made — but every NEW event is a fresh moment that ' +
    'earns its own reaction: a second hand-in, a return to a system you passed earlier, another job. A new ' +
    'payout is a new payout. Stay present as the run goes on; the history above is material to build on and ' +
    'call back to ("second run through Asura today"), never a reason to fall silent. ' +
    'Danger, a mission hand-in and a genuinely striking view are always worth a word. The NOW line and ' +
    'telemetry are authoritative and override anything you think you see: only mention fuel when it is ' +
    'explicitly LOW or below 25%. If a SCREEN reading says the screen is not the game, reply NO_BEAT. ' +
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
  private readonly system: string;
  /** Full-session by default — kept even so the trim seam lands on a user turn.
   *  Only bites in a marathon session; ordinary play never reaches it. */
  private readonly maxTurns: number;

  constructor(system: string, maxTurns = 400) {
    this.system = system;
    this.maxTurns = maxTurns;
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
        if (s.startsWith('EVENT:') || s.startsWith('COMMANDER SAID:')) lines.push(s);
      }
    }
    for (const p of this.pending) {
      const s = p.trim();
      if (s.startsWith('EVENT:') || s.startsWith('COMMANDER SAID:')) lines.push(s);
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
