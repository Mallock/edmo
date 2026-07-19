import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readJournalFile } from '../src/engine/journal.ts';
import { runReplay } from '../src/engine/replay.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', 'fixtures', 'journal', 'session-couriers-assassinate.log');

test('replay of a real journal session drives missions + proactive nudges end-to-end', () => {
  const events = readJournalFile(FIXTURE);
  assert.ok(events.length > 500, 'fixture parsed');

  const { entries, state } = runReplay(events);

  // The session should have produced operator output of several kinds.
  const kinds = new Set(entries.map((e) => e.kind));
  assert.ok(kinds.has('briefing'), 'mission briefings emitted');
  assert.ok(kinds.has('complete'), 'completion notices emitted');
  assert.ok(kinds.has('redirect'), 'a redirect notice emitted (assassinate hand-in change)');
  assert.ok(kinds.has('nudge'), 'proactive heartbeat nudges emitted');

  // --- The real Assassinate_RankFed mission (id 1021635238): accept -> redirect -> complete.
  const kill = state.allMissions().find((m) => m.id === 1021635238);
  assert.ok(kill, 'assassinate mission present');
  assert.equal(kill!.category, 'Assassinate');
  assert.equal(kill!.state, 'COMPLETE');
  assert.equal(kill!.redirected, true);
  assert.equal(kill!.destination?.station, 'Malchiodi City'); // redirected hand-in

  // --- Heartbeat: idle at Caro Depot (~19 min) with 4 hand-ins waiting at The Forge Of Vulcan.
  const idleDocked = entries.filter((e) => e.rule === 'idle-docked');
  assert.ok(idleDocked.length >= 1, 'idle-docked nudge fired during the Caro Depot stall');
  assert.ok(
    idleDocked.some((e) => /Caro Depot/.test(e.text) && /Forge Of Vulcan/.test(e.text)),
    'idle-docked nudge names the station and the pending hand-in destination',
  );

  // --- Heartbeat: stuck hunting the assassination target in Bingui before the kill.
  const hunting = entries.filter((e) => e.rule === 'stuck-hunting');
  assert.ok(hunting.length >= 1, 'stuck-hunting nudge fired while idling in the target system');

  // --- Arrival hand-in reminders happened at least once.
  assert.ok(entries.some((e) => e.kind === 'arrival'), 'arrival hand-in reminder emitted');

  // Every completed mission has all steps done (sanity on step synthesis).
  for (const m of state.allMissions()) {
    if (m.state === 'COMPLETE') assert.ok(m.steps.every((s) => s.done), `${m.title} steps all done`);
  }
});
