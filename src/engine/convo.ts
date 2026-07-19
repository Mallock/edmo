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

const MAX_TURNS = 10;
const FRESH_MS = 15 * 60_000; // a lull longer than this starts a new thread
const MAX_ASSISTANT_CHARS = 300; // stories are long — recall the gist, not the prose

export class ConvoBuffer {
  turns: ConvoTurn[] = [];

  push(role: 'user' | 'assistant', content: string, at: number): void {
    const text = content.trim();
    if (!text) return;
    // Collapse consecutive assistant lines (operator said several things in a
    // row) into the newest one — the thread stays question/answer shaped.
    const last = this.turns.at(-1);
    if (role === 'assistant' && last?.role === 'assistant') {
      last.content = text;
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
  recent(nowMs: number, max = 6): ChatMessage[] {
    return this.turns
      .filter((t) => nowMs - t.at < FRESH_MS)
      .slice(-max)
      .map((t) => ({
        role: t.role,
        content:
          t.role === 'assistant' && t.content.length > MAX_ASSISTANT_CHARS
            ? `${t.content.slice(0, MAX_ASSISTANT_CHARS)}…`
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
