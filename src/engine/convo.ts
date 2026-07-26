/**
 * ConvoBuffer — short-term dialogue memory for the operator.
 *
 * Everything the operator SAYS (answers, stories, memory remarks, warnings)
 * and everything the commander ASKS lands here, so a follow-up like "and how
 * far is that?" or "what did you mean?" resolves against the actual thread —
 * the Jarvis property. Long-term facts live in CommanderMemory; this buffer
 * is deliberately small and forgetful (a conversation, not a transcript).
 */
import type { ChatMessage } from './lmstudio.ts';

export interface ConvoTurn {
  role: 'user' | 'assistant';
  content: string;
  at: number; // ms epoch
}

const MAX_TURNS = 16;
const FRESH_MS = 15 * 60_000; // a lull longer than this starts a new thread
const MAX_ASSISTANT_CHARS = 300; // stories are long — recall the gist, not the prose
/** A burst of operator lines between questions is kept, but bounded. */
const MAX_MERGED_CHARS = 600;

export class ConvoBuffer {
  turns: ConvoTurn[] = [];

  push(role: 'user' | 'assistant', content: string, at: number): void {
    const text = content.trim();
    if (!text) return;
    // Merge consecutive assistant lines so the thread stays question/answer
    // shaped for the chat API. They are JOINED, not replaced: in live play the
    // operator says many things between questions (hazard calls, mission
    // notices, copilot beats), and overwriting meant a follow-up like "what?"
    // could only ever see the very last one.
    const last = this.turns.at(-1);
    if (role === 'assistant' && last?.role === 'assistant') {
      const merged = `${last.content} ${text}`.trim();
      last.content = merged.length > MAX_MERGED_CHARS ? merged.slice(-MAX_MERGED_CHARS) : merged;
      last.at = at;
      return;
    }
    this.turns.push({ role, content: text, at });
    if (this.turns.length > MAX_TURNS) this.turns = this.turns.slice(-MAX_TURNS);
  }

  /**
   * The recent thread as chat messages, oldest first, ready to splice between
   * the system prompt and the new user message. Stale turns are dropped;
   * assistant turns are trimmed to their gist.
   */
  recent(nowMs: number, max = 10): ChatMessage[] {
    return this.turns
      .filter((t) => nowMs - t.at < FRESH_MS)
      .slice(-max)
      .map((t) => ({
        role: t.role,
        content:
          t.role === 'assistant' && t.content.length > MAX_ASSISTANT_CHARS
            ? // Keep the END: merged assistant turns run oldest→newest, and a
              // follow-up ("what?", "how far?") refers to the LAST thing said.
              `…${t.content.slice(-MAX_ASSISTANT_CHARS)}`
            : t.content,
      }));
  }

  clear(): void {
    this.turns = [];
  }
}

/** Strip whisper.cpp non-speech annotations ("[BLANK_AUDIO]", "(wind)"…). */
export function cleanTranscript(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cap on one retained tool result — enough for a market list, not a dump. */
const MAX_TOOL_RESULT_CHARS = 1200;

/**
 * Pull the tool calls and their results out of a finished agentic run, so the
 * next question can be a follow-up about the figures.
 *
 * Only the assistant turns that CALLED tools and the results themselves are
 * kept — the intermediate prose is noise once the final answer exists. Results
 * are truncated: a follow-up needs the numbers, not every row.
 */
export function toolExchangeOf(messages: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ ...m, content: m.content.slice(0, MAX_TOOL_RESULT_CHARS) });
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push(m);
    }
  }
  return out;
}
