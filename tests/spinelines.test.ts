/**
 * The spine, rendered — three voices, one boundary.
 *
 * These pin the register split that keeps the campaign from poisoning the
 * grounded operator: comms and news may carry the full picture, the operator
 * gets real substrate plus chatter that is ALWAYS attributed, every voice is
 * capped, and every line is data — no imperatives for a small model to
 * fixate on. The payoff integration runs against a real tracker: rendered
 * while pending, gone once consumed, dead once expired.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spineLines, SPINE_LINES_MAX } from '../src/engine/spine.ts';
import { CampaignTracker } from '../src/engine/campaign.ts';
import type { CampaignView, SpineThread } from '../src/engine/campaign.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const T0 = Date.parse('2026-08-01T12:00:00Z');
const HOUR = 3_600_000;
const iso = (offset: number): string => new Date(T0 + offset).toISOString();

const thread = (role: 'pursuer' | 'patron', faction: string, over: Partial<SpineThread> = {}): SpineThread => ({
  role,
  faction,
  clock: 3,
  clockMovedAt: iso(0),
  cooldownUntil: '',
  beats: [
    { at: iso(0), text: 'interdicted by Kowalczyk — submitted' },
    { at: iso(HOUR), text: 'entered LHS 20 — their turf' },
  ],
  onAir: [{ at: iso(HOUR), text: 'The ghost fleet pays double for silence' }],
  electedAt: iso(0),
  ...over,
});

const fullView = (): CampaignView => ({
  pursuer: thread('pursuer', 'Sirius Corp'),
  patron: thread('patron', 'Lyakhov Horizons', { clock: 1 }),
  vow: 'See the Sirius Corp work through — 3 contracts still open',
  payoffs: {
    comms: { role: 'pursuer', faction: 'Sirius Corp', cause: 'a third interdiction', expiresAt: iso(24 * HOUR) },
  },
});

const emptyView = (): CampaignView => ({ pursuer: null, patron: null, vow: null, payoffs: {} });

const VOICES = ['operator', 'news', 'comms'] as const;

test('an empty campaign renders no lines for any voice', () => {
  for (const voice of VOICES) {
    assert.deepEqual(spineLines(emptyView(), voice), []);
  }
});

test('every voice stays within the line cap', () => {
  for (const voice of VOICES) {
    assert.ok(spineLines(fullView(), voice, 0).length <= SPINE_LINES_MAX);
    assert.ok(spineLines(fullView(), voice, 1).length <= SPINE_LINES_MAX);
  }
});

test('the operator carries fiction only with on-air attribution', () => {
  const lines = spineLines(fullView(), 'operator');
  for (const line of lines) {
    if (line.includes('ghost fleet')) {
      assert.match(line, /^heard on comms:/);
    }
  }
  // And the substrate is there unattributed, because it is true.
  assert.ok(lines.some((l) => l.includes('interdicted by Kowalczyk')));
});

test('news receives the lane chatter as material', () => {
  const lines = spineLines(fullView(), 'news');
  assert.ok(lines.some((l) => l.startsWith('heard on comms:')));
  assert.ok(lines.some((l) => l.includes('Sirius Corp')));
});

test('every line is data — no imperatives for the model to fixate on', () => {
  const forbidden = /\b(you must|do not|don't|never|always|write|respond|reply|output|include|mention)\b/i;
  for (const voice of VOICES) {
    for (const line of spineLines(fullView(), voice)) {
      assert.ok(!forbidden.test(line), `${voice} line reads as an instruction: "${line}"`);
    }
  }
});

test('a payoff renders only for the voice that holds it', () => {
  const v = fullView();
  assert.ok(spineLines(v, 'comms').some((l) => l.startsWith('TURNING POINT')));
  assert.ok(!spineLines(v, 'news').some((l) => l.startsWith('TURNING POINT')));
  assert.ok(!spineLines(v, 'operator').some((l) => l.startsWith('TURNING POINT')));
});

test('the rotation alternates which thread leads', () => {
  const v = fullView();
  const first = (rotate: number) =>
    spineLines(v, 'comms', rotate).find((l) => l.startsWith('ONGOING')) ?? '';
  assert.match(first(0), /Sirius Corp/);
  assert.match(first(1), /Lyakhov Horizons/);
});

// ------------------------------------------------- payoff lifecycle, end to end

const interdicted = (offset: number): JournalEvent =>
  ({
    timestamp: iso(offset),
    event: 'Interdicted',
    Faction: 'Sirius Corp',
    Interdictor: 'Kowalczyk',
    Submitted: true,
  }) as unknown as JournalEvent;

const hostile = { factions: [{ name: 'Sirius Corp', influence: 0.3, reputation: -50 }] };

test('a filled clock renders once per voice and clears on consume', () => {
  const c = new CampaignTracker();
  for (const h of [0, 1, 2, 3]) c.observe(interdicted(h * HOUR), hostile);
  for (const voice of VOICES) {
    assert.ok(spineLines(c.view(), voice).some((l) => l.startsWith('TURNING POINT')), voice);
  }
  c.consumePayoff('comms');
  assert.ok(!spineLines(c.view(), 'comms').some((l) => l.startsWith('TURNING POINT')));
  assert.ok(spineLines(c.view(), 'news').some((l) => l.startsWith('TURNING POINT')));
});

test('a payoff prompt never contradicts itself about the pressure', () => {
  // The scenario sim caught "comes to a head" and "the pressure has eased for
  // now" riding the same prompt: the clock resets to 0 at fill, and zero used
  // to read as calm. While the payoff line is present the thread line carries
  // no clock phrase; once consumed, a cooling thread reads as settling dust.
  const c = new CampaignTracker();
  for (const h of [0, 1, 2, 3]) c.observe(interdicted(h * HOUR), hostile);
  const atPeak = spineLines(c.view(), 'comms');
  assert.ok(atPeak.some((l) => l.startsWith('TURNING POINT')));
  assert.ok(!atPeak.some((l) => /eased/.test(l)), atPeak.join('\n'));
  c.consumePayoff('comms');
  const after = spineLines(c.view(), 'comms');
  assert.ok(after.some((l) => /dust is still settling/.test(l)));
  assert.ok(!after.some((l) => /eased/.test(l)));
});

test('an unconsumed payoff dies with the cooldown', () => {
  const c = new CampaignTracker();
  for (const h of [0, 1, 2, 3]) c.observe(interdicted(h * HOUR), hostile);
  c.sweep(T0 + 3 * HOUR + 25 * HOUR);
  for (const voice of VOICES) {
    assert.ok(!spineLines(c.view(), voice).some((l) => l.startsWith('TURNING POINT')), voice);
  }
});
