/**
 * Journal text parsing — browser-safe (no node:fs), shared by the Node CLI
 * and the Tauri HUD frontend. See SPEC.md §3.1.1.
 */
import type { JournalEvent } from './types.ts';

/** Parse a block of JSON-lines text into events, skipping blank/corrupt lines. */
export function parseJournalLines(text: string): JournalEvent[] {
  const out: JournalEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as JournalEvent;
      if (obj && typeof obj.event === 'string') out.push(obj);
    } catch {
      // Ignore a partial trailing line (the game may be mid-write) or garbage.
    }
  }
  return out;
}

/** Parse a single journal line; null for blank/corrupt/partial lines. */
export function parseJournalLine(line: string): JournalEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as JournalEvent;
    return obj && typeof obj.event === 'string' ? obj : null;
  } catch {
    return null;
  }
}
