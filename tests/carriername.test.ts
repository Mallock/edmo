/**
 * Naming a carrier, and not confusing one system's prices for another's.
 *
 * Both bugs come from the same live session. A commander was told to buy
 * tritium at G9H-NVZ, flew to the right system, and could not find it — there
 * were fifty-eight carriers in the nav panel and the callsign sits at the END
 * of the displayed name. The journal had already recorded the answer four
 * minutes before they arrived:
 *
 *   FSSSignalDiscovered  "IVAN KING G9H-NVZ"
 *
 * They docked at X7Q-8HL ("JEBEDIAH") instead, having asked the operator for
 * the carrier's full name and been told "I don't keep track of every carrier's
 * name". It was in system intel the whole time.
 *
 * The second one is from the same conversation. Asked "in Tir?", the operator
 * answered "It's here, Commander — 54,028 credits". That price came from
 * Crevie's Salvo, a station in KINESI: the current-market tool silently fell
 * back to the last market opened anywhere and then described it as "here".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carrierDisplayName, runTool, type ToolContext } from '../src/engine/tools.ts';
import { MarketMemory } from '../src/engine/trade.ts';

// The real signal list from Eol Prou LW-L c8-127, trimmed.
const SIGNALS = [
  { name: 'F.E.A.R  SKYLINE X3Z-61M', isStation: true },
  { name: 'IVAN KING G9H-NVZ', isStation: true },
  { name: 'JEBEDIAH X7Q-8HL', isStation: true },
  { name: 'THE MYSTERY SHACK GZX-B7Z', isStation: true },
  { name: 'Nav Beacon', isStation: false },
];

// ------------------------------------------------------------ carrier names

test('a callsign resolves to the name the nav panel shows', () => {
  assert.equal(carrierDisplayName('G9H-NVZ', SIGNALS), 'IVAN KING G9H-NVZ');
  assert.equal(carrierDisplayName('X7Q-8HL', SIGNALS), 'JEBEDIAH X7Q-8HL');
  assert.equal(carrierDisplayName('g9h-nvz', SIGNALS), 'IVAN KING G9H-NVZ'); // case-insensitive
});

test('an unknown carrier stays unnamed rather than guessing a neighbour', () => {
  assert.equal(carrierDisplayName('V4M-T0T', SIGNALS), null);
  assert.equal(carrierDisplayName('G9H-NVZ', []), null);
});

test('only carrier callsigns are resolved — a station name is already its name', () => {
  // "Bolden's Enterprise" must never be matched against a signal list.
  assert.equal(carrierDisplayName("Bolden's Enterprise", SIGNALS), null);
  assert.equal(carrierDisplayName('IDIB', SIGNALS), null);
});

test('a bare callsign signal adds nothing and is not offered as a name', () => {
  assert.equal(carrierDisplayName('G9H-NVZ', [{ name: 'G9H-NVZ', isStation: true }]), null);
});

test('the market answer carries the nav-panel name for carriers in this system', async () => {
  const ctx = {
    system: 'Eol Prou LW-L c8-127',
    station: null,
    systemSignals: SIGNALS,
    galaxyMarket: async () => [
      { station: 'G9H-NVZ', system: 'Eol Prou LW-L c8-127', distanceLy: 0, price: 2565, stock: 3557, demand: 0, pad: '3', carrier: true },
      { station: 'V4M-T0T', system: 'Ogmar', distanceLy: 18, price: 2565, stock: 2775, demand: 0, pad: '3', carrier: true },
    ],
  } as unknown as ToolContext;
  const out = await runTool(
    'find_market_in_galaxy',
    JSON.stringify({ commodity: 'Tritium', side: 'buy', near_system: 'Eol Prou LW-L c8-127' }),
    ctx,
  );
  assert.match(out, /G9H-NVZ — shows in the nav panel as "IVAN KING G9H-NVZ"/);
  // A carrier in another system has no local signal, so it stays a callsign.
  assert.match(out, /- V4M-T0T \(Ogmar/);
  assert.match(out, /where a nav-panel name is given above, say THAT/);
});

// -------------------------------------------------- "here" means where I am

/** A memory holding one market, in a system the commander is not in. */
function elsewhereMemory(): MarketMemory {
  const m = new MarketMemory();
  m.record({
    marketId: 1,
    station: "Crevie's Salvo",
    system: 'Kinesi',
    at: new Date().toISOString(),
    items: [{ name: 'Tritium', buy: 0, sell: 54028, stock: 0, demand: 423 }],
  });
  return m;
}

test('a market from another system is flagged, not described as "here"', async () => {
  const ctx = {
    system: 'Tir',
    station: 'V6W-TTJ',
    markets: elsewhereMemory(),
  } as unknown as ToolContext;
  const out = await runTool('get_current_market', '{}', ctx);
  assert.match(out, /WARNING: this is NOT where the commander is/);
  assert.match(out, /docked at V6W-TTJ Tir/);
  assert.match(out, /no market data for Tir/);
  // The word that caused the wrong answer must be gone.
  assert.doesNotMatch(out, /Buy here/);
  assert.match(out, /Buy at Crevie's Salvo/);
});

test('the market where the commander actually stands still reads as "here"', async () => {
  const m = new MarketMemory();
  m.record({
    marketId: 2,
    station: "Bolden's Enterprise",
    system: 'Tir',
    at: new Date().toISOString(),
    items: [{ name: 'Tritium', buy: 54028, sell: 0, stock: 900, demand: 0 }],
  });
  const ctx = { system: 'Tir', station: "Bolden's Enterprise", markets: m } as unknown as ToolContext;
  const out = await runTool('get_current_market', '{}', ctx);
  assert.doesNotMatch(out, /WARNING/);
  assert.match(out, /Buy here: Tritium 54,028 cr/);
});

test('no market anywhere is still an honest answer', async () => {
  const ctx = { system: 'Tir', station: null, markets: new MarketMemory() } as unknown as ToolContext;
  assert.match(await runTool('get_current_market', '{}', ctx), /No market data recorded yet/);
});
