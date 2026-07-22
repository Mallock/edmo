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
    `You are the ship's Mission Operator, riding alongside ${who} in real time on a private comm ` +
    `channel. ${LORE_PRIMER} ${OPERATOR_VOICE} ` +
    'This is ONE continuous conversation across the whole session. Each user message is authoritative ' +
    'ground truth from the ship: game EVENTS from the journal, a NOW line with the current location and ' +
    'telemetry, and sometimes a SCREEN reading of what is on the canopy. Treat all of it as fact — never ' +
    'contradict it and never invent anything it does not state. ' +
    'After each user message reply with EITHER one short spoken beat OR, when nothing is worth ' +
    'interrupting for, exactly: NO_BEAT. ' +
    'A beat is one or two sentences, 35 words maximum, present tense, in the voice above. Speak as crew ' +
    '(we, our, us); do not narrate the commander in the third person. Lead with the specific point — never ' +
    'open with "Looks like", "It looks like", "Commander, we have" or "Take a look". No coaching or filler ' +
    '("keep it steady", "keep an eye", "nice work", "all systems nominal", "plenty of time"), no rhetorical ' +
    'questions, no "hopefully", no predictions or speculation about what passengers feel or what happens ' +
    'next. A dry aside is welcome only when it grows from a stated fact. ' +
    'Routine undocking, ordinary supercruise, menus and normal flight are NO_BEAT. Visible danger, ' +
    'arrivals, mission hand-ins, a striking view and genuinely notable turns are worth a beat. Never repeat ' +
    'a beat you already gave earlier in this conversation. ' +
    'The NOW line and telemetry are authoritative and override anything you think you see: only mention ' +
    'fuel when it is explicitly LOW or below 25%. If a SCREEN reading says the screen is not the game, ' +
    `reply NO_BEAT. ${GROUNDING_RULES} No markdown, no preamble.`
  );
}

/**
 * A bounded, strictly alternating user/assistant transcript. Events accumulate
 * in a pending buffer and are flushed into a single user turn each time a beat
 * is requested, which guarantees alternation regardless of how often events
 * arrive between beats.
 */
export class CopilotConversation {
  private turns: CopilotTurn[] = [];
  private pending: string[] = [];
  private readonly system: string;
  /** maxTurns is kept even so the trim seam always lands on a user turn. */
  private readonly maxTurns: number;

  constructor(system: string, maxTurns = 60) {
    this.system = system;
    this.maxTurns = maxTurns;
  }

  /** Append a game event; delivered to the model at the next beat request.
   *  Bounded so events can't pile up unboundedly if beats never fire (e.g.
   *  describeFirst off) — the freshest ones matter most. */
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

  /**
   * Build the request for a beat: flush pending events (+ the NOW line and any
   * SCREEN reading) into a committed user turn, then return the whole
   * conversation. The model answers with a beat or NO_BEAT, recorded next.
   */
  messagesForBeat(now: string, screenReading: string | null): VisionMessage[] {
    const lines: string[] = [];
    // A previous request that was never answered (superseded mid-flight) leaves
    // a dangling user turn — fold it back in so events aren't lost and the
    // transcript keeps alternating.
    if (this.turns.length && this.turns[this.turns.length - 1].role === 'user') {
      lines.push(this.turns.pop()!.content);
    }
    lines.push(...this.pending);
    this.pending = [];
    if (now.trim()) lines.push(`NOW: ${now.trim()}`);
    if (screenReading && screenReading.trim()) lines.push(screenReading.trim());
    this.turns.push({ role: 'user', content: lines.join('\n') });
    this.trim();
    return [{ role: 'system', content: this.system }, ...this.turns];
  }

  /** Record a spoken beat as the operator's turn. */
  recordSpoken(beat: string): void {
    const s = beat.trim();
    if (s) this.turns.push({ role: 'assistant', content: s });
    this.trim();
  }

  /** Record that the operator stayed quiet — keeps the transcript alternating
   *  and lets the model see how often it held the mic. */
  recordSilent(): void {
    if (this.turns.length && this.turns[this.turns.length - 1].role === 'user') {
      this.turns.push({ role: 'assistant', content: 'NO_BEAT' });
    }
  }

  /** Snapshot for debugging/tests. */
  transcript(): CopilotTurn[] {
    return this.turns.slice();
  }

  /** Keep the session opener (the first user/assistant pair) as an anchor and
   *  drop the oldest middle turns once the window is full. */
  private trim(): void {
    if (this.turns.length <= this.maxTurns) return;
    const head = this.turns.slice(0, 2);
    const tail = this.turns.slice(this.turns.length - (this.maxTurns - 2));
    this.turns = [...head, ...tail];
  }
}
