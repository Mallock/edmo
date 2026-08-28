/**
 * The cruise tab, wired — journal in, panel out.
 *
 * booze.test.ts proves the arithmetic; this proves the store actually feeds
 * it: a market read at the peak decides the holiday, a wine sale becomes a
 * delivery that survives a relog, and — the one that matters — a tab that has
 * seen nothing says so instead of claiming the party is off.
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
  JSON.stringify({ timestamp: `3312-08-26T${ts}Z`, ...o });

/** Docked at the peak, with the market open at holiday rates. */
const DOCKED = line('20:00:00', {
  event: 'Location',
  StarSystem: 'HIP 58832',
  StationName: "Rackham's Peak",
  Docked: true,
});
/** Market.json, which is where prices actually live — the journal's own
 *  `Market` line is only a pointer to this file. */
const marketJson = (sell: number): string =>
  JSON.stringify({
    timestamp: '3312-08-26T20:00:05Z',
    MarketID: 12345,
    StationName: "Rackham's Peak",
    StarSystem: 'HIP 58832',
    Items: [
      { Name: '$Wine_Name;', Name_Localised: 'Wine', BuyPrice: 0, SellPrice: sell, Stock: 0, Demand: 90000 },
    ],
  });
const sale = (ts: string, tons: number, total: number) =>
  line(ts, { event: 'MarketSell', MarketID: 12345, Type: 'wine', Type_Localised: 'Wine', Count: tons, SellPrice: total / tons, TotalSale: total });

interface Innards {
  bootstrapped: boolean;
  onLines(lines: string[], live: boolean): void;
  onSnapshotFile(name: string, text: string): void;
  boozeQuickNav(): void;
  buildSnapshot(): {
    view: string;
    plotter: { kind: string; target: string };
    booze: null | { state: string; sellPerT: number | null; tally: { runs: number; tons: number; credits: number } };
  };
}

async function bootedCore(history: string[], market?: string) {
  const { AppCore } = await import('../src/ui/store.ts');
  const core = new AppCore();
  const c = core as unknown as Innards;
  c.onLines(history, false);
  c.bootstrapped = true;
  if (market) c.onSnapshotFile('Market.json', market);
  return c;
}

test('a quiet galaxy shows no cruise tab at all', async () => {
  const c = await bootedCore([line('19:00:00', { event: 'Location', StarSystem: 'Sol', Docked: false })]);
  assert.equal(c.buildSnapshot().booze, null, 'nothing seen, nothing claimed');
});

test('the holiday is read off the price at the peak', async () => {
  const c = await bootedCore([DOCKED], marketJson(275_000));
  const v = c.buildSnapshot().booze;
  assert.ok(v);
  assert.equal(v!.state, 'holiday');
  assert.equal(v!.sellPerT, 275_000);
});

test('the ordinary rate is quiet, not a party', async () => {
  const c = await bootedCore([DOCKED], marketJson(33_000));
  assert.equal(c.buildSnapshot().booze?.state, 'quiet');
});

test('a wine sale at the peak becomes a delivery, and survives a relog', async () => {
  const c = await bootedCore([DOCKED], marketJson(275_000));
  c.onLines([sale('20:10:00', 400, 110_000_000)], true);
  const v = c.buildSnapshot().booze;
  assert.equal(v?.tally.runs, 1);
  assert.equal(v?.tally.tons, 400);
  assert.equal(v?.tally.credits, 110_000_000);

  // A fresh core reads the same persisted tally back.
  const { AppCore } = await import('../src/ui/store.ts');
  const revived = new AppCore() as unknown as Innards;
  assert.equal(revived.buildSnapshot().booze?.tally.runs, 1);
});

test('wine sold anywhere else is not a cruise delivery', async () => {
  const c = await bootedCore([
    line('19:00:00', { event: 'Location', StarSystem: 'Sol', StationName: 'Abraham Lincoln', Docked: true }),
  ]);
  c.onLines([sale('19:05:00', 100, 3_000_000)], true);
  assert.equal(c.buildSnapshot().booze, null, 'a bubble wine sale is just trade');
});

test('a replayed journal does not count the same run twice', async () => {
  // Deliveries persist, so folding them again on a bootstrap replay would
  // double the tally every launch.
  const c = await bootedCore([DOCKED], marketJson(275_000));
  c.onLines([sale('20:10:00', 400, 110_000_000)], true);
  c.onLines([sale('20:10:00', 400, 110_000_000)], false); // replay, not live
  assert.equal(c.buildSnapshot().booze?.tally.runs, 1);
});

test('booze quick nav primes the plotter for HIP 58832', async () => {
  const c = await bootedCore([DOCKED], marketJson(275_000));
  c.boozeQuickNav();
  const snap = c.buildSnapshot();
  assert.equal(snap.view, 'plotter');
  assert.equal(snap.plotter.kind, 'ship');
  assert.equal(snap.plotter.target, 'HIP 58832');
});
