/**
 * Showing the same facts differently.
 *
 * Every capped list in every brief used to take the first N for ever, so a
 * system produced byte-identical input on every call — the one condition under
 * which temperature buys nothing, as `SceneRequest.situation` already records.
 * These pin the two things that matter: the window MOVES, and it never invents,
 * drops or duplicates a fact while moving.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rotateWindow, rotateAll } from '../src/engine/rotate.ts';
import { buildDossier } from '../src/engine/chatter/dossier.ts';
import type { SystemIntel } from '../src/engine/types.ts';

const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];

test('the window moves with the counter', () => {
  assert.deepEqual(rotateWindow(LETTERS, 3, 0).shown, ['a', 'b', 'c']);
  assert.deepEqual(rotateWindow(LETTERS, 3, 1).shown, ['b', 'c', 'd']);
  assert.deepEqual(rotateWindow(LETTERS, 3, 4).shown, ['e', 'f', 'a']);
});

test('the window wraps rather than running off the end', () => {
  assert.deepEqual(rotateWindow(LETTERS, 3, 6).shown, ['a', 'b', 'c']);
  assert.deepEqual(rotateWindow(LETTERS, 3, 13).shown, ['b', 'c', 'd']);
  // A decreasing counter must not produce a negative index.
  assert.deepEqual(rotateWindow(LETTERS, 3, -1).shown, ['f', 'a', 'b']);
});

test('everything gets its turn over enough calls', () => {
  // The point of rotating rather than slicing: with six facts and a cap of
  // three, the old code showed three of them and hid the rest permanently.
  const seen = new Set<string>();
  for (let i = 0; i < LETTERS.length; i++) {
    for (const x of rotateWindow(LETTERS, 3, i).shown) seen.add(x);
  }
  assert.deepEqual([...seen].sort(), LETTERS);
});

test('a list that fits is never reordered', () => {
  // Short lists have no repetition problem to solve, and shuffling them would
  // lose the ordering the caller chose — factions are sorted by influence.
  for (const r of [0, 1, 5]) {
    assert.deepEqual(rotateWindow(LETTERS, 6, r).shown, LETTERS);
    assert.deepEqual(rotateWindow(LETTERS, 99, r).shown, LETTERS);
  }
});

test('the count of hidden items stays honest', () => {
  assert.equal(rotateWindow(LETTERS, 3, 0).more, 3);
  assert.equal(rotateWindow(LETTERS, 3, 4).more, 3);
  assert.equal(rotateWindow(LETTERS, 6, 0).more, 0);
});

test('a window never duplicates or invents a fact', () => {
  for (let r = 0; r < 12; r++) {
    const { shown } = rotateWindow(LETTERS, 4, r);
    assert.equal(new Set(shown).size, shown.length, `duplicate at ${r}`);
    for (const x of shown) assert.ok(LETTERS.includes(x), `invented ${x}`);
  }
});

test('empty and degenerate inputs are survivable', () => {
  assert.deepEqual(rotateWindow([], 3, 2), { shown: [], more: 0 });
  assert.deepEqual(rotateWindow(LETTERS, 0, 2), { shown: [], more: 6 });
  assert.deepEqual(rotateAll([], 3), []);
  assert.deepEqual(rotateAll(['only'], 5), ['only']);
});

// ---------------------------------------------------------------------------
// The dossier, which is where this actually matters
// ---------------------------------------------------------------------------

const CROWDED: SystemIntel = {
  security: 'Low Security',
  controllingFaction: 'Explorer on Tour',
  factions: [
    { name: 'Explorer on Tour', influence: 0.4 },
    { name: 'Alpha Combine', influence: 0.2 },
    { name: 'Beta Union', influence: 0.15 },
    { name: 'Gamma Holdings', influence: 0.1 },
    { name: 'Delta Trust', influence: 0.08 },
    { name: 'Epsilon Group', influence: 0.07 },
  ],
  signals: [
    { name: 'Alpha Station', isStation: true },
    { name: 'Beta Dock', isStation: true },
    { name: 'Gamma Port', isStation: true },
    { name: 'Delta Hub', isStation: true },
    { name: 'Epsilon Ring', isStation: true },
    { name: 'Zeta Landing', isStation: true },
    { name: 'Eta Outpost', isStation: true },
  ],
};

const dossier = (rotate: number): string =>
  buildDossier({ system: 'Crowded', intel: CROWDED, docked: false, rotate });

test('two dossiers for one system are not identical', () => {
  // The bug in one line. Same system, same facts, same everything — and the
  // writer saw the same bytes on every call for as long as it stayed there.
  assert.notEqual(dossier(0), dossier(1));
});

test('rotation changes which facts are shown, never whether they are true', () => {
  const names = CROWDED.factions!.map((f) => f.name).concat(
    CROWDED.signals.map((s) => s.name),
  );
  // Only the rotated LIST lines — the header carries prose, not names.
  for (let r = 0; r < 8; r++) {
    for (const line of dossier(r).split('\n')) {
      if (!/^(Also here|Stations|Signals detected):/.test(line)) continue;
      for (const part of line.replace(/^[^:]*:\s*/, '').split(' · ')) {
        const bare = part
          .replace(/\s*\([^)]*\)\s*/g, '')
          .replace(/\(\+\d+ more\)/, '')
          .trim();
        if (!bare) continue;
        assert.ok(names.includes(bare), `dossier ${r} printed unknown "${bare}"`);
      }
    }
  }
});

test('the controlling faction never rotates away', () => {
  // Who runs the place is a standing fact, not one of a list — it must be in
  // front of the writer every time, or half the scenes lose their politics.
  for (let r = 0; r < 8; r++) {
    assert.match(dossier(r), /Runs this system: Explorer on Tour/, `rotation ${r}`);
  }
});

test('every station is eventually mentioned', () => {
  const seen = new Set<string>();
  for (let r = 0; r < 14; r++) {
    const line = dossier(r).split('\n').find((l) => l.startsWith('Stations:')) ?? '';
    for (const s of CROWDED.signals) if (line.includes(s.name)) seen.add(s.name);
  }
  assert.equal(seen.size, CROWDED.signals.length, 'a station the writer never sees');
});
