/**
 * The oracle commands — the commander leans on the fiction.
 *
 * Three phrases, straight out of the solo-RPG playbook, spoken or typed into
 * the ask box: `reveal a detail` (invent something hidden, seeded by real
 * system facts), `advance a threat` (the campaign clock moves — in CODE, one
 * segment, never the last — and the operator narrates the tightening), and
 * `flashback` (a past saga episode told back as a memory). Each is a plan:
 * extra knowledge for the system prompt plus a rewritten user turn, run
 * through the SAME ask pipeline as any question — same persona, same engine
 * slot, same latency budget. The plans are pure so they can be tested; the
 * store owns the state changes (advanceThreat) and the call.
 */
import type { SpineThread } from './campaign.ts';
import { CLOCK_SEGMENTS } from './campaign.ts';
import { UNIVERSE_REGISTER } from './lore.ts';
import { rotateWindow } from './rotate.ts';

export type OracleKind = 'reveal' | 'advance' | 'flashback';

/** The phrase must LEAD the ask — "can you reveal a detail" is a question. */
const COMMANDS: ReadonlyArray<[RegExp, OracleKind]> = [
  [/^reveal a detail\b/i, 'reveal'],
  [/^advance a threat\b/i, 'advance'],
  [/^flashback\b/i, 'flashback'],
];

export function oracleCommandOf(text: string): OracleKind | null {
  for (const [re, kind] of COMMANDS) if (re.test(text.trim())) return kind;
  return null;
}

export interface OraclePlan {
  kind: OracleKind;
  /** Extra lines for the system prompt: seed data and, where the command asks
   *  for invention, the licence to invent. */
  knowledge: string[];
  /** The user turn that replaces the raw command phrase. */
  question: string;
}

export interface SagaEpisodeSeed {
  n: number;
  day: string;
  text: string;
}

export interface OracleInput {
  /** Real system facts to seed `reveal a detail` (e.g. describeSystemIntel). */
  dossier?: string | null;
  /** The thread `advance a threat` just escalated, null when nothing is elected. */
  thread?: SpineThread | null;
  /** Past saga episodes for `flashback`, oldest first. */
  episodes?: readonly SagaEpisodeSeed[];
  /** Caller-owned rotation counter, same idiom as every brief. */
  rotate?: number;
}

export function planOracle(kind: OracleKind, input: OracleInput = {}): OraclePlan {
  const rotate = input.rotate ?? 0;
  switch (kind) {
    case 'reveal': {
      const knowledge: string[] = [];
      if (input.dossier) knowledge.push(`THE ORACLE'S SEED — all of it true:\n${input.dossier}`);
      knowledge.push(
        `${UNIVERSE_REGISTER} For this one answer the commander has asked for the STORY under the ` +
          `facts: pick one seed fragment and reveal something hidden behind it — a detail the scans ` +
          `would not show. Invention is welcome here as long as it grows out of a real fragment.`,
      );
      return {
        kind,
        knowledge,
        question:
          'Reveal a detail — something out here the sensors never surfaced. What have you noticed?',
      };
    }
    case 'advance': {
      const t = input.thread;
      if (!t) {
        return {
          kind,
          knowledge: [],
          question:
            'Is anything circling us right now? If nothing out here is close enough to name, say that straight — in your own voice.',
        };
      }
      const beats = t.beats.slice(-2).map((b) => b.text);
      return {
        kind,
        knowledge: [
          `THE THREAT, AS IT STANDS: ${t.faction} — pressure now ${t.clock} of ${CLOCK_SEGMENTS}` +
            (beats.length ? `; lately: ${beats.join('; ')}` : ''),
        ],
        question: `The ${t.faction} situation just tightened a notch. How is it showing?`,
      };
    }
    case 'flashback': {
      const episodes = input.episodes ?? [];
      if (!episodes.length) {
        return {
          kind,
          knowledge: [],
          question:
            'I was trying to remember an earlier run and it will not come back. The log from those days is thin — what do you make of that?',
        };
      }
      const pick = rotateWindow(episodes, 1, rotate).shown[0];
      return {
        kind,
        knowledge: [
          `FROM THE CHRONICLE — episode ${pick.n}, ${pick.day}, as it was written:\n${pick.text}`,
        ],
        question:
          'Take me back to that one for a moment — how do you remember it, from where you sat?',
      };
    }
  }
}
