/**
 * Channels: what can open, when, and how loudly the galaxy talks.
 *
 * The assertions that matter most here are the negative ones. A channel that
 * invents a port, or a cadence that keeps chatting through a hull breach, is
 * the failure mode that makes people uninstall the feature — so "stays shut"
 * is tested harder than "opens".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  MIN_AUDIBLE_STRENGTH,
  STATION_FULL_LS,
  STATION_RANGE_LS,
  chatterBaseGapMs,
  chatterGapMs,
  degradeFor,
  dueToTransmit,
  evaluateAll,
  evaluateChannel,
  selectChannel,
  signalStrength,
  type ChannelContext,
} from '../src/engine/chatter/channels.ts';
import { CHANNEL_IDS, CLOSED_REASON_LABEL, type ChannelId } from '../src/engine/chatter/types.ts';
import { copilotDensityGapMs } from '../src/engine/copilot.ts';

const NOW = 1_700_000_000_000;

function ctx(over: Partial<ChannelContext> = {}): ChannelContext {
  return {
    nowMs: NOW,
    act: 'QUIET',
    density: 'normal',
    pressure: 0,
    onFoot: false,
    resolvedPorts: 2,
    portSeparationLs: 50,
    carrierPresent: false,
    population: 1_000_000,
    hasCrew: true,
    lastTransmitAt: {},
    mutedChannels: new Set<ChannelId>(),
    emergencyBriefReady: false,
    ...over,
  };
}

const reasonOf = (id: ChannelId, c: ChannelContext): string => {
  const s = evaluateChannel(id, c);
  return s.open ? 'OPEN' : s.reason;
};

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

test('signal strength is full up close and zero beyond range', () => {
  assert.equal(signalStrength(0), 1);
  assert.equal(signalStrength(STATION_FULL_LS), 1);
  assert.equal(signalStrength(STATION_RANGE_LS), 0);
  assert.equal(signalStrength(STATION_RANGE_LS * 10), 0);
});

test('signal strength increases monotonically as the ship closes', () => {
  // The approach: far to near. Every step must be at least as strong.
  const seps = [1900, 1500, 1000, 600, 300, 150, 80, 40, 20, 5];
  let prev = -1;
  for (const sep of seps) {
    const s = signalStrength(sep);
    assert.ok(s >= prev, `strength fell going from further out to ${sep} ls`);
    prev = s;
  }
  assert.equal(prev, 1);
});

test('unknown separation is not treated as close', () => {
  assert.equal(signalStrength(null), 0);
  assert.equal(signalStrength(Number.NaN), 0);
});

test('degrade is the inverse of strength', () => {
  assert.equal(degradeFor(1), 0);
  assert.equal(degradeFor(0), 1);
  assert.ok(Math.abs(degradeFor(0.25) - 0.75) < 1e-9);
});

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

test('station opens in range and states a reason when it does not', () => {
  const open = evaluateChannel('STATION', ctx({ portSeparationLs: 30 }));
  assert.ok(open.open);

  // Plenty of real ports sit 100,000+ ls out and a commander certainly hears
  // their traffic, so the hard cutoff only bites past the range constant.
  assert.equal(reasonOf('STATION', ctx({ portSeparationLs: 50_000 })), 'OPEN');
  assert.equal(
    reasonOf('STATION', ctx({ portSeparationLs: STATION_RANGE_LS + 1 })),
    'out-of-range',
  );
  assert.equal(reasonOf('STATION', ctx({ resolvedPorts: 0 })), 'no-ports-in-system');
});

test('a far station is audible but degraded, not silent', () => {
  const near = evaluateChannel('STATION', ctx({ portSeparationLs: 100 }));
  const far = evaluateChannel('STATION', ctx({ portSeparationLs: 80_000 }));
  assert.ok(near.open && far.open);
  assert.ok(
    near.open && far.open && far.degrade > near.degrade,
    'distance should cost signal quality rather than the channel itself',
  );
});

test('a port the orrery cannot place is never invented', () => {
  // resolvedPorts is the count the orrery RESOLVED, not the count that exists.
  const s = evaluateChannel('STATION', ctx({ resolvedPorts: 0, portSeparationLs: 5 }));
  assert.equal(s.open, false);
  assert.equal(s.open === false && s.reason, 'no-ports-in-system');
});

test('carrier channel requires a carrier', () => {
  assert.equal(reasonOf('CARRIER', ctx({ carrierPresent: false })), 'no-carrier');
  assert.equal(reasonOf('CARRIER', ctx({ carrierPresent: true })), 'OPEN');
});

test('concourse requires being on foot', () => {
  assert.equal(reasonOf('CONCOURSE', ctx({ onFoot: false })), 'not-on-foot');
  assert.equal(reasonOf('CONCOURSE', ctx({ onFoot: true })), 'OPEN');
});

test('crew requires a crew', () => {
  assert.equal(reasonOf('CREW', ctx({ hasCrew: false })), 'no-crew');
});

test('local stays shut in an uninhabited system', () => {
  assert.equal(reasonOf('LOCAL', ctx({ population: 0 })), 'unpopulated');
});

test('deep space is absence, not distance', () => {
  // A busy system a long way out is NOT deep space.
  assert.equal(
    reasonOf('DEEP', ctx({ resolvedPorts: 3, portSeparationLs: 40 })),
    'others-in-range',
  );
  // An empty system is, wherever it is.
  assert.equal(
    reasonOf('DEEP', ctx({ resolvedPorts: 0, portSeparationLs: null, carrierPresent: false })),
    'OPEN',
  );
  // A carrier counts as somebody to talk to.
  assert.equal(
    reasonOf('DEEP', ctx({ resolvedPorts: 0, portSeparationLs: null, carrierPresent: true })),
    'others-in-range',
  );
});

test('a channel that just transmitted is holding', () => {
  const c = ctx({ lastTransmitAt: { STATION: NOW - 1_000 } });
  assert.equal(reasonOf('STATION', c), 'too-soon');

  const later = ctx({
    nowMs: NOW + CHANNELS.STATION.minIntervalMs + 1,
    lastTransmitAt: { STATION: NOW },
  });
  assert.equal(reasonOf('STATION', later), 'OPEN');
});

test('a muted channel reports being squelched, not something else', () => {
  const c = ctx({ mutedChannels: new Set<ChannelId>(['STATION']) });
  assert.equal(reasonOf('STATION', c), 'muted');
});

test('every closed reason has a label for the panel', () => {
  for (const id of CHANNEL_IDS) {
    const s = evaluateChannel(id, ctx({ resolvedPorts: 0, hasCrew: false, population: 0 }));
    if (!s.open) assert.ok(CLOSED_REASON_LABEL[s.reason], `no label for ${s.reason}`);
  }
});

// ---------------------------------------------------------------------------
// Acts
// ---------------------------------------------------------------------------

test('CRISIS closes every ambient channel', () => {
  const c = ctx({ act: 'CRISIS', onFoot: true, carrierPresent: true });
  for (const id of CHANNEL_IDS) {
    if (id === 'EMERGENCY') continue;
    const s = evaluateChannel(id, c);
    assert.equal(s.open, false, `${id} must be silent in CRISIS`);
    assert.equal(s.open === false && s.reason, 'act-suppressed');
  }
});

test('emergency may cut through CRISIS, but only with a verified brief', () => {
  assert.equal(
    reasonOf('EMERGENCY', ctx({ act: 'CRISIS', emergencyBriefReady: false })),
    'no-verified-brief',
  );
  assert.equal(
    reasonOf('EMERGENCY', ctx({ act: 'CRISIS', emergencyBriefReady: true })),
    'OPEN',
  );
});

test('selectChannel returns nothing in CRISIS without an emergency brief', () => {
  const c = ctx({ act: 'CRISIS', onFoot: true, carrierPresent: true });
  assert.equal(selectChannel(c, () => 0.5), null);
});

test('selectChannel returns only EMERGENCY in CRISIS when one is ready', () => {
  const c = ctx({ act: 'CRISIS', emergencyBriefReady: true, onFoot: true, carrierPresent: true });
  const picked = selectChannel(c, () => 0.5);
  assert.equal(picked?.id, 'EMERGENCY');
});

test('emergency does not transmit during QUIET', () => {
  assert.equal(
    reasonOf('EMERGENCY', ctx({ act: 'QUIET', emergencyBriefReady: true })),
    'act-suppressed',
  );
});

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

test('chatter thins as pressure rises — the opposite of the copilot', () => {
  const calm = chatterGapMs('normal', 0);
  const tense = chatterGapMs('normal', 1);
  assert.ok(tense > calm, 'the world should go quieter when things get serious');

  // And it really is the inverse relationship, not merely a different curve.
  assert.ok(copilotDensityGapMs('medium', 1) < copilotDensityGapMs('medium', 0));
});

test('chatter cadence is monotonic in pressure', () => {
  let prev = 0;
  for (const p of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    const gap = chatterGapMs('normal', p);
    assert.ok(gap >= prev, `gap shrank going from lower pressure to ${p}`);
    prev = gap;
  }
});

test('a chattier involvement setting talks more often', () => {
  assert.ok(chatterBaseGapMs('bustling') < chatterBaseGapMs('normal'));
  assert.ok(chatterBaseGapMs('normal') < chatterBaseGapMs('sparse'));
});

test('pressure outside 0..1 is clamped rather than inverting the curve', () => {
  assert.equal(chatterGapMs('normal', -5), chatterGapMs('normal', 0));
  assert.equal(chatterGapMs('normal', 5), chatterGapMs('normal', 1));
});

test('dueToTransmit waits out the gap', () => {
  const base = { nowMs: NOW, density: 'normal' as const, pressure: 0 };
  assert.equal(dueToTransmit(null, base), true, 'first transmission is always due');
  assert.equal(dueToTransmit(NOW - 1_000, base), false);
  assert.equal(
    dueToTransmit(NOW - chatterGapMs('normal', 0) - 1, base),
    true,
  );
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

test('selectChannel only ever returns an open channel', () => {
  const c = ctx({ onFoot: true, carrierPresent: true });
  for (let i = 0; i < 200; i++) {
    const picked = selectChannel(c, () => i / 200);
    if (picked) assert.ok(evaluateChannel(picked.id, c).open, `${picked.id} was not open`);
  }
});

test('selectChannel spreads across the eligible channels', () => {
  const c = ctx({ onFoot: true, carrierPresent: true });
  const seen = new Set<ChannelId>();
  for (let i = 0; i < 400; i++) {
    const picked = selectChannel(c, () => (i * 0.0025) % 1);
    if (picked) seen.add(picked.id);
  }
  assert.ok(seen.size >= 3, `expected several channels to be reachable, got ${[...seen]}`);
});

test('deep space is the floor — the galaxy is never entirely unreachable', () => {
  // Strip everything away: no ports, no carrier, no crew, nobody home. DEEP is
  // designed to be what is left, so this must NOT come back empty. Silence in
  // that situation should come from the cadence and the act, not from having
  // no channel at all.
  const c = ctx({
    resolvedPorts: 0,
    portSeparationLs: null,
    carrierPresent: false,
    population: 0,
    hasCrew: false,
    onFoot: false,
  });
  assert.equal(selectChannel(c, () => 0.5)?.id, 'DEEP');
});

test('selectChannel returns null when every channel is squelched', () => {
  const c = ctx({
    onFoot: true,
    carrierPresent: true,
    mutedChannels: new Set<ChannelId>(CHANNEL_IDS),
  });
  assert.equal(selectChannel(c, () => 0.5), null);
  for (const s of evaluateAll(c)) {
    assert.equal(s.open, false);
    assert.equal(s.open === false && s.reason, 'muted');
  }
});

test('evaluateAll reports on every channel', () => {
  const states = evaluateAll(ctx());
  assert.equal(states.length, CHANNEL_IDS.length);
  assert.deepEqual(
    states.map((s) => s.id).sort(),
    [...CHANNEL_IDS].sort(),
  );
});

// ---------------------------------------------------------------------------
// Density: the fix for "comms are very quiet"
// ---------------------------------------------------------------------------

test('density is its own knob, and busier settings really are busier', () => {
  // The first cut drove this from the copilot's involvement setting, which
  // meant a quiet copilot forced a quiet galaxy and the default landed near
  // one transmission every hundred seconds.
  assert.ok(chatterBaseGapMs('bustling') < chatterBaseGapMs('busy'));
  assert.ok(chatterBaseGapMs('busy') < chatterBaseGapMs('normal'));
  assert.ok(chatterBaseGapMs('normal') < chatterBaseGapMs('sparse'));
});

test('the default density can actually fill a system with traffic', () => {
  // A populated system should sound populated: at least one transmission a
  // minute is reachable at 'busy', which is the shipped default.
  assert.ok(chatterGapMs('busy', 0) <= 30_000, 'busy should allow ~2/minute when calm');
});

test('pressure thins the channel without killing it', () => {
  // The old curve stretched to 3x the base gap, which on a slow base meant the
  // channel died long before CRISIS actually silenced it. CRISIS stops the
  // chatter; pressure only thins it.
  const calm = chatterGapMs('busy', 0);
  const tense = chatterGapMs('busy', 1);
  assert.ok(tense > calm, 'still quieter under pressure');
  assert.ok(tense <= calm * 3, `pressure must not silence the channel outright (${calm} -> ${tense})`);
});

test('every channel can still get a word in at the default density', () => {
  // A per-channel minimum longer than an hour would make that channel
  // unreachable in practice however open it is.
  for (const id of CHANNEL_IDS) {
    assert.ok(
      CHANNELS[id].minIntervalMs < 3_600_000,
      `${id} min interval exceeds an hour`,
    );
  }
});
