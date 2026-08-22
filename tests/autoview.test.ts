/**
 * Auto view switching — the HUD follows the game so the commander's hands can
 * stay on the throttle.
 *
 * The rule under test: a live Market event while a construction build is on
 * the books switches the panel to the architect's shopping list, and a live
 * Undocked switches it to the system map. Both are guarded exactly like the
 * tabs themselves — no depot means no architect tab, a bare system means no
 * map tab, and neither should be switched to blind. And "live" is load-bearing:
 * a bootstrap replay of last night's session must not end boot staring at
 * whatever panel last night's final event implies.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The store persists what it learns (construction list, the orrery's body and
 * port tables) and rehydrates it on construction — so a shared localStorage
 * mock quietly carries one test's system map into the next test's "empty"
 * core. Cleared before each test: every core here starts genuinely blank.
 */
const bank = new Map<string, string>();
beforeEach(() => bank.clear());

/** The handful of browser globals the store touches on the way up. */
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

const line = (o: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-08-15T20:00:00Z', ...o });

/** Enough system for the orrery tab to exist: a star and one planet. */
const MAP_LINES = [
  line({ event: 'Location', StarSystem: 'T', SystemAddress: 42, BodyID: 0, Body: 'T', BodyType: 'Star', Docked: true, StationName: 'Depot Alpha' }),
  line({ event: 'Scan', SystemAddress: 42, BodyID: 0, BodyName: 'T', StarType: 'K', StellarMass: 0.8, Radius: 6e8, DistanceFromArrivalLS: 0 }),
  line({ event: 'Scan', SystemAddress: 42, BodyID: 1, BodyName: 'T 1', PlanetClass: 'Icy body', SemiMajorAxis: 1e11, DistanceFromArrivalLS: 200, Radius: 3e6 }),
];

/** A build on the books: docked at the site, requirement read from it. */
const DEPOT_LINES = [
  line({
    event: 'Docked',
    StationName: 'Orbital Construction Site: Test',
    StationType: 'SpaceConstructionDepot',
    StarSystem: 'T',
    MarketID: 99,
    StationServices: ['dock', 'commodities', 'colonisationcontribution'],
  }),
  line({
    event: 'ColonisationConstructionDepot',
    MarketID: 99,
    ConstructionProgress: 0.1,
    ConstructionComplete: false,
    ConstructionFailed: false,
    ResourcesRequired: [
      { Name: '$steel_name;', Name_Localised: 'Steel', RequiredAmount: 100, ProvidedAmount: 0, Payment: 5000 },
    ],
  }),
];

const MARKET = line({ event: 'Market', MarketID: 99, StationName: 'Orbital Construction Site: Test', StarSystem: 'T' });
const UNDOCKED = line({ event: 'Undocked', StationName: 'Orbital Construction Site: Test' });

/** A core with history already folded, standing at the moment boot ends. */
async function bootedCore(history: string[]) {
  const { AppCore } = await import('../src/ui/store.ts');
  const core = new AppCore();
  const c = core as unknown as {
    bootstrapped: boolean;
    onLines(lines: string[], live: boolean): void;
    view: string;
    settings: { hud: { autoView: boolean } };
  };
  c.onLines(history, false);
  c.bootstrapped = true;
  return { core, c };
}

test('a live Market with a build on the books opens the architect tab', async () => {
  const { c } = await bootedCore([...MAP_LINES, ...DEPOT_LINES]);
  assert.equal(c.view, 'missions', 'replayed history must not move the view');
  c.onLines([MARKET], true);
  assert.equal(c.view, 'architect');
});

test('a live Undocked brings back the system map', async () => {
  const { core, c } = await bootedCore([...MAP_LINES, ...DEPOT_LINES]);
  c.onLines([MARKET], true);
  assert.equal(c.view, 'architect');
  c.onLines([UNDOCKED], true);
  assert.equal(c.view, 'orrery');
  assert.ok(core.getSnapshot().orrery, 'switched to a tab that does not render');
});

test('no depot, no switch — the Market event alone is not a request', async () => {
  const { c } = await bootedCore(MAP_LINES);
  c.onLines([MARKET], true);
  assert.equal(c.view, 'missions');
});

test('a system too bare to draw refuses the Undocked switch', async () => {
  // Only a Location — one body, below the two the orrery tab requires.
  const { c } = await bootedCore([MAP_LINES[0], ...DEPOT_LINES]);
  c.onLines([UNDOCKED], true);
  assert.equal(c.view, 'missions');
});

test('the setting turns the whole thing off', async () => {
  const { c } = await bootedCore([...MAP_LINES, ...DEPOT_LINES]);
  c.settings.hud.autoView = false;
  c.onLines([MARKET], true);
  assert.equal(c.view, 'missions');
  c.onLines([UNDOCKED], true);
  assert.equal(c.view, 'missions');
});

test('a hyperspace target draws no leg — Body 0 must not resolve to the star', async () => {
  const { core, c } = await bootedCore(MAP_LINES);
  c.onLines([line({ event: 'SupercruiseEntry', StarSystem: 'T', SystemAddress: 42 })], true);
  // Status travels through importText (or the shell's Status.json channel),
  // never through the journal line path.
  core.importText(
    line({ event: 'Status', Flags: 16777240, Destination: { System: 999999, Body: 0, Name: 'FAR AWAY' } }),
  );
  const o = core.getSnapshot().orrery!;
  // A destination in another system reports Body 0 — which is the arrival
  // star's id here. Drawing that leg would invent a voyage to the star,
  // progress percentages and all.
  assert.equal(o.ship, null, 'no fabricated leg toward the arrival star');
  assert.equal(o.shipUnresolved, 'FAR AWAY', 'the note still says where the ship is going');
  // The same body id IN system is a real destination and keeps its leg.
  core.importText(
    line({ event: 'Status', Flags: 16777240, Destination: { System: 42, Body: 1, Name: 'T 1' } }),
  );
  const o2 = core.getSnapshot().orrery!;
  assert.ok(o2.ship, 'an in-system target still draws the leg');
});

test('replayed events never switch, even with everything else in place', async () => {
  const { c } = await bootedCore([...MAP_LINES, ...DEPOT_LINES]);
  c.onLines([MARKET], false); // not live — a bootstrap replay
  assert.equal(c.view, 'missions');
});
