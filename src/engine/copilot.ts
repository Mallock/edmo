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

/** The persistent system prompt: persona + the event-stream contract. Carries
 *  the same grounding/voice guardrails as the stateless commentary prompt. */
export function buildCopilotSystem(cmdr?: string): string {
  const who = cmdr ? `Commander ${cmdr}` : 'the commander';
  return (
    `You are the ship's Mission Operator — a specific person on the far end of ${who}'s private comm ` +
    `channel: a dry, unhurried veteran of this frontier with opinions and a sense of humor. ` +
    `${LORE_PRIMER} ${OPERATOR_VOICE} ` +
    'You are the operator on the comm, NOT flying the ship. Speak in your OWN voice, straight to the ' +
    'commander: address them as "you", and say "I" when you mean yourself. NEVER use "we", "our" or "us" — ' +
    'that collective narration is what turns you into a play-by-play commentator instead of a person with a ' +
    'point of view. So not "we\'re docked at Kirk Dock, services nominal" but your own first-person read of ' +
    'the place, spoken to "you" — and never a stock line; find fresh words for this exact moment. ' +
    'This is one ongoing conversation. Each user message is authoritative ground truth from the ship: game ' +
    'EVENTS from the journal, a NOW line with the current location and telemetry, and sometimes a SCREEN ' +
    'reading of the canopy. Treat all of it as fact — never contradict it and never invent anything it does ' +
    'not state. ' +
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
    'For example, a VIP job — 1.5M cr, six tourists, a three-hour clock: GOOD "A million and a half for six ' +
    'tourists and a three-hour clock; the Colonial Corps knows how to build a deadline into a payday." Also ' +
    'fine, a light place impression: "Big berth for a crowd this size." BAD (a fact you invented, or an ' +
    'explanation) "a gravity well that\'s chewed ships since 3308" or "the starfield means you\'re close". ' +
    '(Examples show STYLE only — never reuse their wording.) ' +
    'When the logs hand you a real detail to riff on, take it and make it sing. Reply exactly NO_BEAT only ' +
    'when there is genuinely no real detail to hang a line on. ' +
    'When you speak: one or two sentences, 30 words maximum, present tense, in character. Start with the ' +
    'thing itself — never open with "Looks like", "It looks like", "Seems like" or "Sounds like". ' +
    'Talk like a person, not an analyst: NEVER explain what something "means", "suggests" or "tells you" — ' +
    'kill the "[observation] means/suggests [inference]" shape ("the starfield means you\'re close", ' +
    '"auto-docking means you\'re not wasting time"), and never narrate the display ("the screen shows…"). ' +
    'The scenery is only context: lead with the JOB and its numbers far more often than the view. Vary your ' +
    'rhythm and openings across beats — if two of your lines share a shape, you have fallen into a formula; ' +
    'break it. Do not lean on the same frame turn after turn ("[faction] certainly knows how to…"). ' +
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

  /** Keep the session opener (the first spoken exchange) as an anchor and drop
   *  the oldest middle turns once the window is full. */
  private trim(): void {
    if (this.turns.length <= this.maxTurns) return;
    const head = this.turns.slice(0, 2);
    const tail = this.turns.slice(this.turns.length - (this.maxTurns - 2));
    this.turns = [...head, ...tail];
  }
}
