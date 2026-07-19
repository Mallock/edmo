/**
 * Journal file I/O and parsing.
 *
 * Elite Dangerous writes Journal.*.log as JSON-lines (one JSON object per line)
 * and rewrites snapshot files (Missions.json, Status.json, ...) wholesale.
 * See SPEC.md §3.1.1.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { JournalEvent } from './types.ts';
import { parseJournalLines } from './parse.ts';

export { parseJournalLines } from './parse.ts';

/** Default Elite Dangerous journal directory on Windows. */
export function defaultJournalDir(): string {
  return join(
    homedir(),
    'Saved Games',
    'Frontier Developments',
    'Elite Dangerous',
  );
}

export function readJournalFile(path: string): JournalEvent[] {
  return parseJournalLines(readFileSync(path, 'utf8'));
}

/** List Journal.*.log files in a directory, sorted oldest -> newest by name. */
export function listJournals(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^Journal\..*\.log$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** The newest (most recent session) journal, or null if none. */
export function newestJournal(dir: string): string | null {
  const all = listJournals(dir);
  return all.length ? all[all.length - 1] : null;
}
