/**
 * The settings screenshot for the website.
 *
 * Shows the category rail and the instrument-colour picker, because those are
 * what changed — and shows them on the AMBER default, so the page is honest
 * about what the app looks like when you first open it rather than showing a
 * setting nobody has chosen yet.
 *
 *   npx vite preview --port 4173
 *   node scripts/settings-site-shot.mjs
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 460, height: 700 }, deviceScaleFactor: 2 });
await page.goto('http://localhost:4173/');
await page.waitForTimeout(900);
await page.click('button[aria-label="Settings"]');
await page.waitForTimeout(400);
await page.locator('.settings-cat', { hasText: /^HUD$/ }).first().click();
await page.waitForTimeout(350);

const shown = await page.locator('.settings-body > section:visible h3').allTextContents();
console.log(`showing: ${shown.map((t) => t.trim().split('\n')[0]).join(', ')}`);

await page.screenshot({ path: 'site/img/hud-settings.png' });
console.log('saved site/img/hud-settings.png');
await browser.close();
