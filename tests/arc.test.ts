/** The session arc — chapters, turns, hysteresis, and the operator's mood.
 *  All computed: the model colours this, it never derives it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionArc } from '../src/engine/arc.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent =>
  ({ timestamp: '3312-01-01T00:00:00Z', ...o }) as unknown as JournalEvent;

const MIN = 60_000;

test('the session moves through chapters as the commander switches work', () => {
  const a = new SessionArc();
  let t = 0;

  // Mining opens the session — the first chapter is never announced as a turn.
  assert.equal(a.apply(ev({ event: 'MiningRefined', Type: 'Tritium' }), t), null);
  assert.equal(a.currentChapter(), 'mining');
  for (let i = 0; i < 4; i++) a.apply(ev({ event: 'MiningRefined', Type: 'Tritium' }), (t += MIN));

  // Exobiology takes over — a definitive act turns the chapter in one step,
  // and the turn line closes the old chapter with its real tally.
  const toExo = a.apply(ev({ event: 'ScanOrganic', ScanType: 'Sample' }), (t += MIN));
  assert.match(String(toExo), /^EVENT: Chapter turn — a mining shift, 4 t refined so far closes; the run moves to exobiology\.$/);
  assert.equal(a.currentChapter(), 'exobiology');
  a.apply(ev({ event: 'ScanOrganic', ScanType: 'Analyse' }), (t += MIN));

  // Passenger work: one completed cabin run is definitive.
  const toPax = a.apply(ev({ event: 'MissionCompleted', Name: 'Mission_PassengerVIP_name', Reward: 971_646 }), (t += MIN));
  assert.match(String(toPax), /an exobiology walk, 1 sample logged closes; the run moves to passenger runs/);

  // Bounty hunting needs TWO kills — one stray bounty is not a career change.
  assert.equal(a.apply(ev({ event: 'Bounty', TotalReward: 84_000 }), (t += MIN)), null);
  assert.equal(a.currentChapter(), 'passenger runs');
  const toBounty = a.apply(ev({ event: 'Bounty', TotalReward: 100_000 }), (t += MIN));
  assert.match(String(toBounty), /passenger work.*closes; the run moves to bounty hunting/);

  // Community-goal work: a RISING personal contribution is definitive.
  a.apply(ev({ event: 'CommunityGoal', CurrentGoals: [{ PlayerContribution: 400 }] }), (t += MIN));
  assert.equal(a.currentChapter(), 'bounty hunting'); // first sighting only sets the watermark
  const toCg = a.apply(ev({ event: 'CommunityGoal', CurrentGoals: [{ PlayerContribution: 800 }] }), (t += MIN));
  assert.match(String(toCg), /bounty hunting.*closes; the run moves to community-goal work/);
});

test('a stray observation is an interruption, not a chapter — and votes expire', () => {
  const a = new SessionArc();
  let t = 0;
  a.apply(ev({ event: 'MiningRefined' }), t);
  // One kill mid-shift: still mining.
  a.apply(ev({ event: 'Bounty', TotalReward: 10_000 }), (t += MIN));
  assert.equal(a.currentChapter(), 'mining');
  // A second kill — but 20 minutes later, outside the window: the old vote has
  // gone stale, so this still does not turn the chapter.
  a.apply(ev({ event: 'Bounty', TotalReward: 10_000 }), (t += 20 * MIN));
  assert.equal(a.currentChapter(), 'mining');
  // Two kills close together do.
  a.apply(ev({ event: 'Bounty', TotalReward: 10_000 }), (t += MIN));
  assert.equal(a.currentChapter(), 'bounty hunting');
});

test('the arc line tells the story with pre-rounded numbers', () => {
  const a = new SessionArc();
  assert.equal(a.arcLine(), null); // no shape yet — nothing to say
  let t = 0;
  for (let i = 0; i < 6; i++)
    a.apply(ev({ event: 'MissionCompleted', Name: 'Mission_Delivery', Reward: 971_646 }), (t += MIN));
  const line = a.arcLine()!;
  assert.match(line, /^ARC: the story so far — 6 contracts closed, ~5\.8M cr banked/);
  assert.match(line, /6 clean hand-ins without a miss — the streak is becoming a reputation/);
  assert.match(line, /Current chapter: the contract grind, 6 hand-ins this stretch\.$/);
  // Never a raw figure the model could garble.
  assert.doesNotMatch(line, /971,646|5,829/);
});

test('the mood is the session, ranked by what would actually weigh on a person', () => {
  const a = new SessionArc();
  let t = 0;
  assert.match(a.moodLine(t, 0.5), /unhurried, dry good humour/);
  // A long shift shows.
  assert.match(a.moodLine(t, 4.5), /deep-shift tired.*coffee long gone cold/);
  // A streak warms it — and outranks tiredness.
  for (let i = 0; i < 5; i++)
    a.apply(ev({ event: 'MissionCompleted', Name: 'Mission_Courier', Reward: 100_000 }), (t += MIN));
  assert.match(a.moodLine(t, 4.5), /quietly proud/);
  // Losses cut through everything except a death.
  a.apply(ev({ event: 'MissionFailed', Name: 'Mission_Courier' }), (t += MIN));
  a.apply(ev({ event: 'MissionAbandoned', Name: 'Mission_Courier' }), (t += MIN));
  assert.match(a.moodLine(t, 1), /clipped.*gone sideways/);
  // A death rules the mood for a while — and mining soothes nothing about it.
  a.apply(ev({ event: 'Died', KillerName: 'Kane Reid' }), (t += MIN));
  assert.match(a.moodLine(t + MIN, 1), /rattled but steady/);
  // ...but it fades.
  assert.match(a.moodLine(t + 30 * MIN, 1), /clipped|unhurried|settled/);
});

test('mining and the quiet sciences have their own idle moods', () => {
  const a = new SessionArc();
  a.apply(ev({ event: 'MiningRefined' }), 0);
  assert.match(a.moodLine(MIN, 1), /rhythm of the rocks/);
  const b = new SessionArc();
  b.apply(ev({ event: 'ScanOrganic', ScanType: 'Sample' }), 0);
  assert.match(b.moodLine(MIN, 1), /far-eyed/);
});

test('the analyse-only organic scans do not count as samples', () => {
  const a = new SessionArc();
  assert.equal(a.apply(ev({ event: 'ScanOrganic', ScanType: 'Log' }), 0), null);
  assert.equal(a.currentChapter(), null);
});
