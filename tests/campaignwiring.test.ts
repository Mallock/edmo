/**
 * The campaign spine, wired — journal in, storage out.
 *
 * campaign.test.ts proves the fold; these prove the store actually FEEDS it:
 * live events reach the tracker with the system's standings in context, the
 * result lands under edmo.campaign.v1, a fresh core rehydrates it, and a
 * commander change tears it down. Same harness as autoview.test.ts — the real
 * AppCore against mocked browser globals.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

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
  JSON.stringify({ timestamp: `2026-08-15T${ts}Z`, ...o });

/** Standing in a system where Sirius Corp runs things and hates the commander. */
const LOC = line('20:00:00', {
  event: 'Location',
  StarSystem: 'T',
  Docked: false,
  SystemFaction: { Name: 'Sirius Corp' },
  Factions: [{ Name: 'Sirius Corp', Influence: 0.4, MyReputation: -50 }],
});

const INT = (ts: string) =>
  line(ts, {
    event: 'Interdicted',
    Submitted: true,
    Interdictor: 'Kowalczyk',
    Faction: 'Sirius Corp',
    IsPlayer: false,
  });

interface CoreInnards {
  bootstrapped: boolean;
  onLines(lines: string[], live: boolean): void;
  campaign: { view(): { pursuer: { faction: string } | null } };
}

async function bootedCore(history: string[]) {
  const { AppCore } = await import('../src/ui/store.ts');
  const core = new AppCore();
  const c = core as unknown as CoreInnards;
  c.onLines(history, false);
  c.bootstrapped = true;
  return { core, c };
}

test('live journal events reach the fold, with standings in context', async () => {
  const { c } = await bootedCore([LOC]);
  assert.equal(c.campaign.view().pursuer, null);
  // One interdiction under hostile standing: 3 + 2 across two kinds — elected.
  c.onLines([INT('20:05:00')], true);
  assert.equal(c.campaign.view().pursuer?.faction, 'Sirius Corp');
  assert.ok(bank.has('edmo.campaign.v1'), 'the fold must persist');
});

test('a fresh core rehydrates the campaign from storage', async () => {
  const { c } = await bootedCore([LOC]);
  c.onLines([INT('20:05:00')], true);
  const { AppCore } = await import('../src/ui/store.ts');
  const revived = new AppCore() as unknown as CoreInnards;
  assert.equal(revived.campaign.view().pursuer?.faction, 'Sirius Corp');
});

test('the HUD snapshot carries the campaign only when there is one, and reset clears it', async () => {
  const { core, c } = await bootedCore([LOC]);
  const innards = core as unknown as CoreInnards & {
    buildSnapshot(): { campaign: { pursuer: { faction: string; clock: number } | null } | null };
    resetCampaign(): void;
  };
  assert.equal(innards.buildSnapshot().campaign, null);
  c.onLines([INT('20:05:00')], true);
  const snap = innards.buildSnapshot();
  assert.equal(snap.campaign?.pursuer?.faction, 'Sirius Corp');
  assert.equal(typeof snap.campaign?.pursuer?.clock, 'number');
  innards.resetCampaign();
  assert.equal(innards.buildSnapshot().campaign, null);
  assert.equal(JSON.parse(bank.get('edmo.campaign.v1')!).pursuer, null);
});

test('a commander change starts a fresh campaign', async () => {
  const { c } = await bootedCore([LOC]);
  c.onLines([line('20:01:00', { event: 'LoadGame', Commander: 'Jaenelle' })], true);
  c.onLines([INT('20:05:00')], true);
  assert.equal(c.campaign.view().pursuer?.faction, 'Sirius Corp');
  c.onLines([line('20:10:00', { event: 'LoadGame', Commander: 'Thorn' })], true);
  assert.equal(c.campaign.view().pursuer, null);
});
