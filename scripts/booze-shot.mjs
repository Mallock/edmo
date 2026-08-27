/**
 * A screenshot of the Booze Cruise tab, for the website.
 *
 * The cruise runs about once a year, so a real capture has to wait for the
 * event. This drives the REAL built UI in a browser instead, against an
 * isolated profile — never the commander's own — so the pixels are genuine
 * even though the situation is staged. The site caption says so.
 *
 * The ship comes through the app's own manual-import path (its documented way
 * to try things with no game running), so the hold size, the run economics and
 * the trip count are computed by the real code rather than drawn.
 *
 *   node scripts/booze-shot.mjs            (needs: npx vite preview --port 4173)
 */
import { chromium } from 'playwright';

const OUT = 'site/img/hud-booze.png';
const now = Date.now();
const min = 60_000;

// Four laps at roughly 24 minutes, the most recent a few minutes ago.
const runs = [
  { at: now - 78 * min, tons: 400, credits: 110_000_000 },
  { at: now - 54 * min, tons: 400, credits: 110_000_000 },
  { at: now - 29 * min, tons: 400, credits: 110_000_000 },
  { at: now - 5 * min, tons: 400, credits: 110_000_000 },
];

// One market read at the peak (the holiday price) and one carrier selling wine.
const markets = [
  {
    marketId: 1,
    station: "Rackham's Peak",
    system: 'HIP 58832',
    at: new Date(now - 6 * min).toISOString(),
    items: [{ name: 'Wine', buy: 0, sell: 275_106, stock: 0, demand: 94_000 }],
  },
  {
    marketId: 2,
    station: 'V6W-TTJ',
    system: 'HIP 58832',
    at: new Date(now - 12 * min).toISOString(),
    items: [{ name: 'Wine', buy: 19_840, sell: 0, stock: 3_204, demand: 0 }],
  },
];

const journal = [
  JSON.stringify({
    timestamp: new Date(now - 90 * min).toISOString(),
    event: 'Loadout',
    Ship: 'type8',
    ShipName: 'Vin Ordinaire',
    ShipIdent: 'MA-22P',
    CargoCapacity: 400,
  }),
  JSON.stringify({
    timestamp: new Date(now - 89 * min).toISOString(),
    event: 'Location',
    StarSystem: 'HIP 58832',
    StationName: "Rackham's Peak",
    Docked: true,
  }),
].join('\n');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 460, height: 760 }, deviceScaleFactor: 2 });

await page.goto('http://localhost:4173/');
await page.evaluate(
  ([r, m]) => {
    localStorage.setItem('edmo.booze.v1', JSON.stringify(r));
    localStorage.setItem('edmo.markets.v1', JSON.stringify(m));
  },
  [runs, markets],
);
await page.reload();
await page.waitForTimeout(1200);

// The ship, through the app's own import path.
await page.click('button[aria-label="Settings"]');
await page.waitForTimeout(400);
await page.fill('textarea', journal);
await page.click('button:has-text("Import events")');
await page.waitForTimeout(600);
await page.click('button[aria-label="Settings"]');
await page.waitForTimeout(400);

// Onto the cruise tab.
const tab = page.locator('button[role="tab"]', { hasText: '🍷' });
if (await tab.count()) {
  await tab.first().click();
  await page.waitForTimeout(500);
} else {
  console.log('!! the cruise tab did not appear');
}

await page.screenshot({ path: OUT });
console.log('saved ' + OUT);
await browser.close();
