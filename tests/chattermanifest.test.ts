/**
 * Manifest and contract briefs — the commander's own business, overheard.
 *
 * The hard rule under test throughout: both builders speak only about work
 * already accepted, never about a station's board (the journal has no event
 * for unaccepted offers), and the contract brief carries no reward, steps or
 * progress — that register belongs to the private Operator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contractBrief,
  contractRelevance,
  manifestBrief,
  timeLeftPhrase,
} from '../src/engine/chatter/briefs.ts';
import type { Mission, PassengerManifestEntry } from '../src/engine/types.ts';

const NOW = Date.parse('2026-08-30T12:00:00Z');

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 1063978657,
    internalName: 'Mission_PassengerBulk',
    title: '80 Tourists Seeking Transport',
    category: 'PassengerBulk',
    faction: 'Explorer on Tour',
    origin: { system: 'HIP 71462', station: 'Foerster Orbital' },
    destination: { system: 'HIP 71120', station: "Wood's Pride" },
    reward: 1_837_840,
    wing: false,
    expiry: '2026-08-31T12:00:00Z',
    acceptedAt: '2026-08-30T10:00:00Z',
    passengers: { count: 80, type: 'Tourist', vip: false, wanted: false },
    steps: [],
    state: 'ACTIVE',
    redirected: false,
    killProgress: 0,
    raw: { timestamp: '2026-08-30T10:00:00Z', event: 'MissionAccepted' },
    ...over,
  };
}

const away = { location: { system: 'Ratraii' }, docked: false };
const atDest = { location: { system: 'HIP 71120', station: "Wood's Pride" }, docked: true };

// ---------------------------------------------------------------------------
// manifestBrief
// ---------------------------------------------------------------------------

test('passengers aboard produce a manifest brief with count and type', () => {
  const b = manifestBrief([mission()])!;
  assert.equal(b.kind, 'manifest');
  assert.equal(b.tokens.paxcount, '80');
  assert.equal(b.tokens.paxtype, 'Tourist');
  assert.equal(b.tokens.paxtypes, 'Tourists');
  assert.deepEqual(b.figures.map((f) => f.value), ['80']);
  assert.equal(b.subjectKey, 'manifest:1063978657');
});

test('an empty ship produces no manifest brief', () => {
  assert.equal(manifestBrief([]), null);
  // A mission with neither passengers nor cargo in the hold is not a load.
  assert.equal(manifestBrief([mission({ passengers: undefined })]), null);
});

test('VIP and WANTED are presence-gated tokens', () => {
  const plain = manifestBrief([mission()])!;
  assert.equal(plain.tokens.paxvip, undefined);
  assert.equal(plain.tokens.paxwanted, undefined);

  const hot = manifestBrief([
    mission({ passengers: { count: 4, type: 'Refugee', vip: true, wanted: true } }),
  ])!;
  assert.equal(hot.tokens.paxvip, 'VIP');
  assert.equal(hot.tokens.paxwanted, 'wanted');
  assert.match(hot.summary, /WANTED/);
});

test('no passenger is ever named — nouns are faction and geography only', () => {
  const b = manifestBrief([
    mission({ passengers: { count: 1, type: 'CEO', vip: true, wanted: false } }),
  ])!;
  const allowed = new Set(['Explorer on Tour', "Wood's Pride", 'HIP 71120']);
  for (const n of b.nouns) assert.ok(allowed.has(n.value), `unexpected noun ${n.value}`);
});

test('a restart manifest entry fills in for a mission missing its block', () => {
  const entries: PassengerManifestEntry[] = [
    { missionId: 1063978657, count: 28, type: 'Tourist', vip: false, wanted: false },
  ];
  const b = manifestBrief([mission({ passengers: undefined })], entries)!;
  assert.equal(b.tokens.paxcount, '28');
});

test('a manifest row with no matching mission is never aired', () => {
  const entries: PassengerManifestEntry[] = [
    { missionId: 999, count: 6, type: 'Tourist', vip: false, wanted: false },
  ];
  assert.equal(manifestBrief([], entries), null);
});

test('mission cargo in the hold is a load when the cabins are empty', () => {
  const b = manifestBrief([
    mission({
      category: 'Delivery',
      passengers: undefined,
      commodity: { name: 'tritium', localised: 'Tritium', count: 120 },
      cargo: { collected: 90, delivered: 20, total: 120, progress: 0.2 },
    }),
  ])!;
  assert.equal(b.tokens.cargo, 'Tritium');
  assert.equal(b.tokens.cargoqty, '70');
  assert.deepEqual(b.figures.map((f) => f.value), ['70']);
});

test('rotation shows one load at a time and cycles', () => {
  const stacked = [mission(), mission({ id: 2 })];
  const first = manifestBrief(stacked, [], 0)!;
  const second = manifestBrief(stacked, [], 1)!;
  assert.notEqual(first.subjectKey, second.subjectKey);
});

// ---------------------------------------------------------------------------
// contractRelevance — the four branches
// ---------------------------------------------------------------------------

test('docked at the origin station is relevant', () => {
  const here = { location: { system: 'HIP 71462', station: 'Foerster Orbital' }, docked: true };
  assert.equal(contractRelevance(mission(), here, NOW), true);
});

test('docked at the destination station is relevant', () => {
  assert.equal(contractRelevance(mission(), atDest, NOW), true);
});

test('standing in the destination system is relevant, even undocked', () => {
  const inSys = { location: { system: 'HIP 71120' }, docked: false };
  assert.equal(contractRelevance(mission(), inSys, NOW), true);
});

test('the closing expiry window is relevant anywhere', () => {
  const soon = mission({ expiry: new Date(NOW + 30 * 60_000).toISOString() });
  assert.equal(contractRelevance(soon, away, NOW), true);
});

test('an unrelated system with hours in hand is not relevant', () => {
  assert.equal(contractRelevance(mission(), away, NOW), false);
});

test('an already-expired contract is not aired', () => {
  const gone = mission({ expiry: new Date(NOW - 60_000).toISOString() });
  assert.equal(contractRelevance(gone, away, NOW), false);
});

test('a finished mission is never relevant, even at its destination', () => {
  assert.equal(contractRelevance(mission({ state: 'COMPLETE' }), atDest, NOW), false);
});

// ---------------------------------------------------------------------------
// contractBrief
// ---------------------------------------------------------------------------

test('a relevant contract yields employer and destination', () => {
  const b = contractBrief(mission(), atDest, NOW)!;
  assert.equal(b.kind, 'contract');
  assert.equal(b.tokens.employer, 'Explorer on Tour');
  assert.equal(b.tokens.destport, "Wood's Pride");
  assert.equal(b.tokens.destsystem, 'HIP 71120');
  assert.equal(b.subjectKey, 'contract:1063978657');
});

test('an irrelevant contract builds nothing at all', () => {
  assert.equal(contractBrief(mission(), away, NOW), null);
});

test('the reward never appears — no figures, not in the summary', () => {
  const b = contractBrief(mission({ reward: 2_436_240 }), atDest, NOW)!;
  assert.equal(b.figures.length, 0);
  assert.ok(!/2,?436,?240/.test(b.summary), 'reward leaked into the summary');
  assert.ok(!Object.values(b.tokens).some((v) => /2436240|2,436,240/.test(v)));
});

test('a target faction is licensed as material', () => {
  const b = contractBrief(
    mission({
      category: 'Massacre',
      targetFaction: "Brian's Thugs",
      destination: { system: 'HIP 71120' },
    }),
    atDest,
    NOW,
  )!;
  assert.equal(b.tokens.targetfaction, "Brian's Thugs");
  assert.ok(b.nouns.some((n) => n.value === "Brian's Thugs"));
});

test('every noun and figure on both briefs attributes to its mission id', () => {
  const m = mission();
  const c = contractBrief(m, atDest, NOW)!;
  const p = manifestBrief([m])!;
  for (const item of [...c.nouns, ...c.figures, ...p.nouns, ...p.figures]) {
    assert.deepEqual(item.source, { kind: 'mission', missionId: m.id });
  }
});

test('two contracts carry distinct subject keys, so one cooling leaves the other hot', () => {
  const a = contractBrief(mission(), atDest, NOW)!;
  const b = contractBrief(
    mission({ id: 2, destination: { system: 'HIP 71120', station: 'Ponce Estate' } }),
    atDest,
    NOW,
  )!;
  assert.notEqual(a.subjectKey, b.subjectKey);
});

test('timeleft is words, not digits', () => {
  assert.equal(timeLeftPhrase(new Date(NOW + 30 * 60_000).toISOString(), NOW), 'under an hour');
  assert.equal(timeLeftPhrase(new Date(NOW + 5.2 * 3_600_000).toISOString(), NOW), 'about five hours');
  assert.equal(timeLeftPhrase(new Date(NOW + 3 * 86_400_000).toISOString(), NOW), 'about three days');
  const b = contractBrief(mission(), atDest, NOW)!;
  assert.ok(b.tokens.timeleft && !/\d/.test(b.tokens.timeleft));
});
