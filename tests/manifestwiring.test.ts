/**
 * Manifest and contract briefs, wired — journal in, dossier out.
 *
 * chattermanifest.test.ts proves the builders; these prove the store FEEDS
 * them: accepted missions reach the brief pool, at most one contract rides a
 * briefing however many are relevant, an empty ship changes nothing, and the
 * noun-cooling window applies to names arriving through the new lines. Same
 * harness as campaignwiring.test.ts — the real AppCore against mocked browser
 * globals.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Brief } from '../src/engine/chatter/brief.ts';

const bank = new Map<string, string>();
beforeEach(() => bank.clear());

before(() => {
  const g = globalThis as Record<string, unknown>;
  g.localStorage = {
    getItem: (k: string) => (bank.has(k) ? bank.get(k)! : null),
    setItem: (k: string, v: string) => void bank.set(k, String(v)),
    removeItem: (k: string) => void bank.delete(k),
  };
  g.window = { addEventListener() {}, removeEventListener() {} };
  g.document = { addEventListener() {}, removeEventListener() {} };
  g.speechSynthesis = { getVoices: () => [], cancel() {}, speak() {} };
  g.SpeechSynthesisUtterance = class {};
  g.Audio = class {
    play() {
      return Promise.resolve();
    }
  };
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
  }
});

const line = (ts: string, o: Record<string, unknown>) =>
  JSON.stringify({ timestamp: `2026-08-30T${ts}Z`, ...o });

const NOW = Date.parse('2026-08-30T12:30:00Z');

/** Docked at Wood's Pride in HIP 71120 — the destination of every charter below. */
const ARRIVAL = [
  line('12:00:00', { event: 'Location', StarSystem: 'HIP 71120', Docked: false }),
  line('12:00:01', {
    event: 'FSSSignalDiscovered',
    SignalName: "Wood's Pride",
    IsStation: true,
  }),
  line('12:01:00', { event: 'Docked', StarSystem: 'HIP 71120', StationName: "Wood's Pride" }),
];

const charter = (id: number, count = 80) =>
  line('12:02:00', {
    event: 'MissionAccepted',
    Faction: 'Explorer on Tour',
    Name: 'Mission_PassengerBulk',
    LocalisedName: `${count} Tourists Seeking Transport`,
    DestinationSystem: 'HIP 71120',
    DestinationStation: "Wood's Pride",
    Expiry: '2026-08-31T12:00:00Z',
    Reward: 1_837_840,
    PassengerCount: count,
    PassengerVIPs: false,
    PassengerWanted: false,
    PassengerType: 'Tourist',
    MissionID: id,
  });

interface CoreInnards {
  bootstrapped: boolean;
  onLines(lines: string[], live: boolean): void;
  commsBriefs(nowMs: number): Brief[];
  commsDossier(briefs: readonly Brief[]): string;
  recentCommsAir: string[];
}

async function bootedCore(history: string[]) {
  const { AppCore } = await import('../src/ui/store.ts');
  const core = new AppCore();
  const c = core as unknown as CoreInnards;
  c.onLines(history, false);
  c.bootstrapped = true;
  return c;
}

test('an empty ship adds nothing: no manifest or contract briefs, no load lines', async () => {
  const c = await bootedCore(ARRIVAL);
  const briefs = c.commsBriefs(NOW);
  assert.ok(!briefs.some((b) => b.kind === 'manifest' || b.kind === 'contract'));
  const dossier = c.commsDossier(briefs);
  assert.doesNotMatch(dossier, /aboard right now|in the hold|the commander is working/);
});

test('an accepted charter reaches the pool and the briefing', async () => {
  const c = await bootedCore([...ARRIVAL, charter(1)]);
  const briefs = c.commsBriefs(NOW);
  assert.equal(briefs.filter((b) => b.kind === 'manifest').length, 1);
  assert.equal(briefs.filter((b) => b.kind === 'contract').length, 1);
  // The extras rotation sits one line out per call; over a few calls both the
  // load and the contract must ride at least once.
  let sawLoad = false;
  let sawContract = false;
  for (let i = 0; i < 4; i++) {
    const d = c.commsDossier(briefs);
    if (/aboard right now: 80 tourists/.test(d)) sawLoad = true;
    if (/working a passenger charter for Explorer on Tour/.test(d)) sawContract = true;
  }
  assert.ok(sawLoad, 'the load never reached a briefing');
  assert.ok(sawContract, 'the contract never reached a briefing');
});

test('eight relevant contracts still yield one contract brief and at most one line', async () => {
  const c = await bootedCore([
    ...ARRIVAL,
    ...Array.from({ length: 8 }, (_, i) => charter(i + 1, 10 + i)),
  ]);
  const briefs = c.commsBriefs(NOW);
  assert.equal(briefs.filter((b) => b.kind === 'contract').length, 1);
  const d = c.commsDossier(briefs);
  const contractLines = d.split('\n').filter((l) => /the commander is working/.test(l));
  assert.ok(contractLines.length <= 1, `contract lines: ${contractLines.length}`);
});

test('rotation takes the stacked charters in turns', async () => {
  const c = await bootedCore([
    ...ARRIVAL,
    ...Array.from({ length: 3 }, (_, i) => charter(i + 1)),
  ]);
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) {
    // commsDossier advances briefSeq, which rotates the next pick.
    const briefs = c.commsBriefs(NOW);
    c.commsDossier(briefs);
    const contract = briefs.find((b) => b.kind === 'contract');
    if (contract) seen.add(contract.subjectKey);
  }
  assert.ok(seen.size > 1, 'the same contract rode every briefing');
});

test('the noun-cooling window applies to the new lines', async () => {
  const c = await bootedCore([...ARRIVAL, charter(1)]);
  // Saturate the air with the destination's name: three of the last scenes
  // said it, so any extra naming it sits the next briefing out.
  c.recentCommsAir = [
    "Wood's Pride tower, holding.",
    "Anyone else in the queue at Wood's Pride?",
    "Wood's Pride again. Third time this shift.",
    'Quiet band otherwise.',
  ];
  const briefs = c.commsBriefs(NOW);
  for (let i = 0; i < 4; i++) {
    const d = c.commsDossier(briefs);
    assert.doesNotMatch(d, /aboard right now|the commander is working/);
  }
});
