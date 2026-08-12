/**
 * Docking refusals — remembering which doors are shut.
 *
 * From the live session. Told to buy tritium at G9H-NVZ, the commander flew
 * there and was refused:
 *
 *   22:01:14Z  DockingDenied  KBY-LHZ  Reason=RestrictedAccess
 *   22:14:09Z  DockingDenied  G9H-NVZ  Reason=RestrictedAccess
 *
 * Two failures. The reason table had no entry for RestrictedAccess, so the
 * operator spoke the raw enum aloud; and nothing recorded the refusal, so the
 * next lookup would have recommended the same locked carrier again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DockingDenials, explainDenial } from '../src/engine/docking.ts';
import { runTool, type ToolContext } from '../src/engine/tools.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const SYS = 'Eol Prou LW-L c8-127';
const ev = (o: Record<string, unknown>): JournalEvent =>
  ({ timestamp: '2026-08-07T22:14:09Z', ...o }) as unknown as JournalEvent;

const denied = (station: string, Reason = 'RestrictedAccess') =>
  ev({ event: 'DockingDenied', StationName: station, Reason });

// -------------------------------------------------------------- the wording

test('every refusal the game sends has plain words, including RestrictedAccess', () => {
  // The one that was missing — spoken as "Docking denied — RestrictedAccess".
  assert.equal(explainDenial('RestrictedAccess'), "docking is locked to the owner's squadron or friends");
  assert.equal(explainDenial('NoSpace'), 'no free pad');
  assert.equal(explainDenial('TooLarge'), 'your ship is too large for this pad class');
  // An unknown code passes through rather than becoming an empty sentence.
  assert.equal(explainDenial('SomethingNew'), 'SomethingNew');
  assert.equal(explainDenial(''), 'request denied');
});

// ------------------------------------------------------------- what is kept

test('a locked carrier is remembered', () => {
  const d = new DockingDenials();
  assert.ok(d.apply(denied('G9H-NVZ'), SYS));
  const hit = d.deniedAt('G9H-NVZ', SYS)!;
  assert.equal(hit.reason, 'RestrictedAccess');
  assert.equal(hit.system, SYS);
  assert.match(d.note('G9H-NVZ', SYS)!, /DOCKING REFUSED HERE — docking is locked/);
});

test('transient refusals are NOT remembered — they clear in a minute', () => {
  const d = new DockingDenials();
  for (const r of ['NoSpace', 'Distance', 'ActiveFighter', 'NoReason']) {
    assert.equal(d.apply(denied('SOME-STN', r), SYS), null, r);
    assert.equal(d.note('SOME-STN', SYS), null, r);
  }
  // Blacklisting a station because it was briefly full would silently delete a
  // good market from every future answer.
  assert.deepEqual(d.all(), []);
});

test('durable refusals beyond access are kept too', () => {
  const d = new DockingDenials();
  for (const r of ['TooLarge', 'Hostile', 'Offences', 'DockOffline']) {
    assert.ok(d.apply(denied(`STN-${r}`, r), SYS), r);
  }
  assert.equal(d.all().length, 4);
});

test('the station key is system-scoped — carriers move and names repeat', () => {
  const d = new DockingDenials();
  d.apply(denied('G9H-NVZ'), SYS);
  assert.ok(d.deniedAt('G9H-NVZ', SYS));
  assert.equal(d.deniedAt('G9H-NVZ', 'Colonia'), null);
  assert.equal(d.deniedAt('X7Q-8HL', SYS), null);
});

test('actually docking there clears it — an owner may open access', () => {
  const d = new DockingDenials();
  d.apply(denied('G9H-NVZ'), SYS);
  assert.ok(d.deniedAt('G9H-NVZ', SYS));
  d.apply(ev({ event: 'Docked', StationName: 'G9H-NVZ', StarSystem: SYS }), SYS);
  assert.equal(d.deniedAt('G9H-NVZ', SYS), null);
});

test('refusals survive a restart — a locked carrier is still locked tomorrow', () => {
  const d = new DockingDenials();
  d.apply(denied('G9H-NVZ'), SYS);
  d.apply(denied('KBY-LHZ'), SYS);
  const restored = new DockingDenials();
  restored.load(JSON.parse(JSON.stringify(d.toJSON())));
  assert.ok(restored.deniedAt('G9H-NVZ', SYS));
  assert.ok(restored.deniedAt('KBY-LHZ', SYS));
  restored.load('not an array' as unknown);
  assert.equal(restored.all().length, 2);
});

test('the operator is told which doors are shut', () => {
  const d = new DockingDenials();
  assert.equal(d.contextLine(), null);
  d.apply(denied('G9H-NVZ'), SYS);
  const line = d.contextLine()!;
  assert.match(line, /Docking has been REFUSED at: G9H-NVZ/);
  assert.match(line, /squadron or friends/);
  assert.match(line, /Do not send them back/);
});

// -------------------------------------------------- and in the market answer

test('a refused carrier ranks last and is flagged, not silently dropped', async () => {
  const d = new DockingDenials();
  d.apply(denied('G9H-NVZ'), SYS);
  const ctx = {
    system: SYS,
    station: null,
    dockingDenied: (s: string, sys: string) => d.note(s, sys),
    galaxyMarket: async () => [
      // The locked one is nearest and would otherwise lead the list.
      { station: 'G9H-NVZ', system: SYS, distanceLy: 0, price: 2565, stock: 9999, demand: 0, pad: '3', carrier: true },
      { station: 'IDIB', system: 'Asura', distanceLy: 23, price: 2565, stock: 10788, demand: 0, pad: '3', carrier: true },
    ],
  } as unknown as ToolContext;
  const out = await runTool(
    'find_market_in_galaxy',
    JSON.stringify({ commodity: 'Tritium', side: 'buy', near_system: SYS }),
    ctx,
  );
  const rows = out.split('\n').filter((l) => l.startsWith('- '));
  assert.match(rows[0], /IDIB/); // the one they can actually use
  assert.match(rows[1], /G9H-NVZ/);
  assert.match(rows[1], /⛔ DOCKING REFUSED HERE/);
  assert.match(rows[1], /DO NOT send them back here/);
});

test('with no refusals recorded the answer is unchanged', async () => {
  const ctx = {
    system: SYS,
    station: null,
    dockingDenied: () => null,
    galaxyMarket: async () => [
      { station: 'G9H-NVZ', system: SYS, distanceLy: 0, price: 2565, stock: 9999, demand: 0, pad: '3', carrier: true },
    ],
  } as unknown as ToolContext;
  const out = await runTool(
    'find_market_in_galaxy',
    JSON.stringify({ commodity: 'Tritium', side: 'buy', near_system: SYS }),
    ctx,
  );
  assert.match(out, /- G9H-NVZ/);
  assert.doesNotMatch(out, /REFUSED/);
});
